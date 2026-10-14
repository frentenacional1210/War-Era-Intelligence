import { bucketStart, historyMetrics, type HistoryMetrics } from '../shared/history';

type RawRow = { id: number; entity_type: string; entity_id: string; captured_at: string; data_json: string };
type PriceRow = { id: number; item_id: string; captured_at: string; price: number };
type Archived = { origin: 'snapshot' | 'price'; resource: string; entity_id: string; captured_at: string; sort_id: number; metrics: HistoryMetrics; periods: Record<'day' | 'week' | 'month', string> };

const parseObject = (value: unknown): Record<string, unknown> | null => {
  try { const parsed: unknown = JSON.parse(String(value)); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; }
  catch { return null; }
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

type Lease = { owner: string };

// A malformed or unknown snapshot must keep its raw source row. Paging past
// these rows lets later supported observations advance independently.
async function selectSnapshots(db: D1Database, cutoff: string, limit: number, startAt: string | null, startId: number | null) {
  const selected: RawRow[] = [];
  let rowsRead = 0;
  let rowsWritten = 0;
  let metered = true;
  let cursorAt = startAt ?? '';
  let cursorId = startId ?? 0;
  let lastScanned: RawRow | undefined;
  let reachedEnd = false;
  const pageSize = Math.max(20, limit + 1);
  if (limit === 0) return { rows: [], more: false, rowsRead, rowsWritten, metered,
    nextAt: startAt, nextId: startId, cursorChanged: false };
  for (let scanned = 0; scanned < 1000 && selected.length <= limit;) {
    const requested = Math.min(pageSize, 1000 - scanned);
    const page = await db.prepare(`SELECT id,entity_type,entity_id,captured_at,data_json FROM entity_snapshots INDEXED BY idx_snapshots_archive_due
      WHERE captured_at<? AND (captured_at,id)>(?,?)
      ORDER BY captured_at,id LIMIT ?`)
      .bind(cutoff, cursorAt, cursorId, requested).all<RawRow>();
    rowsRead += Number(page.meta.rows_read ?? 0);
    rowsWritten += Number(page.meta.rows_written ?? 0);
    metered &&= Number.isFinite(page.meta.rows_read) && Number.isFinite(page.meta.rows_written);
    scanned += page.results.length;
    for (const row of page.results) {
      const data = parseObject(row.data_json);
      if (data && Number.isFinite(Date.parse(row.captured_at)) &&
          Object.values(historyMetrics(row.entity_type, data)).some(value => value !== null)) selected.push(row);
      if (selected.length > limit) break;
    }
    lastScanned = page.results.at(-1) ?? lastScanned;
    if (selected.length > limit) break;
    if (page.results.length < requested) { reachedEnd = true; break; }
    cursorAt = lastScanned!.captured_at;
    cursorId = lastScanned!.id;
  }
  // The extra candidate has not been consumed. Resume after the final
  // selected row so another batch can archive that candidate.
  const lastConsumed = selected.length > limit ? selected[limit - 1] : undefined;
  const nextAt = lastConsumed?.captured_at ?? (reachedEnd ? null : lastScanned?.captured_at ?? startAt);
  const nextId = lastConsumed?.id ?? (reachedEnd ? null : lastScanned?.id ?? startId);
  return { rows: selected.slice(0, limit), more: selected.length > limit || !reachedEnd || startAt !== null,
    rowsRead, rowsWritten, metered, nextAt, nextId,
    cursorChanged: nextAt !== startAt || nextId !== startId };
}

/**
 * Selects at most `perSource` expired rows from each raw table. The returned
 * statements MUST be run together in one D1 batch: rollups/baselines precede
 * deletion of exactly those raw IDs. A failure rolls the entire batch back.
 * The caller should include every result's meta.rows_written in its quota meter.
 */
export async function prepareHistoryMaintenance(db: D1Database, now = new Date(), perSource = 8, lease?: Lease): Promise<HistoryMaintenancePlan> {
  if (!Number.isInteger(perSource) || perSource < 0 || perSource > 20) throw new Error('History maintenance limit must be 0–20 per source');
  const cutoff = daysBefore(now, 30);
  const cursorResult = await db.prepare("SELECT snapshot_scan_at,snapshot_scan_id FROM history_maintenance_lock WHERE id='global'")
    .all<{ snapshot_scan_at: string | null; snapshot_scan_id: number | null }>();
  const startAt = cursorResult.results[0]?.snapshot_scan_at ?? null;
  const startId = cursorResult.results[0]?.snapshot_scan_id ?? null;
  const [raw, prices] = await Promise.all([
    selectSnapshots(db, cutoff, perSource, startAt, startId),
    // The public market API reads its latest price from this raw table. Keep
    // one raw price per item even if it is older than the retention cutoff.
    db.prepare(`SELECT p.id,p.item_id,p.captured_at,p.price FROM market_prices p
      WHERE p.country_id IS NULL AND p.captured_at<? AND EXISTS (
        SELECT 1 FROM market_prices newer WHERE newer.item_id=p.item_id AND newer.country_id IS p.country_id
          AND (newer.captured_at>p.captured_at OR (newer.captured_at=p.captured_at AND newer.id>p.id))
      ) ORDER BY p.captured_at,p.id LIMIT ?`).bind(cutoff, perSource + 1).all<PriceRow>(),
  ]);
  const snapshots = raw.rows;
  const marketPrices = prices.results.slice(0, perSource);
  const rows: Archived[] = [
    ...snapshots.map(row => archived('snapshot', row.entity_type, row.entity_id, row.captured_at, row.id, historyMetrics(row.entity_type, parseObject(row.data_json)))),
    ...marketPrices.map(row => archived('price', 'markets', row.item_id, row.captured_at, row.id, { price: Number.isFinite(row.price) ? row.price : null })),
  ];
  const statements: D1PreparedStatement[] = [];
  // D1 batches are transactions. Ownership cannot change midway through the
  // batch, so use one stable condition for every archive and delete statement.
  const guard = lease ? " AND EXISTS(SELECT 1 FROM history_maintenance_lock WHERE id='global' AND owner=?)" : '';
  const guardArgs = lease ? [lease.owner] : [];
  if (rows.length) {
    const payload = JSON.stringify(rows);
    // A second maintenance invocation may have selected the same IDs. Filter
    // every rollup statement against raw rows still present in this transaction
    // so a stale plan cannot double-count observations after the first commits.
    const projection = `SELECT json_extract(j.value,'$.resource') resource,json_extract(j.value,'$.entity_id') entity_id,
      json_extract(j.value,'$.captured_at') captured_at,CAST(json_extract(j.value,'$.sort_id') AS INTEGER) sort_id,
      json_extract(j.value,'$.metrics') metrics_json,json_extract(j.value,'$.periods.%GRAIN%') bucket_start FROM json_each(?) j
      WHERE ((json_extract(j.value,'$.origin')='snapshot' AND EXISTS(
        SELECT 1 FROM entity_snapshots s WHERE s.id=CAST(json_extract(j.value,'$.sort_id') AS INTEGER)))
      OR (json_extract(j.value,'$.origin')='price' AND EXISTS(
        SELECT 1 FROM market_prices p WHERE p.id=CAST(json_extract(j.value,'$.sort_id') AS INTEGER))))${guard}`;
    statements.push(db.prepare(`WITH observations AS (${projection.replace("json_extract(j.value,'$.periods.%GRAIN%') bucket_start", "NULL bucket_start")}),
      ranked AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY resource,entity_id ORDER BY captured_at,sort_id) rn FROM observations)
      INSERT INTO history_baselines(resource,entity_id,first_at,metrics_json,first_sort_id)
      SELECT resource,entity_id,captured_at,metrics_json,sort_id FROM ranked WHERE rn=1
      ON CONFLICT(resource,entity_id) DO UPDATE SET
      first_at=CASE WHEN excluded.first_at<history_baselines.first_at THEN excluded.first_at ELSE history_baselines.first_at END,
      metrics_json=CASE WHEN excluded.first_at<history_baselines.first_at OR
        (excluded.first_at=history_baselines.first_at AND history_baselines.first_sort_id IS NOT NULL AND excluded.first_sort_id<history_baselines.first_sort_id)
        THEN excluded.metrics_json ELSE history_baselines.metrics_json END,
      first_sort_id=CASE WHEN excluded.first_at<history_baselines.first_at OR
        (excluded.first_at=history_baselines.first_at AND history_baselines.first_sort_id IS NOT NULL AND excluded.first_sort_id<history_baselines.first_sort_id)
        THEN excluded.first_sort_id ELSE history_baselines.first_sort_id END`).bind(payload, ...guardArgs));
    for (const grain of ['day', 'week', 'month'] as const) {
      statements.push(db.prepare(`WITH observations AS (${projection.replace('%GRAIN%', grain)}),
        ranked AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY resource,entity_id,bucket_start ORDER BY captured_at,sort_id) first_rank,
          ROW_NUMBER() OVER(PARTITION BY resource,entity_id,bucket_start ORDER BY captured_at DESC,sort_id DESC) last_rank
          FROM observations),
        summary AS (SELECT resource,entity_id,bucket_start,MIN(captured_at) first_at,MAX(captured_at) last_at,
          MAX(CASE WHEN first_rank=1 THEN metrics_json END) first_metrics_json,
          MAX(CASE WHEN first_rank=1 THEN sort_id END) first_sort_id,
          MAX(CASE WHEN last_rank=1 THEN metrics_json END) last_metrics_json,
          MAX(CASE WHEN last_rank=1 THEN sort_id END) last_sort_id,COUNT(*) observations
          FROM ranked GROUP BY resource,entity_id,bucket_start)
        INSERT INTO history_rollups(resource,entity_id,grain,bucket_start,first_at,last_at,first_metrics_json,last_metrics_json,observations,first_sort_id,last_sort_id)
        SELECT resource,entity_id,'${grain}',bucket_start,first_at,last_at,first_metrics_json,last_metrics_json,observations,first_sort_id,last_sort_id FROM summary WHERE 1
        ON CONFLICT(resource,entity_id,grain,bucket_start) DO UPDATE SET
          first_metrics_json=CASE WHEN excluded.first_at<history_rollups.first_at OR
            (excluded.first_at=history_rollups.first_at AND history_rollups.first_sort_id IS NOT NULL AND excluded.first_sort_id<history_rollups.first_sort_id)
            THEN excluded.first_metrics_json ELSE history_rollups.first_metrics_json END,
          first_sort_id=CASE WHEN excluded.first_at<history_rollups.first_at OR
            (excluded.first_at=history_rollups.first_at AND history_rollups.first_sort_id IS NOT NULL AND excluded.first_sort_id<history_rollups.first_sort_id)
            THEN excluded.first_sort_id ELSE history_rollups.first_sort_id END,
          first_at=MIN(history_rollups.first_at,excluded.first_at),
          last_metrics_json=CASE WHEN excluded.last_at>history_rollups.last_at OR
            (excluded.last_at=history_rollups.last_at AND history_rollups.last_sort_id IS NOT NULL AND excluded.last_sort_id>history_rollups.last_sort_id)
            THEN excluded.last_metrics_json ELSE history_rollups.last_metrics_json END,
          last_sort_id=CASE WHEN excluded.last_at>history_rollups.last_at OR
            (excluded.last_at=history_rollups.last_at AND history_rollups.last_sort_id IS NOT NULL AND excluded.last_sort_id>history_rollups.last_sort_id)
            THEN excluded.last_sort_id ELSE history_rollups.last_sort_id END,
          last_at=MAX(history_rollups.last_at,excluded.last_at),
          observations=history_rollups.observations+excluded.observations`).bind(payload, ...guardArgs));
    }
    if (snapshots.length) statements.push(db.prepare(`DELETE FROM entity_snapshots WHERE id IN (${snapshots.map(() => '?').join(',')})${guard}`).bind(...snapshots.map(row => row.id), ...guardArgs));
    if (marketPrices.length) statements.push(db.prepare(`DELETE FROM market_prices WHERE id IN (${marketPrices.map(() => '?').join(',')})${guard}`).bind(...marketPrices.map(row => row.id), ...guardArgs));
  }
  if (raw.cursorChanged) statements.push(db.prepare(`UPDATE history_maintenance_lock
    SET snapshot_scan_at=?,snapshot_scan_id=? WHERE id='global' AND ${lease ? 'owner=?' : 'owner IS NULL'}`)
    .bind(raw.nextAt, raw.nextId, ...(lease ? [lease.owner] : [])));
  // Tiered retention: daily 90 days, weekly 1 year, monthly at least 24 months.
  // Baselines are intentionally retained for the lifetime of the entity.
  const monthCutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 24, 1)).toISOString();
  for (const [grain, expiry] of [['day', daysBefore(now, 90)], ['week', daysBefore(now, 366)], ['month', monthCutoff]] as const) {
    const completeBefore = bucketStart(expiry, grain);
    statements.push(db.prepare(`DELETE FROM history_rollups WHERE rowid IN (
      SELECT rowid FROM history_rollups WHERE grain=? AND bucket_start<? ORDER BY bucket_start LIMIT 5
    )${guard}`).bind(grain, completeBefore, ...guardArgs));
  }
  // D1 indexes and updates can cost multiple row writes. The caller refunds
  // this conservative reservation using actual D1 meta.rows_written.
  return { statements, selectedSnapshots: snapshots.length, selectedPrices: marketPrices.length,
    moreExpiredSnapshots: raw.more, moreExpiredPrices: prices.results.length > perSource,
    selectionRowsRead: Number(cursorResult.meta.rows_read ?? 0) + raw.rowsRead + Number(prices.meta.rows_read ?? 0),
    selectionRowsWritten: Number(cursorResult.meta.rows_written ?? 0) + raw.rowsWritten + Number(prices.meta.rows_written ?? 0),
    selectionMetered: Number.isFinite(cursorResult.meta.rows_read) && Number.isFinite(cursorResult.meta.rows_written) &&
      raw.metered && Number.isFinite(prices.meta.rows_read) && Number.isFinite(prices.meta.rows_written),
    reserveWrites: 50 + rows.length * 16 };
}
