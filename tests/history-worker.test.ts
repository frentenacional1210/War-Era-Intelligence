import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../worker/index';
import { createTestDB } from './sqlite-d1';
import type { Env } from '../worker/types';

afterEach(() => vi.unstubAllGlobals());
describe('historical API through the public Worker', () => {
  it('supports foreign consumers and empty HEAD without poisoning the GET cache', async () => {
    const store = createTestDB();
    const pending: Promise<unknown>[] = [], cache = new Map<string, Response>();
    vi.stubGlobal('caches', { open: async () => ({ match: async (key: Request) => cache.get(key.url)?.clone(),
      put: async (key: Request, response: Response) => { cache.set(key.url, response.clone()); } }) });
    const env = { DB: store.db } as Env;
    const ctx = { waitUntil(promise: Promise<unknown>) { pending.push(promise); } } as ExecutionContext;
    const at = new Date().toISOString();
    store.sqlite.prepare('INSERT INTO players(id,name,source_url,updated_at,first_seen,hash,data_json) VALUES(?,?,?,?,?,?,?)')
      .run('p1', 'Observed player', 'https://api2.warera.io/trpc/user.getUserLite', at, at, 'hash', '{}');
    store.sqlite.prepare('INSERT INTO entity_snapshots(entity_type,entity_id,captured_at,hash,data_json) VALUES(?,?,?,?,?)')
      .run('players', 'p1', at, 'hash', '{"level":3}');
    const url = 'https://wint.test/api/history?resource=players&id=p1&period=7d';
    const call = (method: string, target = url) => worker.fetch(new Request(target, { method, headers: { Origin: 'https://consumer.test' } }), env, ctx);
    try {
      const head = await call('HEAD');
      expect(head.status).toBe(200); expect(await head.text()).toBe('');
      await Promise.all(pending); expect(cache.size).toBe(0);
      const get = await call('GET');
      expect(get.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect((await get.json() as { points: unknown[] }).points).toHaveLength(1);
      await Promise.all(pending);
      expect(cache.size).toBe(1);
      expect(await (await call('HEAD')).text()).toBe('');
      expect((await call('OPTIONS')).status).toBe(204);
      const error = await call('GET', 'https://wint.test/api/history?resource=admin&id=p1');
      expect(error.status).toBe(400); expect(error.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect((await call('POST')).status).toBe(405);
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM entity_snapshots').get()?.n).toBe(1);
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM history_maintenance_budget').get()?.n).toBe(0);
    } finally { await Promise.all(pending); store.sqlite.close(); }
  });
});
