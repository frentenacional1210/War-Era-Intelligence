import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDB } from './sqlite-d1';
import type { Env } from '../worker/types';
import { collectorRoute } from '../worker/collector';
import { COLLECTOR_PLAYER_ROWS } from '../shared/ingestion-config';
import { runSync } from '../worker/ingestion';
import { projectPublicPage } from '../shared/public-projection';

vi.mock('../worker/ingestion', () => ({ runSync: vi.fn(async () => ({ status: 'ok', source: 'players', processed: 1 })) }));
const secret = 'collector-test-secret-with-32-characters';
const url = 'https://example.test/api/collector/';
const json = async (response: Response | null) => response ? response.json() as Promise<Record<string, unknown>> : null;
const request = (path: string, body: unknown, token = secret) => new Request(url + path, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
function setup() {
  const store = createTestDB();
  store.sqlite.exec(`INSERT INTO countries(id,name,code,source_url,updated_at,first_seen,hash,data_json) VALUES
    ('es','Spain','es','https://example.test','2026-01-01','2026-01-01','a','{}'),
    ('fr','France','fr','https://example.test','2026-01-01','2026-01-01','b','{}')`);
  const env = { DB: store.db, COLLECTOR_SECRET: secret } as Env & { COLLECTOR_SECRET: string };
  return { ...store, env };
}
beforeEach(() => { vi.mocked(runSync).mockClear(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('collector route', () => {
  it('requires a bearer secret and never caches plan responses', async () => {
    const store = setup();
    try {
      expect(await collectorRoute(new Request('https://example.test/api/health'), store.env)).toBeNull();
      const denied = await collectorRoute(request('plan', { source: 'players' }, 'wrong-secret'), store.env);
      expect(denied?.status).toBe(401);
      expect(denied?.headers.get('Cache-Control')).toBe('no-store');
      const accepted = await collectorRoute(request('plan', { source: 'players' }), store.env);
      expect(accepted?.status).toBe(200);
      expect(accepted?.headers.get('Cache-Control')).toBe('no-store');
      expect(await json(accepted)).toMatchObject({ status: 'ready', source: 'players', cursorExpected: null,
        inputs: { countryId: 'es', limit: COLLECTOR_PLAYER_ROWS } });
    } finally { store.sqlite.close(); }
  });

  it('plans the same country rotation and article head/archive inputs as ingestion', async () => {
    const store = setup();
    try {
      store.sqlite.exec("INSERT INTO player_census_state(country_id,cursor,next_run_at,last_scanned_at,records_observed,completed_sweeps) VALUES ('es','es-next','1970-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',4,0)");
      store.sqlite.exec("INSERT INTO player_census_state(country_id,cursor,next_run_at,last_scanned_at,records_observed,completed_sweeps) VALUES ('fr','fr-next','1970-01-01T00:00:00.000Z','2026-01-02T00:00:00.000Z',4,0)");
      expect(await json(await collectorRoute(request('plan', { source: 'players' }), store.env))).toMatchObject({ inputs: { countryId: 'es', limit: COLLECTOR_PLAYER_ROWS, cursor: 'es-next' } });
      const archive = JSON.stringify({ archiveToken: 'archive-5', headNextAt: '2099-01-01T00:00:00.000Z' });
      store.sqlite.prepare("UPDATE ingestion_cursors SET cursor=? WHERE source_id='articles'").run(archive);
      expect(await json(await collectorRoute(request('plan', { source: 'articles' }), store.env))).toMatchObject({ cursorExpected: archive,
        inputs: { limit: 10, type: 'last', cursor: 'archive-5' } });
      const head = JSON.stringify({ archiveToken: 'archive-5', headNextAt: '1970-01-01T00:00:00.000Z' });
      store.sqlite.prepare("UPDATE ingestion_cursors SET cursor=? WHERE source_id='articles'").run(head);
      expect(await json(await collectorRoute(request('plan', { source: 'articles' }), store.env))).toMatchObject({ cursorExpected: head,
        inputs: { limit: 10, type: 'last' } });
    } finally { store.sqlite.close(); }
  });

  it('rejects malformed input and missing or mismatched profiles before sync', async () => {
    const store = setup();
    const page = { items: [{ _id: 'u1' }], nextCursor: 'next' };
    const profile = { _id: 'u1', username: 'One' };
    const base = { source: 'players', cursorExpected: null, input: { countryId: 'es', limit: COLLECTOR_PLAYER_ROWS }, page };
    try {
      expect((await collectorRoute(request('commit', { ...base, input: { countryId: 'fr', limit: 5 }, profiles: [profile] }), store.env))?.status).toBe(400);
      expect((await collectorRoute(request('commit', { ...base, cursorExpected: undefined, profiles: [profile] }), store.env))?.status).toBe(400);
      expect((await collectorRoute(request('commit', base), store.env))?.status).toBe(400);
      expect((await collectorRoute(request('commit', { ...base, profiles: [{ ...profile, _id: 'wrong' }] }), store.env))?.status).toBe(400);
      expect((await collectorRoute(request('commit', { ...base, page: { items: Array.from({ length: 5 }, (_, i) => ({ _id: `u${i}` })), nextCursor: null }, profiles: [] }), store.env))?.status).toBe(400);
      expect(runSync).not.toHaveBeenCalled();
    } finally { store.sqlite.close(); }
  });

  it('binds supplied pages to the exact DB-selected input after the claim', async () => {
    const store = setup();
    vi.mocked(runSync).mockImplementationOnce(async (_env, options) => {
      if (!options?.fetcher) throw new Error('Missing collector fetcher');
      const actual = new URL('https://api2.warera.io/trpc/user.getUsersByCountry');
      actual.searchParams.set('input', JSON.stringify({ countryId: 'fr', limit: COLLECTOR_PLAYER_ROWS }));
      await expect(options.fetcher(actual.toString(), { method: 'GET' })).rejects.toMatchObject({ status: 409 });
      return { status: 'busy', source: 'players' };
    });
    try {
      const response = await collectorRoute(request('commit', { source: 'players', cursorExpected: null,
        input: { countryId: 'es', limit: COLLECTOR_PLAYER_ROWS }, page: { items: [{ _id: 'u1' }], nextCursor: 'next' },
        profiles: [{ _id: 'u1', username: 'One' }] }), store.env);
      expect(response?.status).toBe(409);
      expect(vi.mocked(runSync).mock.calls[0]![1]).toMatchObject({ source: 'players', force: true, expectedCursor: null });
    } finally { store.sqlite.close(); }
  });

  it('passes only compact verified data through a bounded fake fetcher', async () => {
    const store = setup();
    const profile = { _id: 'u1', username: 'One', country: 'es', stats: { damagesCount: 2, hidden: 'secret' },
      dates: { lastConnectionAt: '2026-01-01T00:00:00Z', email: 'private@example.test' }, email: 'private@example.test' };
    try {
      const response = await collectorRoute(request('commit', { source: 'players', cursorExpected: null,
        input: { countryId: 'es', limit: COLLECTOR_PLAYER_ROWS }, page: { items: [{ _id: 'u1', email: 'private@example.test' }], nextCursor: 'next' }, profiles: [profile] }), store.env);
      expect(response?.status).toBe(200);
      const options = vi.mocked(runSync).mock.calls[0]![1] as { source: string; force: boolean; expectedCursor: string | null; fetcher: typeof fetch };
      expect(options).toMatchObject({ source: 'players', force: true, expectedCursor: null });
      const listUrl = new URL('https://api2.warera.io/trpc/user.getUsersByCountry');
      listUrl.searchParams.set('input', JSON.stringify({ countryId: 'es', limit: COLLECTOR_PLAYER_ROWS }));
      const list = await options.fetcher(listUrl.toString(), { method: 'GET' });
      expect(await list.json()).toEqual({ result: { data: { items: [{ _id: 'u1' }], nextCursor: 'next' } } });
      const batch = await options.fetcher('https://api2.warera.io/trpc/user.getUserLite?batch=1', { method: 'POST', body: JSON.stringify({ '0': { userId: 'u1' } }) });
      const wire = await batch.json();
      expect(JSON.stringify(wire)).not.toContain('private@example.test');
      expect(JSON.stringify(wire)).not.toContain('hidden');
      expect(wire).toMatchObject([{ result: { data: { _id: 'u1', username: 'One', stats: { damagesCount: 2 } } } }]);
      await expect(options.fetcher('https://api2.warera.io/trpc/user.getUserLite?batch=1', { method: 'POST', body: '{}' })).rejects.toMatchObject({ status: 409 });
    } finally { store.sqlite.close(); }
  });

  it('sends a visibility marker for private articles without content or title', async () => {
    const store = setup();
    try {
      const rawPage = { items: [
        { _id: 'public', title: 'Public', isPublic: true, isPublished: true, isDeleted: false, content: 'article body' },
        { _id: 'private', title: 'Private title', isPublic: false, isPublished: true, content: 'private body' },
      ], nextCursor: 'older' };
      const projected = projectPublicPage('articles', rawPage, 10);
      expect(projectPublicPage('articles', projected, 10)).toEqual(projected);
      expect(projected.items[1]).toEqual({ _id: 'private', isPublic: false });
      const response = await collectorRoute(request('commit', { source: 'articles', cursorExpected: null,
        input: { limit: 10, type: 'last' }, page: projected }), store.env);
      expect(response?.status).toBe(200);
      const options = vi.mocked(runSync).mock.calls[0]![1] as { fetcher: typeof fetch };
      const articleUrl = new URL('https://api2.warera.io/trpc/article.getArticlesPaginated');
      articleUrl.searchParams.set('input', JSON.stringify({ limit: 10, type: 'last' }));
      const feed = await options.fetcher(articleUrl.toString(), { method: 'GET' });
      const wire = await feed.json();
      expect(JSON.stringify(wire)).not.toContain('article body');
      expect(JSON.stringify(wire)).not.toContain('private body');
      expect(JSON.stringify(wire)).not.toContain('Private title');
      expect(wire).toMatchObject({ result: { data: { items: [{ _id: 'public', title: 'Public' }, { _id: 'private', isPublic: false }] } } });
    } finally { store.sqlite.close(); }
  });
});
