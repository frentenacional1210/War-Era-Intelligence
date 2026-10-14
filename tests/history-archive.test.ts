import { describe, expect, it } from 'vitest';
import { advanceBucket, bucketStart } from '../shared/history';
import { prepareHistoryMaintenance } from '../worker/history-archive';
import { createTestDB } from './sqlite-d1';

const NOW = new Date('2026-10-14T12:00:00.000Z');
type Store = ReturnType<typeof createTestDB>;
const insertSnapshot = (store: Store, id: number, capturedAt: string, data: unknown, resource = 'players') =>
  store.sqlite.prepare('INSERT INTO entity_snapshots(id,entity_type,entity_id,captured_at,hash,data_json) VALUES(?,?,?,?,?,?)')
    .run(id, resource, 'p1', capturedAt, `h-${id}`, typeof data === 'string' ? data : JSON.stringify(data));
const archive = async (store: Store, perSource = 20) => {
  const plan = await prepareHistoryMaintenance(store.db, NOW, perSource);
  await store.db.batch(plan.statements);
  return plan;
};
const rollup = (store: Store, grain: string) => store.sqlite.prepare(
  'SELECT * FROM history_rollups WHERE resource=? AND entity_id=? AND grain=? ORDER BY bucket_start',
).all('players', 'p1', grain);

