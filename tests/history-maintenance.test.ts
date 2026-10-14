import { describe, expect, it } from 'vitest';
import { createTestDB } from './sqlite-d1';
import { HISTORY_MAINTENANCE_LIMITS, runHistoryMaintenance } from '../worker/history-maintenance';
import type { Env } from '../worker/types';

const NOW = new Date('2026-10-12T12:00:00.000Z');
const DAY = '2026-10-12';
const snapshot = (store: ReturnType<typeof createTestDB>) => store.sqlite.prepare(
  "INSERT INTO entity_snapshots(entity_type,entity_id,captured_at,hash,data_json) VALUES('players','p1','2026-08-01T08:00:00.000Z','h1','{\"level\":3}')",
).run();

describe('independent historical maintenance', () => {
  it('reserves before selecting, archives atomically, and refunds measured budget', async () => {
    const store = createTestDB();
    try {
      snapshot(store);
      const result = await runHistoryMaintenance({ DB: store.db } as Env, { now: NOW, perSource: 2 });
      expect(result).toMatchObject({ status: 'ok', archivedSnapshots: 1, archivedPrices: 0 });
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM entity_snapshots').get()?.n).toBe(0);
      expect(store.sqlite.prepare("SELECT COUNT(*) n FROM history_rollups WHERE resource='players'").get()?.n).toBe(3);
      const budget = store.sqlite.prepare('SELECT * FROM history_maintenance_budget WHERE day_key=?').get(DAY)!;
      expect(Number(budget.reserved_writes)).toBeGreaterThan(0);
      expect(Number(budget.reserved_writes)).toBeLessThan(HISTORY_MAINTENANCE_LIMITS.reservedWritesPerRun);
      expect(Number(budget.measured_writes)).toBeGreaterThan(0);
      expect(Number(budget.archived_snapshots)).toBe(1);
      expect(store.sqlite.prepare("SELECT owner FROM history_maintenance_lock WHERE id='global'").get()?.owner).toBeNull();
    } finally { store.sqlite.close(); }
  });

  it('does not read candidates or delete raw history when either account reserve is exhausted', async () => {
    const store = createTestDB();
    try {
      snapshot(store);
      store.sqlite.prepare("INSERT INTO ingestion_budget(day_key,reserved_writes,tick_count,updated_at) VALUES(?,?,0,?)")
        .run(DAY, HISTORY_MAINTENANCE_LIMITS.combinedWritesPerDay, NOW.toISOString());
      expect(await runHistoryMaintenance({ DB: store.db } as Env, { now: NOW })).toMatchObject({ status: 'quota-paused' });
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM entity_snapshots').get()?.n).toBe(1);
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM history_maintenance_budget').get()?.n).toBe(0);
      expect(store.sqlite.prepare("SELECT owner FROM history_maintenance_lock WHERE id='global'").get()?.owner).toBeNull();
    } finally { store.sqlite.close(); }
  });

  it('keeps a full reservation and source rows after a failed archive transaction', async () => {
    const store = createTestDB();
    try {
      snapshot(store);
      const db = { ...store.db, batch: async () => { throw new Error('simulated archive failure'); } } as unknown as D1Database;
      const result = await runHistoryMaintenance({ DB: db } as Env, { now: NOW });
      expect(result).toMatchObject({ status: 'error' });
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM entity_snapshots').get()?.n).toBe(1);
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM history_rollups').get()?.n).toBe(0);
      expect(store.sqlite.prepare('SELECT reserved_writes,last_status FROM history_maintenance_budget').get())
        .toMatchObject({ reserved_writes: HISTORY_MAINTENANCE_LIMITS.reservedWritesPerRun, last_status: 'error' });
      expect(store.sqlite.prepare("SELECT owner FROM history_maintenance_lock WHERE id='global'").get()?.owner).toBeNull();
    } finally { store.sqlite.close(); }
  });

  it('rejects concurrent runs without taking another reservation', async () => {
    const store = createTestDB();
    try {
      store.sqlite.prepare("UPDATE history_maintenance_lock SET owner='first',lease_until='2026-10-12T12:05:00.000Z' WHERE id='global'").run();
      expect(await runHistoryMaintenance({ DB: store.db } as Env, { now: NOW })).toMatchObject({ status: 'busy' });
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM history_maintenance_budget').get()?.n).toBe(0);
    } finally { store.sqlite.close(); }
  });

  it('leaves raw data intact and keeps its reserve if another owner takes the lease before settlement', async () => {
    const store = createTestDB();
    try {
      snapshot(store);
      const db = {
        ...store.db,
        batch: async (statements: D1PreparedStatement[]) => {
          store.sqlite.prepare("UPDATE history_maintenance_lock SET owner='replacement' WHERE id='global'").run();
          return store.db.batch(statements);
        },
      } as D1Database;
      const result = await runHistoryMaintenance({ DB: db } as Env, { now: NOW });
      expect(result.status).toBe('error');
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM entity_snapshots').get()?.n).toBe(1);
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM history_rollups').get()?.n).toBe(0);
      expect(store.sqlite.prepare('SELECT reserved_writes,last_status,archived_snapshots FROM history_maintenance_budget').get())
        .toMatchObject({ reserved_writes: HISTORY_MAINTENANCE_LIMITS.reservedWritesPerRun, last_status: 'error', archived_snapshots: 0 });
      expect(store.sqlite.prepare("SELECT owner FROM history_maintenance_lock WHERE id='global'").get()?.owner).toBe('replacement');
    } finally { store.sqlite.close(); }
  });
});
