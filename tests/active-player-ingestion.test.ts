import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSync } from '../worker/ingestion';
import { collectorRoute } from '../worker/collector';
import { createTestDB } from './sqlite-d1';
import type { Env } from '../worker/types';
import { COLLECTOR_PLAYER_ROWS } from '../shared/ingestion-config';

afterEach(() => vi.unstubAllGlobals());
function setup() {
  const store = createTestDB();
  store.sqlite.prepare('INSERT INTO countries(id,name,source_url,updated_at,first_seen,hash,data_json) VALUES(?,?,?,?,?,?,?)')
    .run('es', 'Spain', 'https://api2.warera.io', '2026-01-01', '2026-01-01', 'hash', '{}');
  return { ...store, env: { DB: store.db } as Env };
}
describe('active-only automatic player collection', () => {
  it('persists only explicit true while advancing the original country cursor past inactive and unknown candidates', async () => {
    const store = setup();
    const profiles = [
      { _id: 'active', username: 'Active', isActive: true },
      { _id: 'inactive', username: 'Inactive', isActive: false, dates: { lastConnectionAt: new Date().toISOString() } },
      { _id: 'unknown', username: 'Unknown' }, { _id: 'null', username: 'Null', isActive: null },
    ];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
      ? Response.json(profiles.map(data => ({ result: { data } })))
      : Response.json({ result: { data: { items: profiles.map(row => ({ _id: row._id })), nextCursor: 'next-country-page' } } })));
    try {
      expect(await runSync(store.env, { source: 'players', force: true })).toMatchObject({
        status: 'ok', processed: 1, changed: 1, checkedPlayers: 4, skippedInactive: 1, skippedUnknownActivity: 2,
      });
      expect(store.sqlite.prepare('SELECT id FROM players').all()).toEqual([{ id: 'active' }]);
      expect(store.sqlite.prepare("SELECT entity_id FROM entity_snapshots WHERE entity_type='players'").all()).toEqual([{ entity_id: 'active' }]);
      expect(store.sqlite.prepare('SELECT cursor,records_observed,completed_sweeps FROM player_census_state').get())
        .toMatchObject({ cursor: 'next-country-page', records_observed: 1, completed_sweeps: 0 });
    } finally { store.sqlite.close(); }
  });

  it('completes inactive pages, detects later reactivation and preserves saved history when activity stops', async () => {
    const store = setup();
    let active = false;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
      ? Response.json([{ result: { data: { _id: 'returning', username: active ? 'Active name' : 'Inactive name',
        isActive: active, leveling: { level: active ? 3 : 999, totalXp: active ? 42 : 9999 } } } }])
      : Response.json({ result: { data: { items: [{ _id: 'returning' }], nextCursor: null } } })));
    const sweep = () => runSync(store.env, { source: 'players', force: true });
    const nextSweep = () => store.sqlite.prepare("UPDATE player_census_state SET next_run_at='1970-01-01T00:00:00.000Z'").run();
    try {
      expect(await sweep()).toMatchObject({ status: 'ok', processed: 0, checkedPlayers: 1, skippedInactive: 1 });
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM players').get()?.n).toBe(0);
      expect(store.sqlite.prepare('SELECT completed_sweeps FROM player_census_state').get()?.completed_sweeps).toBe(1);
      active = true; nextSweep();
      expect(await sweep()).toMatchObject({ status: 'ok', processed: 1, changed: 1 });
      active = false; nextSweep();
      expect(await sweep()).toMatchObject({ status: 'ok', processed: 0, changed: 0, skippedInactive: 1 });
      expect(store.sqlite.prepare('SELECT name,level,experience FROM players').get()).toMatchObject({ name: 'Active name', level: 3, experience: 42 });
      expect(store.sqlite.prepare("SELECT COUNT(*) n FROM entity_snapshots WHERE entity_type='players'").get()?.n).toBe(1);
      expect(store.sqlite.prepare('SELECT completed_sweeps FROM player_census_state').get()?.completed_sweeps).toBe(3);
    } finally { store.sqlite.close(); }
  });

  it('independently filters a compact collector commit rather than trusting its activity selection', async () => {
    const store = setup(), secret = 'test-active-collector-secret-at-least-32';
    store.env.COLLECTOR_SECRET = secret;
    vi.stubGlobal('fetch', vi.fn(() => { throw Error('No upstream access during commit'); }));
    const profiles = [{ _id: 'a', username: 'A', isActive: true }, { _id: 'b', username: 'B', isActive: false }, { _id: 'c', username: 'C' }];
    try {
      const response = await collectorRoute(new Request('https://wint.test/api/collector/commit', {
        method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'players', cursorExpected: null, input: { countryId: 'es', limit: COLLECTOR_PLAYER_ROWS },
          page: { items: profiles.map(row => ({ _id: row._id })), nextCursor: 'next' }, profiles }),
      }), store.env);
      expect(response?.status).toBe(200);
      expect(await response!.json()).toMatchObject({ status: 'ok', processed: 1, checkedPlayers: 3, skippedInactive: 1, skippedUnknownActivity: 1 });
      expect(store.sqlite.prepare('SELECT id FROM players').all()).toEqual([{ id: 'a' }]);
      expect(fetch).not.toHaveBeenCalled();
    } finally { store.sqlite.close(); }
  });
});
