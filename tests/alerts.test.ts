import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestDB } from './sqlite-d1';
import { alertsRoute } from '../worker/alerts';
import type { Env } from '../worker/types';

function setup() {
  const store = createTestDB();
  return { ...store, env: { DB: store.db } as Env };
}
const sourceUrl = 'https://api2.warera.io/trpc/test';
function capture(store: ReturnType<typeof setup>, type: string, id: string, at: string, data: Record<string, unknown>) {
  store.sqlite.prepare('INSERT INTO entity_snapshots(entity_type,entity_id,captured_at,hash,data_json) VALUES(?,?,?,?,?)')
    .run(type, id, at, `${type}:${id}:${at}`, JSON.stringify({ ...data, source_url: sourceUrl }));
}
const events = (store: ReturnType<typeof setup>) => store.sqlite.prepare('SELECT id,event_type,data_json FROM events ORDER BY id').all() as
  { id: string; event_type: string; data_json: string }[];
function battle(store: ReturnType<typeof setup>, id: string, firstSeen: string) {
  store.sqlite.prepare(`INSERT INTO battles(id,name,country_id,is_active,source_url,updated_at,first_seen,hash,data_json)
    VALUES(?,'Battle','es',1,?,?,?,'h','{}')`).run(id, sourceUrl, firstSeen, firstSeen);
}

