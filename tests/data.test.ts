import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../worker/index';
import type { Env } from '../worker/types';
import { DATA_RESOURCES, type PublicDataEnvelope } from '../shared/data';
import { createTestDB } from './sqlite-d1';

const AT = '2026-10-13T12:00:00.000Z';
let store: ReturnType<typeof createTestDB>, env: Env;
let pending: Promise<unknown>[], cache: Map<string, Response>;
const ctx = { waitUntil(promise: Promise<unknown>) { pending.push(promise); } } as ExecutionContext;
const call = (path = '/api/data', init: RequestInit = {}) => worker.fetch(new Request(`https://wint.test${path}`, init), env, ctx);
function entity(table: string, id: string, data: Record<string, unknown> = {}) {
  store.sqlite.prepare(`INSERT INTO ${table}(id,name,country_id,source_url,updated_at,first_seen,hash,data_json${table === 'articles' ? ',title' : ''}) VALUES(?,?,?,?,?,?,?,?${table === 'articles' ? ',?' : ''})`)
    .run(id, `Public ${id}`, 'es', `https://api2.warera.io/trpc/public?input=${id}`, AT, AT, 'sensitive-hash', JSON.stringify(data), ...(table === 'articles' ? [String(data.title)] : []));
}
beforeEach(() => {
  store = createTestDB(); pending = []; cache = new Map();
  env = { DB: store.db, ASSETS: { fetch: async () => new Response('assets') } as unknown as Fetcher,
    SESSION_SECRET: 'private-session-secret', COLLECTOR_SECRET: 'private-collector-secret', AI: { run: vi.fn() } };
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('No upstream access allowed'); }));
  vi.stubGlobal('caches', { open: async () => ({ match: async (key: Request) => cache.get(key.url)?.clone(),
    put: async (key: Request, value: Response) => { cache.set(key.url, value.clone()); } }) });
});
afterEach(async () => { await Promise.all(pending); store.sqlite.close(); vi.unstubAllGlobals(); });

