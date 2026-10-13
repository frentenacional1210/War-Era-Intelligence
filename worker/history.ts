import type { Env } from './types';
import {
  advanceBucket, bucketStart, historyMetrics, historyWindow, isHistoryPeriod, isHistoryResource, validHistoryId,
  type HistoryGap, type HistoryGrain, type HistoryMetrics, type HistoryPeriod, type HistoryPoint, type HistoryResource, type HistorySeries,
} from '../shared/history';

type RawRow = { id: number; entity_type: string; entity_id: string; captured_at: string; data_json: string };
type PriceRow = { id: number; item_id: string; captured_at: string; price: number };
type RollupRow = { bucket_start: string; first_at: string; last_at: string; last_metrics_json: string; observations: number };
type BaselineRow = { first_at: string; metrics_json: string };
type Archived = { origin: 'snapshot' | 'price'; resource: string; entity_id: string; captured_at: string; sort_id: number; metrics: HistoryMetrics; periods: Record<'day' | 'week' | 'month', string> };

const parseObject = (value: unknown): Record<string, unknown> => {
  try { const parsed: unknown = JSON.parse(String(value)); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; }
  catch { return {}; }
};
const daysBefore = (now: Date, count: number) => new Date(now.getTime() - count * 86_400_000).toISOString();
const archived = (origin: Archived['origin'], resource: string, entity_id: string, captured_at: string, sort_id: number, metrics: HistoryMetrics): Archived => ({
  origin, resource, entity_id, captured_at, sort_id, metrics,
  periods: { day: bucketStart(captured_at, 'day'), week: bucketStart(captured_at, 'week'), month: bucketStart(captured_at, 'month') },
});

export type HistoryMaintenancePlan = {
  statements: D1PreparedStatement[];
  selectedSnapshots: number;
  selectedPrices: number;
  moreExpiredSnapshots: boolean;
  moreExpiredPrices: boolean;
  selectionRowsRead: number;
  selectionRowsWritten: number;
  selectionMetered: boolean;
  /** Reserve this many additional D1 writes before running the plan. Measured metadata can refund the excess. */
  reserveWrites: number;
};

/**
 * Selects at most `perSource` expired rows from each raw table. The returned
 * statements MUST be run together in one D1 batch: rollups/baselines precede
 * deletion of exactly those raw IDs. A failure rolls the entire batch back.
 * The caller should include every result's meta.rows_written in its quota meter.
 */