describe('deterministic captured-change alerts', () => {
  it('honors independent events and alerts source switches during ingestion', () => {
    const store = setup();
    try {
      store.sqlite.prepare("UPDATE source_registry SET enabled=0 WHERE id='events'").run();
      capture(store, 'players', 'u1', '2026-01-01', { countryId: 'es', party_id: 'p1' });
      capture(store, 'players', 'u1', '2026-01-02', { countryId: 'fr', party_id: 'p2' });
      expect(events(store)).toHaveLength(0);
      store.sqlite.prepare("UPDATE source_registry SET enabled=1 WHERE id='events'").run();
      store.sqlite.prepare("UPDATE source_registry SET enabled=0 WHERE id='alerts'").run();
      capture(store, 'players', 'u1', '2026-01-03', { countryId: 'de', party_id: 'p3' });
      expect(events(store).map(row => row.event_type).sort()).toEqual(['player-country', 'player-party']);
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM alerts').get()?.n).toBe(0);
      store.sqlite.prepare("UPDATE source_registry SET enabled=1 WHERE id='alerts'").run();
      capture(store, 'players', 'u1', '2026-01-04', { countryId: 'it', party_id: 'p4' });
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM alerts').get()?.n).toBe(2);
    } finally { store.sqlite.close(); }
  });

  it('replaces installed triggers without losing existing event or alert records', () => {
    const store = setup();
    try {
      capture(store, 'articles', 'a1', '2026-01-01', { countryId: 'es', title: 'Market bulletin' });
      expect(events(store)).toHaveLength(1);
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM alerts').get()?.n).toBe(1);
      store.sqlite.exec(readFileSync('migrations/0013_alert_source_switches.sql', 'utf8'));
      expect(events(store)).toHaveLength(1);
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM alerts').get()?.n).toBe(1);
      store.sqlite.prepare("UPDATE source_registry SET enabled=0 WHERE id IN ('events','alerts')").run();
      capture(store, 'articles', 'a2', '2026-01-02', { countryId: 'es', title: 'Election bulletin' });
      expect(events(store)).toHaveLength(1);
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM alerts').get()?.n).toBe(1);
    } finally { store.sqlite.close(); }
  });

  it('uses bounded preceding-observation indexes in trigger lookups', () => {
    const store = setup();
    try {
      const snapshotPlan = store.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT id FROM entity_snapshots
        WHERE entity_type=? AND entity_id=? AND id<? ORDER BY id DESC LIMIT 1`).all('players', 'u1', 999)
        .map(row => String(row.detail)).join(' ');
      const pricePlan = store.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT id FROM market_prices
        WHERE item_id=? AND country_id IS NULL AND price>0 AND id<? ORDER BY id DESC LIMIT 1`).all('steel', 999)
        .map(row => String(row.detail)).join(' ');
      const governmentPlan = store.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT id FROM entity_snapshots
        WHERE entity_type='governments' AND json_extract(data_json,'$.countryId')=? AND id<? ORDER BY id DESC LIMIT 1`).all('es', 999)
        .map(row => String(row.detail)).join(' ');
      expect(snapshotPlan).toContain('idx_snapshots_previous');
      expect(pricePlan).toContain('idx_prices_previous');
      expect(governmentPlan).toContain('idx_government_snapshots_country');
    } finally { store.sqlite.close(); }
  });
  it('alerts only on a price move strictly above 20% against the previous nonzero quote', () => {
    const store = setup();
    try {
      store.sqlite.exec(`INSERT INTO market_items(id,name,source_url,updated_at,first_seen,hash,data_json)
        VALUES('steel','Steel','${sourceUrl}','2026-01-01','2026-01-01','h','{}')`);
      const add = (price: number, at: string) => store.sqlite.prepare('INSERT INTO market_prices(item_id,country_id,price,captured_at,source_url) VALUES(?,NULL,?,?,?)')
        .run('steel', price, at, sourceUrl);
      add(100, '2026-01-01');
      add(120, '2026-01-02');
      expect(events(store)).toHaveLength(0);
      add(145, '2026-01-03');
      expect(events(store)).toHaveLength(1);
      expect(events(store)[0].event_type).toBe('price-move');
      expect(JSON.parse(events(store)[0].data_json)).toMatchObject({ before: { price: 120 }, after: { price: 145 },
        verification: 'two-public-price-observations' });
      add(145, '2026-01-04');
      expect(events(store)).toHaveLength(1);
      add(0, '2026-01-05');
      expect(events(store)).toHaveLength(1);
      add(150, '2026-01-06');
      expect(events(store)).toHaveLength(1);
      expect(store.sqlite.prepare("SELECT record_count,status,enabled FROM source_registry WHERE id='alerts'").get())
        .toMatchObject({ record_count: 1, status: 'ok', enabled: 1 });
    } finally { store.sqlite.close(); }
  });

  it('never alerts on newly discovered players and requires two known transition endpoints', () => {
    const store = setup();
    try {
      capture(store, 'players', 'u1', '2026-01-01', { countryId: 'es', party_id: 'p1', military_unit_id: 'm1' });
      expect(events(store)).toHaveLength(0);
      capture(store, 'players', 'u1', '2026-01-02', { countryId: 'fr', party_id: 'p2', military_unit_id: 'm2' });
      expect(events(store).map(row => row.event_type).sort()).toEqual(['player-country', 'player-party', 'player-unit']);
      capture(store, 'players', 'u1', '2026-01-03', { countryId: null, party_id: null, military_unit_id: null });
      expect(events(store)).toHaveLength(3);
      expect(store.sqlite.prepare("SELECT record_count FROM source_registry WHERE id='events'").get()).toMatchObject({ record_count: 3 });
    } finally { store.sqlite.close(); }
  });

  it('uses captured region, government, membership, election, and title facts', () => {
    const store = setup();
    try {
      capture(store, 'regions', 'r1', '2026-01-01', { country: 'es', countryId: 'es' });
      capture(store, 'regions', 'r1', '2026-01-02', { country: 'fr', countryId: 'fr' });
      capture(store, 'governments', 'g1', '2026-01-01', { countryId: 'es', president: 'u1' });
      capture(store, 'governments', 'g1', '2026-01-02', { countryId: 'es', president: 'u2' });
      capture(store, 'governments', 'g2', '2026-01-03', { countryId: 'es', president: 'u3' });
      capture(store, 'parties', 'p1', '2026-01-01', { countryId: 'es', memberCount: 10 });
      capture(store, 'parties', 'p1', '2026-01-02', { countryId: 'es', memberCount: 14 });
      capture(store, 'parties', 'p1', '2026-01-03', { countryId: 'es', memberCount: 19 });
      capture(store, 'elections', 'e1', '2026-01-01', { countryId: 'es', isActive: true, status: 'voting' });
      capture(store, 'elections', 'e1', '2026-01-02', { countryId: 'es', isActive: false, status: 'finished', votesCount: 3 });
      capture(store, 'articles', 'a1', '2026-01-02', { countryId: 'es', title: 'Election roundup', content: 'BODY MUST NEVER APPEAR' });
      capture(store, 'articles', 'a1', '2026-01-03', { countryId: 'es', title: 'Election roundup', views: 99 });
      const types = events(store).map(row => row.event_type).sort();
      expect(types).toEqual(['article-keyword', 'election-finished', 'government-leader', 'government-leader', 'member-growth', 'region-country']);
      const region = events(store).find(row => row.event_type === 'region-country')!;
      expect(JSON.parse(region.data_json)).toMatchObject({ before: { country: 'es' }, after: { country: 'fr' } });
      expect(events(store).find(row => row.event_type === 'article-keyword')!.data_json).not.toContain('BODY MUST NEVER APPEAR');
      expect(store.sqlite.prepare('SELECT COUNT(*) count FROM alerts').get()).toMatchObject({ count: 6 });
      store.sqlite.exec("DELETE FROM entity_snapshots WHERE entity_type='elections' AND entity_id='e1'");
      capture(store, 'elections', 'e1', '2026-02-01', { countryId: 'es', isActive: false, status: 'finished', votesCount: 4 });
      expect(events(store).filter(row => row.event_type === 'election-finished')).toHaveLength(1);
    } finally { store.sqlite.close(); }
  });

  it('requires explicit inactive battle evidence and does not repeat an end', () => {
    const store = setup();
    try {
      battle(store, 'b1', '2026-01-01');
      capture(store, 'battles', 'b1', '2026-01-01', { countryId: 'es', isActive: true });
      capture(store, 'battles', 'b1', '2026-01-02', { countryId: 'es', isActive: false, endedAt: '2026-01-02' });
      capture(store, 'battles', 'b1', '2026-01-03', { countryId: 'es', isActive: false, endedAt: '2026-01-02', wonBy: 'attacker' });
      capture(store, 'battles', 'b2', '2026-01-01', { countryId: 'es', isActive: false });
      expect(events(store).map(row => row.event_type).sort()).toEqual(['battle-inactive', 'battle-observed']);
      const end = events(store).find(row => row.event_type === 'battle-inactive')!;
      expect(JSON.parse(end.data_json)).toMatchObject({ after: { isActive: 0, endedAt: '2026-01-02' } });
      store.sqlite.exec("DELETE FROM entity_snapshots WHERE entity_type='battles' AND entity_id='b1'");
      capture(store, 'battles', 'b1', '2026-02-01', { countryId: 'es', isActive: true });
      expect(events(store).filter(row => row.event_type === 'battle-observed')).toHaveLength(1);
    } finally { store.sqlite.close(); }
  });

  it('serves a bounded, filterable, read-only sourced feed', async () => {
    const store = setup();
    try {
      battle(store, 'b1', '2026-01-01T00:00:00.000Z');
      capture(store, 'battles', 'b1', '2026-01-01T00:00:00.000Z', { countryId: 'es', isActive: true });
      capture(store, 'articles', 'a1', '2026-01-02T00:00:00.000Z', { countryId: 'fr', title: 'Market report' });
      const response = await alertsRoute(new Request('https://test/api/alerts/feed?country=es&theme=military&severity=notable&limit=1'), store.env);
      expect(response?.status).toBe(200);
      expect(response?.headers.get('Cache-Control')).toBe('no-store');
      const body = await response!.json() as Record<string, any>;
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({ theme: 'military', countryId: 'es', sourceUrl });
      expect((await alertsRoute(new Request('https://test/api/alerts/feed?theme=__proto__'), store.env))?.status).toBe(400);
      expect((await alertsRoute(new Request('https://test/api/alerts/feed?limit=51'), store.env))?.status).toBe(400);
      expect((await alertsRoute(new Request('https://test/api/alerts/feed', { method: 'POST' }), store.env))?.status).toBe(405);
    } finally { store.sqlite.close(); }
  });
});
