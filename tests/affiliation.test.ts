import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDB } from './sqlite-d1';
import { runSync } from '../worker/ingestion';
import { projectPlayer } from '../shared/public-projection';
import type { Env } from '../worker/types';

afterEach(() => vi.unstubAllGlobals());

describe('player affiliation observations', () => {
  it('keeps a known party when a lite profile omits it, then clears an explicit null without a false departure alert', async () => {
    const store = createTestDB();
    const env = { DB: store.db } as Env;
    store.sqlite.exec(`INSERT INTO countries(id,name,code,source_url,updated_at,first_seen,hash,data_json)
      VALUES('es','Spain','es','https://example.test','2026-01-01','2026-01-01','country','{}')`);
    const profiles = [
      projectPlayer({ _id: 'player-one', username: 'Player One', country: 'es', party: 'party-one', leveling: { level: 3 } }),
      { _id: 'player-one', username: 'Player One', country: 'es', leveling: { level: 3 } },
      { _id: 'player-one', username: 'Player One', country: 'es', party: null, leveling: { level: 3 } },
    ];
    let observation = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === 'POST') {
        expect(url.pathname).toContain('user.getUserLite');
        expect(JSON.parse(String(init.body))).toEqual({ '0': { userId: 'player-one' } });
        return Response.json([{ result: { data: profiles[observation++] } }]);
      }
      expect(url.pathname).toContain('user.getUsersByCountry');
      return Response.json({ result: { data: { items: [{ _id: 'player-one' }], nextCursor: `next-${observation + 1}` } } });
    }) as typeof fetch;
    try {
      expect(await runSync(env, { source: 'players', force: true, fetcher })).toMatchObject({ status: 'ok', changed: 1 });
      const first = store.sqlite.prepare("SELECT party_id FROM players WHERE id='player-one'").get();
      expect(first?.party_id).toBe('party-one');
      expect(await runSync(env, { source: 'players', force: true, fetcher })).toMatchObject({ status: 'ok', changed: 0 });
      expect(store.sqlite.prepare("SELECT party_id FROM players WHERE id='player-one'").get()?.party_id).toBe('party-one');
      expect(store.sqlite.prepare("SELECT COUNT(*) count FROM entity_snapshots WHERE entity_type='players' AND entity_id='player-one'").get()?.count).toBe(1);
      expect(store.sqlite.prepare("SELECT COUNT(*) count FROM events WHERE event_type='player-party'").get()?.count).toBe(0);
      expect(await runSync(env, { source: 'players', force: true, fetcher })).toMatchObject({ status: 'ok', changed: 1 });
      expect(store.sqlite.prepare("SELECT party_id FROM players WHERE id='player-one'").get()?.party_id).toBeNull();
      const snapshots = store.sqlite.prepare("SELECT json_extract(data_json,'$.party_id') party FROM entity_snapshots WHERE entity_type='players' AND entity_id='player-one' ORDER BY id").all();
      expect(snapshots.map(row => row.party)).toEqual(['party-one', null]);
      expect(store.sqlite.prepare("SELECT COUNT(*) count FROM events WHERE event_type='player-party'").get()?.count).toBe(0);
      expect(observation).toBe(3);
    } finally { store.sqlite.close(); }
  });
});
