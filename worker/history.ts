import type { Env } from './types';
import {
  advanceBucket, bucketStart, historyMetrics, historyWindow, isHistoryPeriod, isHistoryResource, validHistoryId,
  type HistoryGap, type HistoryGrain, type HistoryMetrics, type HistoryPeriod, type HistoryPoint, type HistoryResource, type HistorySeries,
} from '../shared/history';

export { prepareHistoryMaintenance, type HistoryMaintenancePlan } from './history-archive';

type Grain = Exclude<HistoryGrain, 'baseline'>;
type RollupRow = { bucket_start: string; first_at: string; last_at: string; last_metrics_json: string; observations: number; last_sort_id: number | null };
type RawRow = { id: number; captured_at: string; data_json?: string; price?: number };
type RawBucket = { bucket_start: string; first_at: string; last_at: string; last_data: string | number; observations: number; last_sort_id: number };
type BaselineRow = { first_at: string; metrics_json: string };
type Cursor = { v: 2; resource: HistoryResource; id: string; from: string; to: string; grain: Grain; at: string; rowId?: number };
const RETENTION = { rawDays: 30, dayDays: 90, weekDays: 366, monthMonths: 24, baseline: 'lifetime' } as const;
const METHODOLOGY = 'Change-only observations. Bucket values are the last observed values, not averages. Counts include all observations in each stored bucket, which may begin before a custom from date. Empty intervals do not prove stability. Archived buckets whose last observation falls after a custom to date are omitted because their value at that boundary is unknown. Older captures deleted before rollup deployment cannot be restored.';

