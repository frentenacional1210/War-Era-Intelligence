import { describe, expect, it } from 'vitest';
import { createTestDB } from './sqlite-d1';
import { historyRoute, readHistorySeries } from '../worker/history';
import type { HistorySeries } from '../shared/history';
import type { Env } from '../worker/types';

const NOW = new Date('2026-10-12T12:00:00.000Z');
function player(store: ReturnType<typeof createTestDB>) {
  store.sqlite.prepare("INSERT INTO players(id,name,source_url,updated_at,first_seen,hash,data_json) VALUES('p1','Player','https://example.test','2026-10-12','2026-01-01','h','{}')").run();
}
function capture(store: ReturnType<typeof createTestDB>, at: string, level: number) {
  store.sqlite.prepare('INSERT INTO entity_snapshots(entity_type,entity_id,captured_at,hash,data_json) VALUES(?,?,?,?,?)')
    .run('players', 'p1', at, `h-${level}`, JSON.stringify({ level }));
}
async function route(store: ReturnType<typeof createTestDB>, query: string) {
  return historyRoute(new Request(`https://example.test/api/history?${query}`), { DB: store.db } as Env);
}

describe('history pagination and complete buckets', () => {
  it('pages raw changes chronologically through more than 200 captures', async () => {
    const store = createTestDB();
    try {
      player(store);
      for (let i = 0; i < 251; i++) capture(store, new Date(Date.UTC(2026, 9, 10, 9, 0, 0, i)).toISOString(), i);
      let url = '/api/history?resource=players&id=p1&grain=raw&from=2026-10-10&to=2026-10-11&limit=100';
      const values: number[] = [];
      let pages = 0;
      while (url) {
        const response = await historyRoute(new Request(`https://example.test${url}`), { DB: store.db } as Env);
        expect(response?.status).toBe(200);
        const series = await response!.json() as HistorySeries;
        values.push(...series.points.map(point => Number(point.metrics.level)));
        expect(series.points.every(point => point.source === 'raw')).toBe(true);
        expect(series.baseline?.metrics.level).toBe(0);
        expect(series.methodologyVersion).toBe('2');
        expect(series.retention.monthMonths).toBe(24);
        expect(series.truncated).toBe(Boolean(series.nextCursor));
        url = series.nextUrl ?? '';
        pages++;
        expect(pages).toBeLessThan(5);
      }
      expect(pages).toBe(3);
      expect(values).toEqual(Array.from({ length: 251 }, (_, i) => i));
    } finally { store.sqlite.close(); }
  });

  it('counts every raw observation in a bucket and merges archived observations', async () => {
    const store = createTestDB();
    try {
      player(store);
      store.sqlite.prepare(`INSERT INTO history_rollups
        (resource,entity_id,grain,bucket_start,first_at,last_at,first_metrics_json,last_metrics_json,observations)
        VALUES('players','p1','day','2026-08-01T00:00:00.000Z','2026-08-01T07:00:00.000Z',
          '2026-08-01T07:00:00.000Z','{"level":1}','{"level":1}',1)`).run();
      store.sqlite.prepare("INSERT INTO history_baselines(resource,entity_id,first_at,metrics_json) VALUES('players','p1','2026-08-01T07:00:00.000Z','{\"level\":1}')").run();
      for (let i = 0; i < 250; i++) capture(store, `2026-08-01T${String(8 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`, i + 2);
      const series = await readHistorySeries(store.db, 'players', 'p1', '90d', NOW);
      expect(series.points).toHaveLength(1);
      expect(series.points[0].observations).toBe(251);
      expect(series.points[0].metrics.level).toBe(251);
      expect(series.points[0].source).toBe('mixed');
      expect(series.points[0].first_observed_at).toBe('2026-08-01T07:00:00.000Z');
      expect(series.archive_pending).toBe(true);
      expect(series.baseline?.metrics.level).toBe(1);
      const raw = await (await route(store, 'resource=players&id=p1&grain=raw&from=2026-08-01&to=2026-08-03'))!.json() as HistorySeries;
      const lastRaw = await (await historyRoute(new Request(`https://example.test${raw.nextUrl}`), { DB: store.db } as Env))!.json() as HistorySeries;
      expect(lastRaw.gaps.some(gap => gap.reason === 'raw-retention')).toBe(true);
    } finally { store.sqlite.close(); }
  });

  it('uses calendar week and month boundaries for raw summaries', async () => {
    const store = createTestDB();
    try {
      player(store);
      capture(store, '2026-01-31T23:00:00.000Z', 1);
      capture(store, '2026-02-01T01:00:00.000Z', 2);
      const options = { from: '2026-01-30T00:00:00.000Z', to: '2026-02-02T00:00:00.000Z' };
      const week = await readHistorySeries(store.db, 'players', 'p1', '1y', NOW, { ...options, grain: 'week' });
      expect(week.points.map(point => point.bucket_start)).toEqual(['2026-01-26T00:00:00.000Z']);
      expect(week.points[0].observations).toBe(2);
      expect(week.points[0].metrics.level).toBe(2);
      const month = await readHistorySeries(store.db, 'players', 'p1', '2y', NOW, { ...options, grain: 'month' });
      expect(month.points.map(point => point.bucket_start)).toEqual(['2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z']);
    } finally { store.sqlite.close(); }
  });

  it('pages more than 200 buckets and clips gaps to the requested bounds', async () => {
    const store = createTestDB();
    try {
      player(store);
      for (let i = 0; i < 220; i++) {
        const at = new Date(Date.UTC(2026, 0, i + 1, 12)).toISOString();
        capture(store, at, i);
      }
      const first = await route(store, 'resource=players&id=p1&grain=day&from=2026-01-01&to=2026-09-01&limit=75');
      expect(first?.status).toBe(200);
      let page = await first!.json() as HistorySeries;
      const values: number[] = [];
      while (true) {
        values.push(...page.points.map(point => Number(point.metrics.level)));
        if (!page.nextUrl) break;
        page = await (await historyRoute(new Request(`https://example.test${page.nextUrl}`), { DB: store.db } as Env))!.json() as HistorySeries;
      }
      expect(values).toEqual(Array.from({ length: 220 }, (_, i) => i));
      expect(page.gaps.every(gap => gap.from >= page.from && gap.to <= page.to)).toBe(true);
      expect(page.gaps.at(-1)?.to).toBe('2026-09-01T23:59:59.999Z');
    } finally { store.sqlite.close(); }
  });

  it('flags an archived bucket whose last value is beyond the requested end', async () => {
    const store = createTestDB();
    try {
      player(store);
      store.sqlite.prepare(`INSERT INTO history_rollups
        (resource,entity_id,grain,bucket_start,first_at,last_at,first_metrics_json,last_metrics_json,observations)
        VALUES('players','p1','day','2026-08-01T00:00:00.000Z','2026-08-01T08:00:00.000Z',
          '2026-08-01T12:00:00.000Z','{"level":1}','{"level":2}',2)`).run();
      const response = await route(store, 'resource=players&id=p1&grain=day&from=2026-08-01T07%3A00%3A00.000Z&to=2026-08-01T10%3A00%3A00.000Z');
      const result = await response!.json() as HistorySeries;
      expect(result.points).toEqual([]);
      expect(result.boundaryLimited).toBe(true);
      expect(result.methodology).toContain('omitted');
    } finally { store.sqlite.close(); }
  });

  it('marks empty daily intervals after daily retention without hiding monthly evidence', async () => {
    const store = createTestDB();
    try {
      player(store);
      store.sqlite.prepare(`INSERT INTO history_baselines(resource,entity_id,first_at,metrics_json)
        VALUES('players','p1','2025-10-01T09:00:00.000Z','{"level":1}')`).run();
      store.sqlite.prepare(`INSERT INTO history_rollups
        (resource,entity_id,grain,bucket_start,first_at,last_at,first_metrics_json,last_metrics_json,observations)
        VALUES('players','p1','month','2025-11-01T00:00:00.000Z','2025-11-02T09:00:00.000Z',
          '2025-11-20T09:00:00.000Z','{"level":2}','{"level":3}',2)`).run();
      const daily = await readHistorySeries(store.db, 'players', 'p1', '1y', NOW, { grain: 'day' });
      expect(daily.baseline?.observed_at).toBe('2025-10-01T09:00:00.000Z');
      expect(daily.points).toEqual([]);
      expect(daily.gaps.some(gap => gap.from.startsWith('2025-11') && gap.reason === 'resolution-retention')).toBe(true);
      const monthly = await readHistorySeries(store.db, 'players', 'p1', '1y', NOW, { grain: 'month' });
      expect(monthly.points.map(point => point.metrics.level)).toEqual([3]);
    } finally { store.sqlite.close(); }
  });

  it('rejects malformed windows, limits, duplicate parameters and mismatched cursors', async () => {
    const store = createTestDB();
    try {
      player(store);
      capture(store, '2026-10-10T09:00:00.000Z', 1);
      capture(store, '2026-10-10T10:00:00.000Z', 2);
      for (const query of [
        'resource=players&id=p1&grain=hour', 'resource=players&id=p1&limit=201',
        'resource=players&id=p1&limit=0', 'resource=players&id=p1&from=2026-02-30',
        'resource=players&id=p1&from=2026-10-12&to=2026-10-11',
        'resource=players&id=p1&resource=markets', 'resource=players&id=p1&cursor=broken',
        'resource=players&id=p1&unknown=x',
      ]) expect((await route(store, query))?.status).toBe(400);
      const first = await (await route(store, 'resource=players&id=p1&grain=raw&from=2026-10-10&to=2026-10-11&limit=1'))!.json() as HistorySeries;
      expect(first.nextCursor).toBeTruthy();
      expect(first.entityName).toBe('Player');
      expect(first.sourceUrl).toBe('https://example.test');
      expect(first.sourceMeaning).toBe('current-entity-source');
      expect((await route(store, `resource=players&id=p1&grain=day&from=2026-10-10&to=2026-10-11&cursor=${first.nextCursor}`))?.status).toBe(400);
      expect((await route(store, `resource=players&id=p1&grain=raw&from=2026-10-09&to=2026-10-11&cursor=${first.nextCursor}`))?.status).toBe(400);
      const head = await historyRoute(new Request('https://example.test/api/history?resource=players&id=p1', { method: 'HEAD' }), { DB: store.db } as Env);
      expect(head?.status).toBe(200);
      expect(await head?.text()).toBe('');
      const preflight = await historyRoute(new Request('https://example.test/api/history', { method: 'OPTIONS' }), { DB: store.db } as Env);
      expect(preflight?.status).toBe(204);
    } finally { store.sqlite.close(); }
  });
});