describe('history archive preservation', () => {
  it('uses the time-leading archive index when many snapshots are still fresh', async () => {
    const store = createTestDB();
    try {
      const insert = store.sqlite.prepare(`INSERT INTO entity_snapshots(entity_type,entity_id,captured_at,hash,data_json)
        VALUES('players','p1',?,?,?)`);
      const freshAt = Date.parse('2026-10-13T00:00:00.000Z');
      for (let id = 0; id < 1200; id++) {
        insert.run(new Date(freshAt + id * 1000).toISOString(), `fresh-${id}`, '{"level":1}');
      }
      let candidateSql = '';
      const db = {
        ...store.db,
        prepare: (sql: string) => {
          if (sql.includes('SELECT id,entity_type,entity_id,captured_at,data_json FROM entity_snapshots')) candidateSql = sql;
          return store.db.prepare(sql);
        },
      } as D1Database;
      const plan = await prepareHistoryMaintenance(db, NOW, 1);
      expect(plan.selectedSnapshots).toBe(0);
      expect(candidateSql).not.toBe('');
      const cutoff = new Date(NOW.getTime() - 30 * 86_400_000).toISOString();
      const queryPlan = store.sqlite.prepare(`EXPLAIN QUERY PLAN ${candidateSql}`)
        .all(cutoff, '', 0, 20);
      const details = queryPlan.map(row => String(row.detail)).join(' ');
      expect(details).toContain('idx_snapshots_archive_due (captured_at');
      expect(details).not.toContain('idx_snapshots_entity_time');
      const resumedPlan = store.sqlite.prepare(`EXPLAIN QUERY PLAN ${candidateSql}`)
        .all(cutoff, '2026-09-01T00:00:00.000Z', 600, 20);
      const resumedDetails = resumedPlan.map(row => String(row.detail)).join(' ');
      expect(resumedDetails).toMatch(/idx_snapshots_archive_due \(captured_at>\?/);
    } finally { store.sqlite.close(); }
  });

  it('compacts more than one batch without losing any observations', async () => {
    const store = createTestDB();
    try {
      for (let id = 1; id <= 25; id++) insertSnapshot(store, id, `2026-08-01T08:${String(id).padStart(2, '0')}:00.000Z`, { level: id });
      const selected: number[] = [];
      for (let run = 0; run < 4; run++) {
        selected.push((await archive(store, 8)).selectedSnapshots);
        if (run === 0) expect(store.sqlite.prepare("SELECT snapshot_scan_id FROM history_maintenance_lock WHERE id='global'").get()?.snapshot_scan_id).toBe(8);
      }
      expect(selected).toEqual([8, 8, 8, 1]);
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM entity_snapshots').get()?.n).toBe(0);
      for (const grain of ['day', 'week', 'month']) {
        const rows = rollup(store, grain);
        expect(rows).toHaveLength(1);
        expect(rows[0].observations).toBe(25);
        expect(JSON.parse(String(rows[0].first_metrics_json)).level).toBe(1);
        expect(JSON.parse(String(rows[0].last_metrics_json)).level).toBe(25);
        expect(rows[0].first_sort_id).toBe(1);
        expect(rows[0].last_sort_id).toBe(25);
      }
      expect(store.sqlite.prepare("SELECT first_at,first_sort_id FROM history_baselines WHERE resource='players' AND entity_id='p1'").get())
        .toMatchObject({ first_at: '2026-08-01T08:01:00.000Z', first_sort_id: 1 });
    } finally { store.sqlite.close(); }
  });

  it('orders equal-time arrivals by source ID across separate batches and accepts a late earlier baseline', async () => {
    const store = createTestDB();
    const at = '2026-08-01T08:00:00.000Z';
    try {
      insertSnapshot(store, 20, at, { level: 20 });
      await archive(store);
      insertSnapshot(store, 5, at, { level: 5 });
      await archive(store);
      insertSnapshot(store, 30, at, { level: 30 });
      await archive(store);
      for (const grain of ['day', 'week', 'month']) {
        const row = rollup(store, grain)[0];
        expect(row.observations).toBe(3);
        expect([row.first_sort_id, row.last_sort_id]).toEqual([5, 30]);
        expect(JSON.parse(String(row.first_metrics_json)).level).toBe(5);
        expect(JSON.parse(String(row.last_metrics_json)).level).toBe(30);
      }
      expect(store.sqlite.prepare("SELECT first_sort_id,metrics_json FROM history_baselines WHERE resource='players' AND entity_id='p1'").get())
        .toMatchObject({ first_sort_id: 5, metrics_json: expect.stringContaining('"level":5') });
      insertSnapshot(store, 31, '2026-07-31T08:00:00.000Z', { level: 1 });
      await archive(store);
      const baseline = store.sqlite.prepare("SELECT first_at,first_sort_id,metrics_json FROM history_baselines WHERE resource='players' AND entity_id='p1'").get()!;
      expect(baseline.first_at).toBe('2026-07-31T08:00:00.000Z');
      expect(baseline.first_sort_id).toBe(31);
      expect(JSON.parse(String(baseline.metrics_json)).level).toBe(1);
    } finally { store.sqlite.close(); }
  });

  it('keeps unsupported and unprojectable raw snapshots while archiving later valid rows', async () => {
    const store = createTestDB();
    try {
      insertSnapshot(store, 1, '2026-07-01T00:00:00.000Z', { level: 1 }, 'future-resource');
      insertSnapshot(store, 2, '2026-07-02T00:00:00.000Z', '[]');
      insertSnapshot(store, 3, '2026-07-03T00:00:00.000Z', { unrelated: 123 });
      insertSnapshot(store, 4, '2026-08-04T00:00:00.000Z', { level: 4 });
      const plan = await archive(store, 1);
      expect(plan.selectedSnapshots).toBe(1);
      expect(store.sqlite.prepare('SELECT id FROM entity_snapshots ORDER BY id').all().map(row => row.id)).toEqual([1, 2, 3]);
      expect(store.sqlite.prepare("SELECT observations FROM history_rollups WHERE resource='players' AND grain='day'").get()?.observations).toBe(1);
    } finally { store.sqlite.close(); }
  });

  it('resumes after a bounded scan of 1,001 unsupported or unprojectable rows and reaches valid history', async () => {
    const store = createTestDB();
    try {
      const start = Date.parse('2026-07-01T00:00:00.000Z');
      for (let id = 1; id <= 1001; id++) {
        insertSnapshot(store, id, new Date(start + id * 60_000).toISOString(), { unrelated: id },
          id % 2 === 0 ? 'players' : 'future-resource');
      }
      insertSnapshot(store, 1002, new Date(start + 1002 * 60_000).toISOString(), { level: 42 });
      const first = await archive(store, 1);
      expect(first.selectedSnapshots).toBe(0);
      expect(first.moreExpiredSnapshots).toBe(true);
      expect(store.sqlite.prepare("SELECT snapshot_scan_id FROM history_maintenance_lock WHERE id='global'").get()?.snapshot_scan_id).toBe(1000);
      const second = await archive(store, 1);
      expect(second.selectedSnapshots).toBe(1);
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM entity_snapshots').get()?.n).toBe(1001);
      expect(store.sqlite.prepare('SELECT id FROM entity_snapshots WHERE id=1002').get()).toBeUndefined();
      const baseline = store.sqlite.prepare("SELECT metrics_json FROM history_baselines WHERE resource='players' AND entity_id='p1'").get()!;
      expect(JSON.parse(String(baseline.metrics_json)).level).toBe(42);
    } finally { store.sqlite.close(); }
  });

  it('rolls back the scan cursor with the archive transaction', async () => {
    const store = createTestDB();
    try {
      insertSnapshot(store, 1, '2026-08-01T08:00:00.000Z', { level: 1 });
      insertSnapshot(store, 2, '2026-08-01T09:00:00.000Z', { level: 2 });
      const plan = await prepareHistoryMaintenance(store.db, NOW, 1);
      const failure = store.db.prepare("INSERT INTO countries(id,name,source_url,updated_at,first_seen,hash,data_json) VALUES('x','X','x','x','x','x','x'),('x','X','x','x','x','x','x')");
      await expect(store.db.batch([...plan.statements, failure])).rejects.toThrow();
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM entity_snapshots').get()?.n).toBe(2);
      expect(store.sqlite.prepare("SELECT snapshot_scan_at,snapshot_scan_id FROM history_maintenance_lock WHERE id='global'").get())
        .toEqual({ snapshot_scan_at: null, snapshot_scan_id: null });
      await store.db.batch(plan.statements);
      expect(store.sqlite.prepare("SELECT snapshot_scan_id FROM history_maintenance_lock WHERE id='global'").get()?.snapshot_scan_id).toBe(1);
    } finally { store.sqlite.close(); }
  });

  it('retains the day, week, and month bucket intersecting each horizon', async () => {
    const store = createTestDB();
    try {
      const boundaries = [
        ['day', bucketStart(new Date(NOW.getTime() - 90 * 86_400_000).toISOString(), 'day')],
        ['week', bucketStart(new Date(NOW.getTime() - 366 * 86_400_000).toISOString(), 'week')],
        ['month', bucketStart(new Date(Date.UTC(NOW.getUTCFullYear() - 2, NOW.getUTCMonth(), 1)).toISOString(), 'month')],
      ] as const;
      const insert = store.sqlite.prepare(`INSERT INTO history_rollups
        (resource,entity_id,grain,bucket_start,first_at,last_at,first_metrics_json,last_metrics_json,observations)
        VALUES('players','p1',?,?,?,?,?,?,1)`);
      for (const [grain, boundary] of boundaries) {
        const prior = new Date(boundary);
        if (grain === 'month') prior.setUTCMonth(prior.getUTCMonth() - 1);
        else prior.setUTCDate(prior.getUTCDate() - (grain === 'week' ? 7 : 1));
        insert.run(grain, prior.toISOString(), prior.toISOString(), prior.toISOString(), '{}', '{}');
        insert.run(grain, boundary, boundary, boundary, '{}', '{}');
        insert.run(grain, advanceBucket(boundary, grain), boundary, boundary, '{}', '{}');
      }
      await archive(store, 0);
      for (const [grain, boundary] of boundaries) {
        const rows = rollup(store, grain);
        expect(rows.map(row => row.bucket_start)).toEqual([boundary, advanceBucket(boundary, grain)]);
      }
    } finally { store.sqlite.close(); }
  });

  it('does not mutate archive or raw rows when a prepared plan loses its lease', async () => {
    const store = createTestDB();
    try {
      insertSnapshot(store, 1, '2026-08-01T08:00:00.000Z', { level: 1 });
      store.sqlite.prepare("UPDATE history_maintenance_lock SET owner='old',lease_until='2026-10-14T12:05:00.000Z' WHERE id='global'").run();
      const plan = await prepareHistoryMaintenance(store.db, NOW, 20, { owner: 'old' });
      store.sqlite.prepare("UPDATE history_maintenance_lock SET owner='new' WHERE id='global'").run();
      await store.db.batch(plan.statements);
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM entity_snapshots').get()?.n).toBe(1);
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM history_rollups').get()?.n).toBe(0);
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM history_baselines').get()?.n).toBe(0);
    } finally { store.sqlite.close(); }
  });

  it('retains the selected latest market quote when old quotes share a timestamp', async () => {
    const store = createTestDB();
    try {
      store.sqlite.prepare(`INSERT INTO market_items(id,name,country_id,source_url,updated_at,first_seen,hash,data_json)
        VALUES('iron','Iron',NULL,'https://example.test','2026-08-01','2026-08-01','h','{}')`).run();
      const insert = store.sqlite.prepare(`INSERT INTO market_prices(id,item_id,country_id,price,captured_at,source_url)
        VALUES(?,'iron',NULL,?,?,'https://example.test')`);
      const at = '2026-08-01T08:00:00.000Z';
      insert.run(1, 10, at);
      insert.run(2, 12, at);
      const plan = await archive(store);
      expect(plan.selectedPrices).toBe(1);
      expect(store.sqlite.prepare('SELECT id,price FROM market_prices').all()).toEqual([{ id: 2, price: 12 }]);
      expect(store.sqlite.prepare("SELECT observations,last_sort_id,last_metrics_json FROM history_rollups WHERE resource='markets' AND grain='day'").get())
        .toMatchObject({ observations: 1, last_sort_id: 1, last_metrics_json: '{"price":10}' });
    } finally { store.sqlite.close(); }
  });
});
