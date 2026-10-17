import { describe, expect, it } from 'vitest';
import { createTestDB } from './sqlite-d1';
import { ACTIVITY_WEEKS, activityRoute, readActivity } from '../worker/activity';
import type { Env } from '../worker/types';

const NOW = new Date('2026-10-18T12:00:00.000Z'); // Sunday; its week starts Monday 12 Oct.

describe('weekly observable activity', () => {
  it('buckets first captures and latest connections by UTC Monday weeks, optionally per country', async () => {
    const store = createTestDB();
    try {
      const insert = store.sqlite.prepare('INSERT INTO players(id,name,country_id,last_active_at,source_url,updated_at,first_seen,hash,data_json) VALUES(?,?,?,?,?,?,?,?,?)');
      insert.run('p1', 'A', 'es', '2026-10-18T09:00:00.000Z', 'u', 'x', '2026-10-12T10:00:00.000Z', 'h', '{}');
      insert.run('p2', 'B', 'es', '2026-10-11T23:59:00.000Z', 'u', 'x', '2026-10-13T10:00:00.000Z', 'h', '{}');
      insert.run('p3', 'C', 'fr', '2026-10-14T00:00:00.000Z', 'u', 'x', '2026-10-14T10:00:00.000Z', 'h', '{}');
      insert.run('p4', 'D', 'fr', null, 'u', 'x', '2026-06-01T10:00:00.000Z', 'h', '{}');
      const all = await readActivity(store.db, null, NOW);
      expect(all.weeks).toHaveLength(ACTIVITY_WEEKS);
      expect(all.weeks.at(-1)).toEqual({ weekStart: '2026-10-12', joined: 3, lastSeen: 2 });
      expect(all.weeks.at(-2)).toEqual({ weekStart: '2026-10-05', joined: 0, lastSeen: 1 });
      expect(all.totalCaptured).toBe(4);
      const spain = await readActivity(store.db, 'es', NOW);
      expect(spain.weeks.at(-1)).toEqual({ weekStart: '2026-10-12', joined: 2, lastSeen: 1 });
      expect(spain.totalCaptured).toBe(2);
      expect((await activityRoute(new Request('https://wint.test/api/activity?country=bad%20id'), { DB: store.db } as Env))?.status).toBe(400);
    } finally { store.sqlite.close(); }
  });
});
