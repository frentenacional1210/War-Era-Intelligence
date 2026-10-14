import type { Env } from './types';
import { prepareHistoryMaintenance } from './history-archive';

export const HISTORY_MAINTENANCE_LIMITS = {
  writesPerDay: 15_000,
  readsPerDay: 1_000_000,
  combinedWritesPerDay: 95_000,
  maxRowsPerSource: 20,
  reservedWritesPerRun: 720,
  reservedReadsPerRun: 10_000,
} as const;

export type HistoryMaintenanceResult = {
  status: 'ok' | 'busy' | 'quota-paused' | 'error';
  archivedSnapshots: number;
  archivedPrices: number;
  moreExpiredSnapshots?: boolean;
  moreExpiredPrices?: boolean;
  pendingSnapshotsAtLeast?: number;
  pendingPricesAtLeast?: number;
  pendingCountCapped?: boolean;
  rowsWritten?: number;
  rowsRead?: number;
  error?: string;
};

const rowWrites = (results: D1Result[]) => results.reduce((sum, result) => sum + Number(result.meta.rows_written ?? 0), 0);
const rowReads = (results: D1Result[]) => results.reduce((sum, result) => sum + Number(result.meta.rows_read ?? 0), 0);
const metered = (results: D1Result[]) => results.every(result => Number.isFinite(result.meta.rows_written) && Number.isFinite(result.meta.rows_read));
const plusMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000).toISOString();

/**
 * Run as its own Worker invocation, separate from ingestion. The daily reserve
 * is taken before reading candidate rows. Archive inserts and exact-ID deletes
 * share one D1 transaction; failed settlement keeps the larger reservation.
 */