const parseObject = (value: unknown): Record<string, unknown> => {
  try { const parsed: unknown = JSON.parse(String(value)); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; }
  catch { return {}; }
};
const daysBefore = (now: Date, count: number) => new Date(now.getTime() - count * 86_400_000).toISOString();
const isGrain = (value: string | null): value is Grain => value === 'raw' || value === 'day' || value === 'week' || value === 'month';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function parseDate(value: string, endOfDay = false): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) value += endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
  if (!ISO.test(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value ? value : null;
}
function encodeCursor(value: Cursor): string { return btoa(encodeURIComponent(JSON.stringify(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function decodeCursor(value: string): Cursor | null {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(value)) return null;
  try {
    const decoded = JSON.parse(decodeURIComponent(atob(value.replace(/-/g, '+').replace(/_/g, '/')))) as Cursor;
    if (decoded.v !== 2 || !isHistoryResource(decoded.resource) || !validHistoryId(decoded.id)
      || !parseDate(decoded.from) || !parseDate(decoded.to) || !isGrain(decoded.grain)
      || !parseDate(decoded.at) || (decoded.rowId !== undefined && (!Number.isSafeInteger(decoded.rowId) || decoded.rowId < 1))) return null;
    return decoded;
  } catch { return null; }
}
function point(observed_at: string, first_observed_at: string, bucket_start: string, grain: HistoryGrain,
  metrics: HistoryMetrics, observations: number, source: HistoryPoint['source']): HistoryPoint {
  return { observed_at, first_observed_at, bucket_start, grain, metrics, observations, source,
    method: grain === 'raw' ? 'observed-change' : grain === 'baseline' ? 'earliest-available' : 'bucket-last' };
}
function gapsFor(points: HistoryPoint[], from: string, to: string, grain: Grain, earliest: string | null,
  archivePending: boolean, rawCutoff: string, resolutionCutoff: string): HistoryGap[] {
  const interval = grain === 'raw' ? 'day' : grain;
  const observed = new Set(points.map(p => bucketStart(p.observed_at, interval)));
  const gaps: HistoryGap[] = [];
  for (let at = bucketStart(from, interval), end = bucketStart(to, interval); at <= end; at = advanceBucket(at, interval)) {
    if (!observed.has(at)) {
      const next = advanceBucket(at, interval);
      gaps.push({ from: at < from ? from : at, to: next > to ? to : next,
        reason: earliest && next <= earliest ? 'before-first-capture' : grain === 'raw' && at < rawCutoff ? 'raw-retention'
          : grain !== 'raw' && at < resolutionCutoff ? 'resolution-retention'
          : archivePending && at < rawCutoff ? 'archive-pending' : 'no-observation' });
    }
  }
  return gaps.filter(gap => gap.from < gap.to);
}
function rawSource(resource: HistoryResource): { table: string; filter: string; value: string } {
  return resource === 'markets'
    ? { table: 'market_prices', filter: 'item_id=? AND country_id IS NULL', value: 'price' }
    : { table: 'entity_snapshots', filter: 'entity_type=? AND entity_id=?', value: 'data_json' };
}
function rawBindings(resource: HistoryResource, id: string): unknown[] { return resource === 'markets' ? [id] : [resource, id]; }
function rawMetrics(resource: HistoryResource, row: RawRow | RawBucket): HistoryMetrics {
  if ('last_data' in row) return resource === 'markets' ? { price: Number(row.last_data) } : historyMetrics(resource, parseObject(row.last_data));
  return resource === 'markets' ? { price: Number(row.price) } : historyMetrics(resource, parseObject(row.data_json));
}
function bucketExpression(grain: Exclude<Grain, 'raw'>): string {
  if (grain === 'day') return "strftime('%Y-%m-%dT00:00:00.000Z',captured_at)";
  if (grain === 'month') return "strftime('%Y-%m-01T00:00:00.000Z',captured_at)";
  return "strftime('%Y-%m-%dT00:00:00.000Z',date(captured_at,'-' || ((CAST(strftime('%w',captured_at) AS INTEGER)+6)%7) || ' days'))";
}

export type HistoryReadOptions = { from?: string; to?: string; grain?: Grain; limit?: number; cursor?: Cursor; baseUrl?: string;
  entityName?: string | null; sourceUrl?: string | null };
/** Entity-specific indexed reads. All returned points are real observations, in chronological order. */
export async function readHistorySeries(db: D1Database, resource: HistoryResource, id: string, period: HistoryPeriod,
  now = new Date(), options: HistoryReadOptions = {}): Promise<HistorySeries> {
  if (!validHistoryId(id)) throw new Error('Invalid history ID');
  const window = historyWindow(period, now);
  const from = options.from ?? window.from, to = options.to ?? window.to, grain = options.grain ?? window.grain;
  const limit = options.limit ?? 200;
  if (!parseDate(from) || !parseDate(to) || from > to || !isGrain(grain) || !Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error('Invalid history window');
  const cursor = options.cursor;
  const source = rawSource(resource), bindings = rawBindings(resource, id);
  let points: HistoryPoint[] = [];
  const rowIds: number[] = [];
  if (grain === 'raw') {
    const seek = cursor ? 'AND (captured_at>? OR (captured_at=? AND id>?))' : '';
    const args = cursor ? [...bindings, from, to, cursor.at, cursor.at, cursor.rowId] : [...bindings, from, to];
    const rows = (await db.prepare(`SELECT id,captured_at,${source.value} FROM ${source.table}
      WHERE ${source.filter} AND captured_at>=? AND captured_at<=? ${seek}
      ORDER BY captured_at,id LIMIT ?`).bind(...args, limit + 1).all<RawRow>()).results;
    for (const row of rows) {
      points.push(point(row.captured_at, row.captured_at, row.captured_at, 'raw', rawMetrics(resource, row), 1, 'raw'));
      rowIds.push(row.id);
    }
  } else {
    const firstBucket = bucketStart(from, grain);
    const bucketSeek = cursor ? 'AND bucket_start>?' : '';
    const rollups = (await db.prepare(`SELECT bucket_start,first_at,last_at,last_metrics_json,observations,last_sort_id FROM history_rollups
      WHERE resource=? AND entity_id=? AND grain=? AND bucket_start>=? ${bucketSeek}
        AND last_at>=? AND last_at<=? ORDER BY bucket_start LIMIT ?`)
      .bind(resource, id, grain, firstBucket, ...(cursor ? [cursor.at] : []), from, to, limit + 1).all<RollupRow>()).results;
    const bucket = bucketExpression(grain);
    // Group the full indexed raw window in SQLite before applying a page bound. This
    // preserves counts and the last value even when a bucket contains >200 changes.
    const raws = (await db.prepare(`WITH selected AS (
      SELECT captured_at,id,${source.value} AS value,${bucket} AS bucket_start
      FROM ${source.table} WHERE ${source.filter} AND captured_at>=? AND captured_at<=?
    ), ranked AS (
      SELECT *,ROW_NUMBER() OVER (PARTITION BY bucket_start ORDER BY captured_at DESC,id DESC) AS rn FROM selected
      WHERE bucket_start>=? ${bucketSeek}
    ) SELECT bucket_start,MIN(captured_at) AS first_at,MAX(captured_at) AS last_at,
      MAX(CASE WHEN rn=1 THEN value END) AS last_data,
      MAX(CASE WHEN rn=1 THEN id END) AS last_sort_id,COUNT(*) AS observations
      FROM ranked GROUP BY bucket_start ORDER BY bucket_start LIMIT ?`)
      .bind(...bindings, from, to, firstBucket, ...(cursor ? [cursor.at] : []), limit + 1).all<RawBucket>()).results;
    const merged = new Map<string, HistoryPoint>();
    const rollupSortIds = new Map(rollups.map(row => [row.bucket_start, row.last_sort_id]));
    for (const row of rollups) merged.set(row.bucket_start,
      point(row.last_at, row.first_at, row.bucket_start, grain, parseObject(row.last_metrics_json) as HistoryMetrics, row.observations, 'rollup'));
    for (const row of raws) {
      const previous = merged.get(row.bucket_start);
      const archivedId = rollupSortIds.get(row.bucket_start);
      const later = !previous || row.last_at > previous.observed_at
        || (row.last_at === previous.observed_at && archivedId !== null && archivedId !== undefined && row.last_sort_id > archivedId);
      merged.set(row.bucket_start, point(later ? row.last_at : previous.observed_at,
        previous && previous.first_observed_at < row.first_at ? previous.first_observed_at : row.first_at,
        row.bucket_start, grain, later ? rawMetrics(resource, row) : previous.metrics,
        row.observations + (previous?.observations ?? 0), previous ? 'mixed' : 'raw'));
    }
    points = [...merged.values()].sort((a, b) => a.bucket_start.localeCompare(b.bucket_start));
  }
  const hasMore = points.length > limit;
  if (hasMore) points = points.slice(0, limit);
  const last = points.at(-1);
  const nextCursor = hasMore && last ? encodeCursor({ v: 2, resource, id, from, to, grain,
    at: grain === 'raw' ? last.observed_at : last.bucket_start,
    ...(grain === 'raw' ? { rowId: rowIds[points.length - 1] } : {}) }) : null;
  let nextUrl: string | null = null;
  if (nextCursor && options.baseUrl) {
    const url = new URL(options.baseUrl);
    url.searchParams.set('resource', resource); url.searchParams.set('id', id); url.searchParams.set('period', period);
    url.searchParams.set('grain', grain); url.searchParams.set('from', from); url.searchParams.set('to', to);
    url.searchParams.set('limit', String(limit)); url.searchParams.set('cursor', nextCursor);
    nextUrl = url.pathname + url.search;
  }
  const baseline = await db.prepare('SELECT first_at,metrics_json FROM history_baselines WHERE resource=? AND entity_id=?')
    .bind(resource, id).first<BaselineRow>();
  const firstRaw = await db.prepare(`SELECT captured_at,${source.value} FROM ${source.table}
    WHERE ${source.filter} ORDER BY captured_at,id LIMIT 1`).bind(...bindings).first<RawRow>();
  const rawBaseline = firstRaw ? point(firstRaw.captured_at, firstRaw.captured_at, firstRaw.captured_at, 'baseline',
    rawMetrics(resource, firstRaw), 1, 'baseline') : null;
  const storedBaseline = baseline ? point(baseline.first_at, baseline.first_at, baseline.first_at, 'baseline',
    parseObject(baseline.metrics_json) as HistoryMetrics, 1, 'baseline') : null;
  const earliest = storedBaseline && (!rawBaseline || storedBaseline.observed_at <= rawBaseline.observed_at) ? storedBaseline : rawBaseline;
  const cutoff = daysBefore(now, 30);
  const pending = await db.prepare(`SELECT id FROM ${source.table} WHERE ${source.filter} AND captured_at<? LIMIT 1`)
    .bind(...bindings, cutoff).first();
  const boundaryLimited = grain === 'raw' ? false : Boolean(await db.prepare(`SELECT 1 FROM history_rollups
    WHERE resource=? AND entity_id=? AND grain=? AND bucket_start=? AND first_at<=? AND last_at>? LIMIT 1`)
    .bind(resource, id, grain, bucketStart(to, grain), to, to).first());
  const resolutionCutoff = grain === 'raw' ? cutoff : grain === 'month'
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 24, 1)).toISOString()
    : bucketStart(daysBefore(now, grain === 'day' ? 90 : 366), grain);
  const pageFrom = cursor ? (grain === 'raw' ? cursor.at : advanceBucket(cursor.at, grain)) : from;
  const pageTo = hasMore && last ? (grain === 'raw' ? last.observed_at : advanceBucket(last.bucket_start, grain)) : to;
  return { resource, id, entityName: options.entityName ?? null, sourceUrl: options.sourceUrl ?? null,
    sourceMeaning: options.sourceUrl ? 'current-entity-source' : null, period, grain, from, to, points,
    gaps: gapsFor(points, pageFrom, pageTo < to ? pageTo : to, grain, earliest?.observed_at ?? null,
      Boolean(pending), cutoff, resolutionCutoff),
    baseline: earliest, truncated: hasMore, archive_pending: Boolean(pending), boundaryLimited, methodologyVersion: '2', retention: RETENTION,
    nextCursor, nextUrl, methodology: METHODOLOGY
      + (grain === 'raw' ? ' Raw mode includes retained captures only; archived changes are available as day, week, or month summaries.' : '')
      + (resource === 'markets' ? ' Market prices are global item quotes; no national liquidity or traded volume is inferred.' : '') };
}

export async function historyRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/history') return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (request.method !== 'GET' && request.method !== 'HEAD') return Response.json({ error: 'La API pública es de solo lectura.' }, { status: 405 });
  const allowed = new Set(['resource', 'id', 'period', 'grain', 'from', 'to', 'limit', 'cursor']);
  for (const key of url.searchParams.keys()) if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1)
    return Response.json({ error: 'Parámetros de histórico inválidos.' }, { status: 400 });
  const resource = url.searchParams.get('resource'), id = url.searchParams.get('id');
  const period = url.searchParams.get('period') ?? '30d';
  const rawGrain = url.searchParams.get('grain');
  const from = url.searchParams.get('from'), to = url.searchParams.get('to');
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? 200 : /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
  const rawCursor = url.searchParams.get('cursor');
  const cursor = rawCursor === null ? undefined : decodeCursor(rawCursor);
  if (!isHistoryResource(resource) || !validHistoryId(id) || !isHistoryPeriod(period)
    || (rawGrain !== null && !isGrain(rawGrain)) || (from !== null && !parseDate(from)) || (to !== null && !parseDate(to, true))
    || !Number.isInteger(limit) || limit < 1 || limit > 200 || (rawCursor !== null && !cursor))
    return Response.json({ error: 'Parámetros de histórico inválidos.' }, { status: 400 });
  const window = historyWindow(period, new Date());
  const normalizedFrom = from === null ? window.from : parseDate(from)!;
  const normalizedTo = to === null ? window.to : parseDate(to, true)!;
  const grain = rawGrain ?? window.grain;
  if (normalizedFrom > normalizedTo || new Date(normalizedTo).getTime() - new Date(normalizedFrom).getTime() > 5 * 366 * 86_400_000
    || (cursor && (cursor.resource !== resource || cursor.id !== id || cursor.from !== normalizedFrom || cursor.to !== normalizedTo
      || cursor.grain !== grain || cursor.at < (grain === 'raw' ? normalizedFrom : bucketStart(normalizedFrom, grain))
      || cursor.at > normalizedTo || (grain === 'raw') !== (cursor.rowId !== undefined))))
    return Response.json({ error: 'Parámetros de histórico inválidos.' }, { status: 400 });
  const entityTable: Record<Exclude<HistoryResource, 'markets'>, string> = {
    players: 'players', parties: 'parties', 'military-units': 'military_units', countries: 'countries', regions: 'regions', battles: 'battles',
    companies: 'companies', elections: 'elections', governments: 'governments',
  };
  const exists = await env.DB.prepare(`SELECT id,name,source_url FROM ${resource === 'markets' ? 'market_items' : entityTable[resource]} WHERE id=?`)
    .bind(id).first<{ id: string; name: string | null; source_url: string | null }>();
  if (!exists) return Response.json({ error: 'Registro no encontrado.' }, { status: 404 });
  if (request.method === 'HEAD') return new Response(null, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  const result = await readHistorySeries(env.DB, resource, id, period, new Date(),
    { from: normalizedFrom, to: normalizedTo, grain, limit, cursor: cursor ?? undefined, baseUrl: request.url,
      entityName: exists.name, sourceUrl: exists.source_url });
  return Response.json(result);
}
