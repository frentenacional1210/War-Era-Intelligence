import { describe, expect, it } from 'vitest';
import { createTestDB } from './sqlite-d1';
import { readToday, todayRoute } from '../worker/today';
import type { Env } from '../worker/types';

const NOW = new Date('2026-10-18T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

describe('daily digest', () => {
  it('groups only the last 24 hours of observed events with links, countries and articles', async () => {
    const store = createTestDB();
    try {
      const db = store.sqlite;
      db.prepare("INSERT INTO countries(id,name,code,source_url,updated_at,first_seen,hash,data_json) VALUES('es','Spain','es','u',?,?,'h','{}')").run(hoursAgo(1), hoursAgo(1));
      const event = db.prepare('INSERT INTO events(id,name,country_id,event_type,source_url,updated_at,first_seen,hash,data_json) VALUES(?,?,?,?,?,?,?,?,?)');
      event.run('e1', 'Active battle observed', 'es', 'battle-observed', 'https://warera.io/battle/b1', hoursAgo(2), hoursAgo(2), 'h', JSON.stringify({ entityType: 'battles', entityId: 'b1', severity: 'notable' }));
      event.run('e2', 'Election finished in public record', 'es', 'election-finished', 'https://warera.io/e', hoursAgo(5), hoursAgo(5), 'h', '{}');
      event.run('e3', 'Active battle observed', 'es', 'battle-observed', 'https://warera.io/battle/old', hoursAgo(30), hoursAgo(30), 'h', '{}');
      event.run('e4', 'Unknown future rule', null, 'not-in-digest', 'u', hoursAgo(1), hoursAgo(1), 'h', '{}');
      db.prepare("INSERT INTO articles(id,name,title,source_url,updated_at,first_seen,hash,data_json,published_at) VALUES('a1','T','Titular reciente','u',?,?,'h','{}',?)").run(hoursAgo(3), hoursAgo(3), hoursAgo(3));
      db.prepare("INSERT INTO articles(id,name,title,source_url,updated_at,first_seen,hash,data_json,published_at) VALUES('a2','T','Titular viejo','u',?,?,'h','{}',?)").run(hoursAgo(40), hoursAgo(40), hoursAgo(40));
      db.prepare("INSERT INTO ingestion_daily_stats(day_key,source_id,new_rows,updated_rows) VALUES('2026-10-18','players',7,3),('2026-10-17','players',2,1),('2026-10-16','players',100,100)").run();
      const digest = await readToday(store.db, NOW);
      expect(digest.sections.military).toEqual([{ id: 'e1', title: 'Active battle observed', type: 'battle-observed', countryId: 'es', countryName: 'Spain',
        observedAt: hoursAgo(2), sourceUrl: 'https://warera.io/battle/b1', entityType: 'battles', entityId: 'b1', severity: 'notable' }]);
      expect(digest.sections.politics.map(item => item.id)).toEqual(['e2']);
      expect(digest.counts).toEqual({ 'battle-observed': 1, 'election-finished': 1, 'not-in-digest': 1 });
      expect(digest.players).toEqual({ newActive: 9, updated: 4 });
      expect(digest.articles.map(article => article.title)).toEqual(['Titular reciente']);
      expect(digest.window).toEqual({ from: hoursAgo(24), to: NOW.toISOString() });
      const response = await todayRoute(new Request('https://wint.test/api/today', { method: 'POST' }), { DB: store.db } as Env);
      expect(response?.status).toBe(405);
    } finally { store.sqlite.close(); }
  });
});