export async function prepareHistoryMaintenance(db: D1Database, now = new Date(), perSource = 8): Promise<HistoryMaintenancePlan> {
  if (!Number.isInteger(perSource) || perSource < 0 || perSource > 20) throw new Error('History maintenance limit must be 0–20 per source');
  const cutoff = daysBefore(now, 30);
  const [raw, prices] = await Promise.all([
    db.prepare('SELECT id,entity_type,entity_id,captured_at,data_json FROM entity_snapshots WHERE captured_at<? ORDER BY captured_at,id LIMIT ?').bind(cutoff, perSource + 1).all<RawRow>(),
    // The public market API reads its latest price from this raw table. Keep
    // one raw price per item even if it is older than the retention cutoff.
    db.prepare(`SELECT p.id,p.item_id,p.captured_at,p.price FROM market_prices p
      WHERE p.country_id IS NULL AND p.captured_at<? AND EXISTS (
        SELECT 1 FROM market_prices newer WHERE newer.item_id=p.item_id AND newer.country_id IS p.country_id
          AND (newer.captured_at>p.captured_at OR (newer.captured_at=p.captured_at AND newer.id>p.id))
      ) ORDER BY p.captured_at,p.id LIMIT ?`).bind(cutoff, perSource + 1).all<PriceRow>(),
  ]);
  const snapshots = raw.results.slice(0, perSource);
  const marketPrices = prices.results.slice(0, perSource);
  const rows: Archived[] = [
    ...snapshots.map(row => archived('snapshot', row.entity_type, row.entity_id, row.captured_at, row.id, historyMetrics(row.entity_type, parseObject(row.data_json)))),
    ...marketPrices.map(row => archived('price', 'markets', row.item_id, row.captured_at, row.id, { price: Number.isFinite(row.price) ? row.price : null })),
  ];
  const statements: D1PreparedStatement[] = [];
  if (rows.length) {
    const payload = JSON.stringify(rows);
    // A second maintenance invocation may have selected the same IDs. Filter
    // every rollup statement against raw rows still present in this transaction
    // so a stale plan cannot double-count observations after the first commits.
    const projection = `SELECT json_extract(j.value,'$.resource') resource,json_extract(j.value,'$.entity_id') entity_id,
      json_extract(j.value,'$.captured_at') captured_at,CAST(json_extract(j.value,'$.sort_id') AS INTEGER) sort_id,
      json_extract(j.value,'$.metrics') metrics_json,json_extract(j.value,'$.periods.%GRAIN%') bucket_start FROM json_each(?) j
      WHERE (json_extract(j.value,'$.origin')='snapshot' AND EXISTS(
        SELECT 1 FROM entity_snapshots s WHERE s.id=CAST(json_extract(j.value,'$.sort_id') AS INTEGER)))
      OR (json_extract(j.value,'$.origin')='price' AND EXISTS(
        SELECT 1 FROM market_prices p WHERE p.id=CAST(json_extract(j.value,'$.sort_id') AS INTEGER)))`;
    statements.push(db.prepare(`WITH observations AS (${projection.replace("json_extract(j.value,'$.periods.%GRAIN%') bucket_start", "NULL bucket_start")}),
      ranked AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY resource,entity_id ORDER BY captured_at,sort_id) rn FROM observations)
      INSERT INTO history_baselines(resource,entity_id,first_at,metrics_json)
      SELECT resource,entity_id,captured_at,metrics_json FROM ranked WHERE rn=1
      ON CONFLICT(resource,entity_id) DO UPDATE SET
      first_at=CASE WHEN excluded.first_at<history_baselines.first_at THEN excluded.first_at ELSE history_baselines.first_at END,
      metrics_json=CASE WHEN excluded.first_at<history_baselines.first_at THEN excluded.metrics_json ELSE history_baselines.metrics_json END`).bind(payload));
    for (const grain of ['day', 'week', 'month'] as const) {
      statements.push(db.prepare(`WITH observations AS (${projection.replace('%GRAIN%', grain)}),
        ranked AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY resource,entity_id,bucket_start ORDER BY captured_at,sort_id) first_rank,
          ROW_NUMBER() OVER(PARTITION BY resource,entity_id,bucket_start ORDER BY captured_at DESC,sort_id DESC) last_rank
          FROM observations),
        summary AS (SELECT resource,entity_id,bucket_start,MIN(captured_at) first_at,MAX(captured_at) last_at,
          MAX(CASE WHEN first_rank=1 THEN metrics_json END) first_metrics_json,
          MAX(CASE WHEN last_rank=1 THEN metrics_json END) last_metrics_json,COUNT(*) observations
          FROM ranked GROUP BY resource,entity_id,bucket_start)
        INSERT INTO history_rollups(resource,entity_id,grain,bucket_start,first_at,last_at,first_metrics_json,last_metrics_json,observations)
        SELECT resource,entity_id,'${grain}',bucket_start,first_at,last_at,first_metrics_json,last_metrics_json,observations FROM summary WHERE 1
        ON CONFLICT(resource,entity_id,grain,bucket_start) DO UPDATE SET
          first_metrics_json=CASE WHEN excluded.first_at<history_rollups.first_at THEN excluded.first_metrics_json ELSE history_rollups.first_metrics_json END,
          first_at=MIN(history_rollups.first_at,excluded.first_at),
          last_metrics_json=CASE WHEN excluded.last_at>history_rollups.last_at THEN excluded.last_metrics_json ELSE history_rollups.last_metrics_json END,
          last_at=MAX(history_rollups.last_at,excluded.last_at),
          observations=history_rollups.observations+excluded.observations`).bind(payload));
    }
    if (snapshots.length) statements.push(db.prepare(`DELETE FROM entity_snapshots WHERE id IN (${snapshots.map(() => '?').join(',')})`).bind(...snapshots.map(row => row.id)));
    if (marketPrices.length) statements.push(db.prepare(`DELETE FROM market_prices WHERE id IN (${marketPrices.map(() => '?').join(',')})`).bind(...marketPrices.map(row => row.id)));
  }
  // Tiered retention: daily 90 days, weekly 1 year, monthly at least 24 months.
  // Baselines are intentionally retained for the lifetime of the entity.
  const monthCutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 24, 1)).toISOString();
  for (const [grain, expiry] of [['day', daysBefore(now, 90)], ['week', daysBefore(now, 366)], ['month', monthCutoff]] as const) {
    statements.push(db.prepare(`DELETE FROM history_rollups WHERE rowid IN (
      SELECT rowid FROM history_rollups WHERE grain=? AND bucket_start<? ORDER BY bucket_start LIMIT 5
    )`).bind(grain, expiry));
  }
  // D1 indexes and updates can cost multiple row writes. The caller refunds
  // this conservative reservation using actual D1 meta.rows_written.
  return { statements, selectedSnapshots: snapshots.length, selectedPrices: marketPrices.length,
    moreExpiredSnapshots: raw.results.length > perSource, moreExpiredPrices: prices.results.length > perSource,
    selectionRowsRead: Number(raw.meta.rows_read ?? 0) + Number(prices.meta.rows_read ?? 0),
    selectionRowsWritten: Number(raw.meta.rows_written ?? 0) + Number(prices.meta.rows_written ?? 0),
    selectionMetered: [raw, prices].every(result => Number.isFinite(result.meta.rows_read) && Number.isFinite(result.meta.rows_written)),
    reserveWrites: 50 + rows.length * 16 };
}