describe('central public JSON data endpoint', () => {
  it('returns all fourteen captured datasets, coverage and public fields without bodies, credentials or upstream calls', async () => {
    entity('countries', 'es', { code: 'ES', money: 100 });
    entity('players', 'p1', { username: 'Public player', damagesCount: 25, email: 'private-contact', password: 'private-password' });
    entity('articles', 'a1', { title: 'Public title', body: 'protected-article-body', stats: { views: 7, contact: 'private-contact' } });
    entity('elections', 'e1', { candidates: [{ user: 'p1', voteCount: 5, isElected: true, email: 'private-contact' }] });
    store.sqlite.prepare('INSERT INTO player_census_state(country_id,next_run_at,last_scanned_at,completed_sweeps) VALUES(?,?,?,?)').run('es', AT, AT, 1);
    store.sqlite.prepare('UPDATE source_registry SET last_success=? WHERE id=?').run(AT, 'players');
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const data = await response.json() as PublicDataEnvelope;
    expect(data).toMatchObject({ schemaVersion: '1.0', mode: 'catalog', scope: 'captured-public-data', resource: null,
      coverage: { countriesTotal: 1, countriesStarted: 1, countriesCompleted: 1, countriesPending: 0, worldPlayerTotal: null, activePlayerTotal: null } });
    expect(Object.keys(data.datasets)).toEqual([...DATA_RESOURCES]);
    expect(data.datasets.players).toMatchObject({ totalCaptured: 1, lastSuccessfulCollectionAt: AT, pagination: { hasMore: false, nextUrl: null } });
    expect(data.datasets.players?.items[0].data.damagesCount).toBe(25);
    expect(data.datasets.articles?.items[0].data.stats).toEqual({ views: 7, likes: null, comments: null });
    expect(data.datasets.elections?.items[0].data.candidates).toEqual([{ user: 'p1', party: null, voteCount: 5, isElected: true }]);
    expect(data.datasets.players?.items[0].historyUrl).toContain('/api/history?resource=players');
    expect(JSON.stringify(data)).not.toMatch(/protected-article-body|private-contact|private-password|sensitive-hash|private-session-secret|private-collector-secret/);
    expect(fetch).not.toHaveBeenCalled(); expect(env.AI!.run).not.toHaveBeenCalled();
    expect(store.sqlite.prepare('SELECT COUNT(*) n FROM request_limits').get()?.n).toBe(0);
  });

  it('walks indexed keyset pages without repeating records when rows are inserted between requests', async () => {
    for (const id of ['a', 'b', 'c', 'd', 'e']) entity('players', id);
    const prepare = vi.spyOn(env.DB, 'prepare');
    const first = await (await call('/api/data?resource=players&limit=2')).json() as PublicDataEnvelope;
    expect(first.datasets.players?.items.map(row => row.id)).toEqual(['a', 'b']);
    expect(first.coverage).toBeNull();
    entity('players', 'aa'); entity('players', 'bb');
    const found = first.datasets.players!.items.map(row => row.id);
    let next = first.datasets.players!.pagination.nextUrl;
    while (next) {
      const page = await (await call(new URL(next).pathname + new URL(next).search)).json() as PublicDataEnvelope;
      expect(Object.keys(page.datasets)).toEqual(['players']);
      found.push(...page.datasets.players!.items.map(row => row.id));
      next = page.datasets.players!.pagination.nextUrl;
    }
    expect(found).toEqual(['a', 'b', 'bb', 'c', 'd', 'e']);
    expect(new Set(found).size).toBe(found.length);
    const sql = prepare.mock.calls.map(args => args[0]).find(sql => sql.includes('FROM players') && sql.includes('id>?'))!;
    const plan = store.sqlite.prepare('EXPLAIN QUERY PLAN ' + sql).all('b', 3);
    expect(plan.map(row => row.detail).join(' ')).toMatch(/SEARCH players USING INDEX/);
    expect(sql).not.toContain('OFFSET');
  });

  it('uses the latest global price and projected top offers, retaining products without a price', async () => {
    entity('market_items', 'iron'); entity('market_items', 'steel');
    const insert = store.sqlite.prepare('INSERT INTO market_prices(item_id,country_id,price,captured_at,source_url) VALUES(?,?,?,?,?)');
    insert.run('iron', null, 5, '2026-10-12T12:00:00Z', 'https://api2.warera.io/trpc/prices');
    insert.run('iron', null, 6, AT, 'https://api2.warera.io/trpc/prices');
    insert.run('iron', 'es', 99, '2026-10-13T13:00:00Z', 'https://api2.warera.io/trpc/prices');
    entity('orderbook_snapshots', 'iron', { itemCode: 'iron', coverage: 'observed-top-five-per-side',
      buyOrders: [{ price: 5, quantity: 10, offeredAt: AT, user: 'private-order-owner' }], sellOrders: [] });
    const data = await (await call()).json() as PublicDataEnvelope;
    expect(data.datasets.markets?.items[0].data.price).toBe(6);
    expect(data.datasets.markets?.items[1].data.price).toBeNull();
    expect(data.datasets.orderbooks?.items[0].data.buyOrders).toEqual([{ price: 5, quantity: 10, offeredAt: AT }]);
    expect(JSON.stringify(data.datasets.orderbooks)).not.toContain('private-order-owner');
  });

  it('rejects unsupported, repeated and excessive parameters before accessing D1 and remains read-only', async () => {
    const prepare = vi.spyOn(env.DB, 'prepare');
    for (const path of ['/api/data?resource=admin_sessions', '/api/data?limit=50', '/api/data?resource=players&limit=51',
      '/api/data?resource=players&limit=1&limit=2', '/api/data?after=p1', '/api/data?sql=DROP', '/api/data?resource=players&after=%00'])
      expect((await call(path)).status).toBe(400);
    expect((await call('/api/data', { method: 'POST', body: '{}' })).status).toBe(405);
    const options = await call('/api/data', { method: 'OPTIONS', headers: { Origin: 'https://consumer.test', 'Access-Control-Request-Method': 'GET' } });
    expect(options.status).toBe(204); expect(options.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(prepare).not.toHaveBeenCalled();
  });

  it('keeps HEAD from poisoning the GET cache and exposes rate and database failures to cross-origin clients', async () => {
    entity('players', 'p1');
    expect(await (await call('/api/data', { method: 'HEAD' })).text()).toBe('');
    await Promise.all(pending); expect(cache.size).toBe(0);
    const get = await call(); expect((await get.json() as PublicDataEnvelope).datasets.players?.items).toHaveLength(1);
    await Promise.all(pending); expect(cache.size).toBe(1);
    expect(await (await call('/api/data', { method: 'HEAD' })).text()).toBe('');
    env.PUBLIC_RATE_LIMITER = { limit: async () => ({ success: false }) };
    const limited = await call(); expect(limited.status).toBe(429);
    expect(limited.headers.get('Access-Control-Allow-Origin')).toBe('*'); expect(limited.headers.get('Retry-After')).toBe('60');
    env.PUBLIC_RATE_LIMITER = undefined; cache.clear();
    vi.spyOn(env.DB, 'batch').mockRejectedValueOnce(Error('private-database-diagnostic'));
    const failed = await call(); expect(failed.status).toBe(503);
    expect(failed.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await failed.text()).not.toContain('private-database-diagnostic');
  });
});