export async function runHistoryMaintenance(env: Env, options: { now?: Date; perSource?: number } = {}): Promise<HistoryMaintenanceResult> {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.valueOf())) throw new Error('Invalid maintenance date');
  const perSource = options.perSource ?? HISTORY_MAINTENANCE_LIMITS.maxRowsPerSource;
  if (!Number.isInteger(perSource) || perSource < 0 || perSource > HISTORY_MAINTENANCE_LIMITS.maxRowsPerSource) throw new Error('Invalid history maintenance batch size');
  const day = now.toISOString().slice(0, 10);
  const owner = crypto.randomUUID();
  const leaseUntil = plusMinutes(now, 5);
  const reservedWrites = HISTORY_MAINTENANCE_LIMITS.reservedWritesPerRun;
  const reservedReads = HISTORY_MAINTENANCE_LIMITS.reservedReadsPerRun;
  let ownLease = false;
  let reservationTaken = false;
  try {
    const claim = await env.DB.prepare(`UPDATE history_maintenance_lock SET owner=?,lease_until=? WHERE id='global'
      AND (lease_until IS NULL OR lease_until<=?)`).bind(owner, leaseUntil, now.toISOString()).run();
    if (!claim.meta.changes) return { status: 'busy', archivedSnapshots: 0, archivedPrices: 0 };
    ownLease = true;
    const reserve = await env.DB.prepare(`INSERT INTO history_maintenance_budget
      (day_key,reserved_writes,reserved_reads,tick_count,updated_at,last_status,last_error)
      SELECT ?,?,?,1,?,'running',NULL WHERE
        COALESCE((SELECT reserved_writes FROM ingestion_budget WHERE day_key=?),0)+?<=?
      ON CONFLICT(day_key) DO UPDATE SET
        reserved_writes=history_maintenance_budget.reserved_writes+excluded.reserved_writes,
        reserved_reads=history_maintenance_budget.reserved_reads+excluded.reserved_reads,
        tick_count=history_maintenance_budget.tick_count+1,updated_at=excluded.updated_at,
        last_status='running',last_error=NULL
      WHERE history_maintenance_budget.reserved_writes+excluded.reserved_writes<=?
        AND history_maintenance_budget.reserved_reads+excluded.reserved_reads<=?
        AND history_maintenance_budget.reserved_writes+excluded.reserved_writes+
          COALESCE((SELECT reserved_writes FROM ingestion_budget WHERE day_key=?),0)<=?`)
      .bind(day, reservedWrites, reservedReads, now.toISOString(), day, reservedWrites,
        HISTORY_MAINTENANCE_LIMITS.combinedWritesPerDay,
        HISTORY_MAINTENANCE_LIMITS.writesPerDay,
        HISTORY_MAINTENANCE_LIMITS.readsPerDay,
        day, HISTORY_MAINTENANCE_LIMITS.combinedWritesPerDay).run();
    if (!reserve.meta.changes) return { status: 'quota-paused', archivedSnapshots: 0, archivedPrices: 0 };
    reservationTaken = true;
    const plan = await prepareHistoryMaintenance(env.DB, now, perSource, { owner });
    // 50 + (20+20)*16 is the plan's maximum; the remaining margin covers
    // the lock, reserve, completion and settlement writes.
    if (plan.reserveWrites + 30 > reservedWrites) throw new Error('History maintenance reservation is too small');
    const completed = await env.DB.batch([
      ...plan.statements,
      env.DB.prepare(`UPDATE history_maintenance_budget SET
        archived_snapshots=archived_snapshots+?,archived_prices=archived_prices+?,
        last_status='ok',last_error=NULL,updated_at=? WHERE day_key=?
        AND EXISTS(SELECT 1 FROM history_maintenance_lock WHERE id='global' AND owner=?)`)
        .bind(plan.selectedSnapshots, plan.selectedPrices, now.toISOString(), day, owner),
      env.DB.prepare("UPDATE history_maintenance_lock SET owner=NULL,lease_until=NULL WHERE id='global' AND owner=?").bind(owner),
    ]);
    ownLease = false;
    // A lost lease cannot advance status. The archive itself is idempotent and
    // exact-ID deletion is safe; keep the reservation if ownership was lost.
    if (!completed[completed.length - 2].meta.changes) throw new Error('History maintenance lease expired before completion');
    const results = [claim, reserve, ...completed];
    let pendingSnapshotsAtLeast: number | undefined;
    let pendingPricesAtLeast: number | undefined;
    try {
      // LIMIT 1001 gives an exact count up to 1000 and a lower bound above it.
      // The time-leading indexes prevent a full table scan for expired rows.
      const cutoff = new Date(now.getTime() - 30 * 86_400_000).toISOString();
      const [snapshotProbe, priceProbe] = await Promise.all([
        env.DB.prepare(`SELECT COUNT(*) pending FROM (
          SELECT id FROM entity_snapshots WHERE captured_at<? ORDER BY captured_at,id LIMIT 1001
        )`).bind(cutoff).all<{ pending: number }>(),
        env.DB.prepare(`SELECT COUNT(*) pending FROM (
          SELECT p.id FROM market_prices p WHERE p.country_id IS NULL AND p.captured_at<? AND EXISTS (
            SELECT 1 FROM market_prices newer WHERE newer.item_id=p.item_id AND newer.country_id IS p.country_id
              AND (newer.captured_at>p.captured_at OR (newer.captured_at=p.captured_at AND newer.id>p.id))
          ) ORDER BY p.captured_at,p.id LIMIT 1001
        )`).bind(cutoff).all<{ pending: number }>(),
      ]);
      pendingSnapshotsAtLeast = Number(snapshotProbe.results[0]?.pending ?? 0);
      pendingPricesAtLeast = Number(priceProbe.results[0]?.pending ?? 0);
      results.push(snapshotProbe, priceProbe);
    } catch {
      // A failed diagnostic cannot undo a successful archive transaction.
    }
    const rowsWritten = rowWrites(results) + plan.selectionRowsWritten;
    const rowsRead = rowReads(results) + plan.selectionRowsRead;
    const hasMetrics = metered(results) && plan.selectionMetered;
    const writeCharge = hasMetrics ? rowsWritten + 8 : reservedWrites;
    const readCharge = hasMetrics ? rowsRead + 100 : reservedReads;
    try {
      await env.DB.prepare(`UPDATE history_maintenance_budget SET
        reserved_writes=MAX(0,reserved_writes-?+?),reserved_reads=MAX(0,reserved_reads-?+?),
        measured_writes=measured_writes+?,measured_reads=measured_reads+?,updated_at=? WHERE day_key=?`)
        .bind(reservedWrites, writeCharge, reservedReads, readCharge, hasMetrics ? rowsWritten : 0,
          hasMetrics ? rowsRead : 0, now.toISOString(), day).run();
    } catch {
      // Archive/delete already committed. Retain the full reserve rather than
      // replaying a successful transaction or granting an unearned refund.
      console.warn('wint_history_settlement_deferred');
    }
    return { status: 'ok', archivedSnapshots: plan.selectedSnapshots, archivedPrices: plan.selectedPrices,
      moreExpiredSnapshots: plan.moreExpiredSnapshots, moreExpiredPrices: plan.moreExpiredPrices,
      pendingSnapshotsAtLeast, pendingPricesAtLeast,
      pendingCountCapped: pendingSnapshotsAtLeast === 1001 || pendingPricesAtLeast === 1001,
      rowsWritten: hasMetrics ? rowsWritten : undefined, rowsRead: hasMetrics ? rowsRead : undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 240) : 'History maintenance failed';
    if (reservationTaken) {
      try { await env.DB.prepare("UPDATE history_maintenance_budget SET last_status='error',last_error=?,updated_at=? WHERE day_key=?")
        .bind(message, now.toISOString(), day).run(); } catch { /* D1 may be unavailable; the reservation remains safe. */ }
    }
    return { status: 'error', archivedSnapshots: 0, archivedPrices: 0, error: message };
  } finally {
    if (ownLease) {
      try { await env.DB.prepare("UPDATE history_maintenance_lock SET owner=NULL,lease_until=NULL WHERE id='global' AND owner=?")
        .bind(owner).run(); } catch { /* The lease expires after five minutes. */ }
    }
  }
}