function point(observed_at: string, bucket_start: string, grain: HistoryGrain, metrics: HistoryMetrics, observations: number): HistoryPoint {
  return { observed_at, bucket_start, grain, metrics, observations,
    method: grain === 'raw' ? 'observed-change' : grain === 'baseline' ? 'earliest-available' : 'bucket-last' };
}

function gapsFor(points: HistoryPoint[], from: string, to: string, grain: 'raw' | 'day' | 'week' | 'month', earliest: string | null, truncated: boolean, archivePending: boolean, rawCutoff: string): HistoryGap[] {
  const interval = grain === 'raw' ? 'day' : grain;
  const first = truncated && points.length ? bucketStart(points[0].observed_at, interval) : bucketStart(from, interval);
  const observed = new Set(points.map(p => bucketStart(p.observed_at, interval)));
  const gaps: HistoryGap[] = [];
  for (let at = first, end = bucketStart(to, interval); at <= end; at = advanceBucket(at, interval)) {
    if (!observed.has(at)) gaps.push({ from: at, to: advanceBucket(at, interval),
      reason: earliest && advanceBucket(at, interval) <= earliest ? 'before-first-capture' : archivePending && at < rawCutoff ? 'archive-pending' : 'no-observation' });
  }
  return gaps;
}

/** Indexed, entity-specific reads. Returns observed changes only; gaps are never interpolated. */
export async function readHistorySeries(db: D1Database, resource: HistoryResource, id: string, period: HistoryPeriod, now = new Date()): Promise<HistorySeries> {
  if (!validHistoryId(id)) throw new Error('Invalid history ID');
  const { from, to, grain } = historyWindow(period, now);
  // A market item's latest raw quote is retained even when unchanged for over
  // 30 days, so include it when it falls within the requested window.
  const rawFrom = resource === 'markets' || from > daysBefore(now, 30) ? from : daysBefore(now, 30);
  const table = resource === 'markets' ? 'market_prices' : 'entity_snapshots';
  const key = resource === 'markets' ? 'item_id' : 'entity_id';
  const resourceClause = resource === 'markets' ? 'AND country_id IS NULL' : 'AND entity_type=?';
  const bindings = resource === 'markets' ? [id] : [id, resource];
  const rawRows = (await db.prepare(`SELECT captured_at,${resource === 'markets' ? 'price' : 'data_json'} FROM ${table}
    WHERE ${key}=? ${resourceClause} AND captured_at>=? AND captured_at<=? ORDER BY captured_at DESC,id DESC LIMIT 201`)
    .bind(...bindings, rawFrom, to).all<Record<string, unknown>>()).results;
  const rawTruncated = rawRows.length > 200;
  const recent = rawRows.slice(0, 200).reverse().map(row => {
    const observed = String(row.captured_at);
    const metrics = resource === 'markets' ? { price: Number(row.price) } : historyMetrics(resource, parseObject(row.data_json));
    return point(observed, grain === 'raw' ? observed : bucketStart(observed, grain), 'raw', metrics, 1);
  });
  const rollups = grain === 'raw' ? [] : (await db.prepare(`SELECT bucket_start,first_at,last_at,last_metrics_json,observations FROM history_rollups
    WHERE resource=? AND entity_id=? AND grain=? AND bucket_start>=? AND bucket_start<=?
    ORDER BY bucket_start DESC LIMIT 201`).bind(resource, id, grain, bucketStart(from, grain), bucketStart(to, grain)).all<RollupRow>()).results;
  const baseline = await db.prepare('SELECT first_at,metrics_json FROM history_baselines WHERE resource=? AND entity_id=?').bind(resource, id).first<BaselineRow>();
  const firstRaw = await db.prepare(`SELECT captured_at,${resource === 'markets' ? 'price' : 'data_json'} FROM ${table}
    WHERE ${key}=? ${resourceClause} ORDER BY captured_at,id LIMIT 1`).bind(...bindings).first<Record<string, unknown>>();
  const pending = resource === 'markets'
    ? await db.prepare(`SELECT p.id FROM market_prices p WHERE p.item_id=? AND p.country_id IS NULL AND p.captured_at<?
        AND EXISTS(SELECT 1 FROM market_prices newer WHERE newer.item_id=p.item_id AND newer.country_id IS p.country_id
          AND (newer.captured_at>p.captured_at OR (newer.captured_at=p.captured_at AND newer.id>p.id))) LIMIT 1`)
        .bind(id, daysBefore(now, 30)).first()
    : await db.prepare(`SELECT id FROM ${table} WHERE ${key}=? ${resourceClause} AND captured_at<? LIMIT 1`)
        .bind(...bindings, daysBefore(now, 30)).first();
  const rawBaseline = firstRaw ? point(String(firstRaw.captured_at), String(firstRaw.captured_at), 'baseline',
    resource === 'markets' ? { price: Number(firstRaw.price) } : historyMetrics(resource, parseObject(firstRaw.data_json)), 1) : null;
  const storedBaseline = baseline ? point(baseline.first_at, baseline.first_at, 'baseline', parseObject(baseline.metrics_json) as HistoryMetrics, 1) : null;
  const earliest = storedBaseline && (!rawBaseline || storedBaseline.observed_at <= rawBaseline.observed_at) ? storedBaseline : rawBaseline;
  let points: HistoryPoint[];
  if (grain === 'raw') points = recent;
  else {
    const buckets = new Map<string, HistoryPoint>();
    for (const row of rollups) {
      if (row.last_at < from || row.first_at > to) continue;
      buckets.set(row.bucket_start, point(row.last_at, row.bucket_start, grain, parseObject(row.last_metrics_json) as HistoryMetrics, row.observations));
    }
    for (const capture of recent) {
      const previous = buckets.get(capture.bucket_start);
      if (!previous || capture.observed_at >= previous.observed_at) buckets.set(capture.bucket_start, {
        ...point(capture.observed_at, capture.bucket_start, grain, capture.metrics, (previous?.observations ?? 0) + 1),
      });
      else previous.observations += 1;
    }
    points = [...buckets.values()].sort((a, b) => a.bucket_start.localeCompare(b.bucket_start));
  }
  const truncated = rawTruncated || rollups.length > 200 || points.length > 200;
  if (points.length > 200) points = points.slice(-200);
  return { resource, id, period, grain, from, to, points,
    gaps: gapsFor(points, from, to, grain, earliest?.observed_at ?? null, truncated, Boolean(pending), daysBefore(now, 30)), baseline: earliest,
    truncated, archive_pending: Boolean(pending),
    methodology: 'Change-only observations. Bucket values are the last observed values, not averages; an empty period does not prove a stable value. Archive-pending gaps may contain raw captures awaiting rollup. Older captures already deleted before rollup deployment cannot be restored.'
      + (resource === 'markets' ? ' Market values are global item prices; no national liquidity or traded volume is inferred.' : '') };
}

export async function historyRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/history') return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return Response.json({ error: 'La API pública es de solo lectura.' }, { status: 405 });
  const resource = url.searchParams.get('resource');
  const id = url.searchParams.get('id');
  const period = url.searchParams.get('period') ?? '30d';
  if (!isHistoryResource(resource) || !validHistoryId(id) || !isHistoryPeriod(period)) return Response.json({ error: 'Parámetros de histórico inválidos.' }, { status: 400 });
  const entityTable: Record<Exclude<HistoryResource, 'markets'>, string> = {
    players: 'players', parties: 'parties', 'military-units': 'military_units', countries: 'countries', regions: 'regions', battles: 'battles',
    companies: 'companies', elections: 'elections', governments: 'governments',
  };
  const exists = await env.DB.prepare(`SELECT id FROM ${resource === 'markets' ? 'market_items' : entityTable[resource]} WHERE id=?`).bind(id).first();
  if (!exists) return Response.json({ error: 'Registro no encontrado.' }, { status: 404 });
  return Response.json(await readHistorySeries(env.DB, resource, id, period));
}
