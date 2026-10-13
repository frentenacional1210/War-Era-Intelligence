import { describe, expect, it, vi } from 'vitest';
import { createTestDB } from './sqlite-d1';
import type { Env } from '../worker/types';
import { fetchBattleReconciliation } from '../worker/battle-reconciliation';
import { WarEraClient } from '../worker/warera';

function setup() {
  const store = createTestDB();
  store.sqlite.exec("INSERT INTO battles(id,name,country_id,is_active,source_url,updated_at,first_seen,hash,data_json) VALUES ('b1','Battle','es',1,'https://api2.warera.io/trpc/battle.getById','2026-01-01','2026-01-01','h','{}')");
  return { ...store, env: { DB: store.db } as Env };
}
const at = new Date('2026-01-02T00:00:00.000Z');
const client = (status: number, detail?: unknown) => {
  const fetcher = vi.fn(async () => new Response(status === 200 ? JSON.stringify({ result: { data: detail } }) : '{}',
    { status, headers: { 'Content-Type': 'application/json' } }));
  return { instance: new WarEraClient('https://api2.warera.io/trpc', undefined, fetcher as typeof fetch), fetcher };
};

describe('authoritative battle reconciliation', () => {
  it('bounds candidate selection to indexed active rows with one detail request', () => {
    const store = setup();
    try {
      const plan = store.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT b.id FROM battles b
        LEFT JOIN battle_reconciliation_state s ON s.battle_id=b.id WHERE b.is_active=1
        AND (s.last_checked_at IS NULL OR s.last_checked_at<=?)
        ORDER BY COALESCE(s.last_checked_at,''),b.updated_at,b.id LIMIT 1`).all('2026-01-01')
        .map(row => String(row.detail)).join(' ');
      expect(plan).toContain('idx_battles_active');
      expect(plan).toContain('sqlite_autoindex_battle_reconciliation_state_1');
    } finally { store.sqlite.close(); }
  });
  it('marks 404 unknown and keeps the active battle eligible after cooldown', async () => {
    const store = setup();
    const mock = client(404);
    try {
      expect(store.sqlite.prepare("SELECT status,enabled FROM source_registry WHERE id='battle-reconciliation'").get())
        .toMatchObject({ status: 'pending', enabled: 1 });
      const result = await fetchBattleReconciliation(store.env, mock.instance, 1, at);
      expect(result.records).toEqual([]);
      expect(result.checkpoint).toBeDefined();
      await result.checkpoint!.run();
      expect(store.sqlite.prepare('SELECT last_status FROM battle_reconciliation_state WHERE battle_id=?').get('b1'))
        .toMatchObject({ last_status: 'not-found-unknown' });
      expect(store.sqlite.prepare('SELECT is_active FROM battles WHERE id=?').get('b1')).toMatchObject({ is_active: 1 });
      expect((await fetchBattleReconciliation(store.env, mock.instance, 1, new Date(at.getTime() + 60_000))).records).toEqual([]);
      expect(mock.fetcher).toHaveBeenCalledTimes(1);
      await fetchBattleReconciliation(store.env, mock.instance, 1, new Date(at.getTime() + 11 * 60_000));
      expect(mock.fetcher).toHaveBeenCalledTimes(2);
    } finally { store.sqlite.close(); }
  });

  it('returns only compact verified detail and a transactional checkpoint', async () => {
    const store = setup();
    const mock = client(200, { _id: 'b1', isActive: false, endedAt: '2026-01-02T01:00:00.000Z',
      wonBy: 'attacker', attacker: { country: 'es', damages: 123, privateDetail: 'omit' },
      defender: { country: 'fr', damages: 100 }, roundsHistory: Array(100).fill('large') });
    try {
      const result = await fetchBattleReconciliation(store.env, mock.instance, 1, at);
      expect(result.records).toHaveLength(1);
      expect(result.records[0]).toMatchObject({ _id: 'b1', isActive: false, endedAt: '2026-01-02T01:00:00.000Z', wonBy: 'attacker' });
      expect(JSON.stringify(result.records)).not.toContain('privateDetail');
      expect(JSON.stringify(result.records)).not.toContain('roundsHistory');
      await result.checkpoint!.run();
      expect(store.sqlite.prepare('SELECT last_status FROM battle_reconciliation_state WHERE battle_id=?').get('b1'))
        .toMatchObject({ last_status: 'verified-inactive' });
    } finally { store.sqlite.close(); }
  });

  it('rejects mismatched detail IDs and oversized pages before checkpointing', async () => {
    const store = setup();
    try {
      await expect(fetchBattleReconciliation(store.env, client(200, { _id: 'other', isActive: false }).instance, 1, at))
        .rejects.toThrow('ID mismatch');
      await expect(fetchBattleReconciliation(store.env, client(200, { _id: 'b1', isActive: true }).instance, 2, at))
        .rejects.toThrow('limit');
      expect(store.sqlite.prepare('SELECT COUNT(*) count FROM battle_reconciliation_state').get()).toMatchObject({ count: 0 });
    } finally { store.sqlite.close(); }
  });
});
