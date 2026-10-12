import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analysisRoute } from '../worker/analysis';
import { metricChange } from '../shared/analysis';
import { createTestDB } from './sqlite-d1';
import type { Env } from '../worker/types';

let store: ReturnType<typeof createTestDB>;
let env: Env;
const call = (path: string, method = 'GET') => analysisRoute(new Request(`https://wint.test${path}`, { method }), env);
beforeEach(() => {
  store = createTestDB();
  env = { DB: store.db, ASSETS: { fetch: async () => new Response() } as unknown as Fetcher };
  store.sqlite.exec(`INSERT INTO players(id,name,country_id,level,experience,source_url,updated_at,first_seen,hash,data_json)
    VALUES ('p1','Ana','es',5,100,'https://warera.io/user/p1','2026-10-12','2026-10-10','private-digest','{"damagesCount":12}'),
    ('p2','Berto','fr',7,NULL,'https://warera.io/user/p2','2026-10-12','2026-10-10','private-digest','{}');`);
});
afterEach(() => store.sqlite.close());

describe('bounded public analysis', () => {
  it('compares actual columns and normalized metrics without exposing storage fields', async () => {
    const response = await call('/api/analysis/compare?resource=players&ids=p2,p1');
    expect(response?.status).toBe(200);
    const result = await response!.json() as { items: Record<string, unknown>[] };
    expect(result.items.map(item => item.id)).toEqual(['p2', 'p1']);
    expect(result.items[0].metrics).toEqual({ level: 7, experience: null, damages_count: null });
    expect(result.items[1].metrics).toEqual({ level: 5, experience: 100, damages_count: 12 });
    expect(result.items[1]).not.toHaveProperty('hash');
    expect(result.items[1]).not.toHaveProperty('data_json');
    expect(result.items[1]).not.toHaveProperty('data');
  });
  it('rejects unknown resources, duplicate or missing IDs, long IDs and writes', async () => {
    for (const path of [
      '/api/analysis/compare?resource=alerts&ids=p1,p2',
      '/api/analysis/compare?resource=players&ids=p1,p1',
      '/api/analysis/compare?resource=players&ids=p1',
      `/api/analysis/compare?resource=players&ids=p1,${'x'.repeat(101)}`,
      '/api/analysis/history?resource=players&id=',
    ]) expect((await call(path))?.status).toBe(400);
    expect((await call('/api/analysis/compare?resource=players&ids=p1,absent'))?.status).toBe(404);
    expect((await call('/api/analysis/history?resource=players&id=p1', 'POST'))?.status).toBe(405);
    expect(store.sqlite.prepare('SELECT COUNT(*) total FROM players').get()?.total).toBe(2);
  });
  it('returns empty and single histories without claiming a change', async () => {
    const path = '/api/analysis/history?resource=players&id=p1';
    const empty = await (await call(path))!.json() as { observation_count: number; changes: { level: { delta: number | null; observations: number } } };
    expect(empty.observation_count).toBe(0);
    expect(empty.changes.level).toMatchObject({ observations: 0, delta: null });
    store.sqlite.prepare('INSERT INTO entity_snapshots(entity_type,entity_id,captured_at,hash,data_json) VALUES (?,?,?,?,?)').run('players', 'p1', '2026-10-10', 'h1', JSON.stringify({ level: 0, damagesCount: 12 }));
    const single = await (await call(path))!.json() as typeof empty;
    expect(single.changes.level).toMatchObject({ observations: 1, delta: null });
  });
  it('orders real snapshots and handles zero baselines and missing metrics', async () => {
    const insert = store.sqlite.prepare('INSERT INTO entity_snapshots(entity_type,entity_id,captured_at,hash,data_json) VALUES (?,?,?,?,?)');
    insert.run('players', 'p1', '2026-10-12', 'h3', JSON.stringify({ level: 5, damagesCount: 20 }));
    insert.run('players', 'p1', '2026-10-10', 'h1', JSON.stringify({ level: 0, damagesCount: 10 }));
    insert.run('players', 'p1', '2026-10-11', 'h2', JSON.stringify({ damagesCount: null }));
    const result = await (await call('/api/analysis/history?resource=players&id=p1'))!.json() as { observations: { captured_at: string; metrics: { level: number | null } }[]; changes: { level: { observations: number; delta: number; percent: number | null }; damages_count: { observations: number; delta: number } } };
    expect(result.observations.map(item => item.captured_at)).toEqual(['2026-10-10', '2026-10-11', '2026-10-12']);
    expect(result.observations[1].metrics.level).toBeNull();
    expect(result.changes.level).toMatchObject({ observations: 2, delta: 5, percent: null });
    expect(result.changes.damages_count).toMatchObject({ observations: 2, delta: 10 });
  });
  it('does not turn absent values into zero in pure change calculations', () => {
    expect(metricChange([{ captured_at: 'a', metrics: { level: null } }, { captured_at: 'b', metrics: { level: 9 } }], 'level')).toMatchObject({ observations: 1, delta: null, percent: null });
  });
  it('caps history to the 90 most recent real captures', async () => {
    const insert = store.sqlite.prepare('INSERT INTO entity_snapshots(entity_type,entity_id,captured_at,hash,data_json) VALUES (?,?,?,?,?)');
    for (let day = 1; day <= 91; day++) insert.run('players', 'p1', new Date(Date.UTC(2026, 0, day)).toISOString(), `h${day}`, JSON.stringify({ level: day }));
    const result = await (await call('/api/analysis/history?resource=players&id=p1'))!.json() as { observation_count: number; observations: { metrics: { level: number } }[] };
    expect(result.observation_count).toBe(90);
    expect(result.observations[0].metrics.level).toBe(2);
    expect(result.observations.at(-1)?.metrics.level).toBe(91);
  });
});
