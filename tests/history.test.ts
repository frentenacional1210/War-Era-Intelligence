import { describe, expect, it } from 'vitest';
import { createTestDB } from './sqlite-d1';
import { prepareHistoryMaintenance, readHistorySeries, historyRoute } from '../worker/history';
import { HISTORY_FIELDS, historyMetrics } from '../shared/history';
import { normalizeExtendedEntity } from '../worker/extended-ingestion';
import { WarEraClient } from '../worker/warera';
import type { Env } from '../worker/types';

const NOW = new Date('2026-10-12T12:00:00.000Z');
const insertPlayer = (store: ReturnType<typeof createTestDB>, capturedAt: string, level: number) =>
  store.sqlite.prepare('INSERT INTO entity_snapshots(entity_type,entity_id,captured_at,hash,data_json) VALUES(?,?,?,?,?)')
    .run('players', 'p1', capturedAt, `h-${capturedAt}`, JSON.stringify({ level, experience: level * 100, damagesCount: level * 2 }));

describe('historical rollups', () => {
  it('archives old changes atomically into all three grains and retains the earliest actual baseline', async () => {
    const store = createTestDB();
    try {
      insertPlayer(store, '2026-08-01T08:00:00.000Z', 1);
      insertPlayer(store, '2026-08-01T10:00:00.000Z', 2);
      store.sqlite.prepare("INSERT INTO market_items(id,name,country_id,source_url,updated_at,first_seen,hash,data_json) VALUES('iron','Iron',NULL,'https://example.test','2026-08-01','2026-08-01','h','{}')").run();
      store.sqlite.prepare('INSERT INTO market_prices(item_id,country_id,price,captured_at,source_url) VALUES(?,?,?,?,?)')
        .run('iron', null, 12, '2026-08-01T09:00:00.000Z', 'https://example.test');
      store.sqlite.prepare('INSERT INTO market_prices(item_id,country_id,price,captured_at,source_url) VALUES(?,?,?,?,?)')
        .run('iron', null, 14, '2026-10-11T09:00:00.000Z', 'https://example.test');
      store.sqlite.prepare("INSERT INTO market_items(id,name,country_id,source_url,updated_at,first_seen,hash,data_json) VALUES('copper','Copper',NULL,'https://example.test','2026-08-01','2026-08-01','c','{}')").run();
      store.sqlite.prepare('INSERT INTO market_prices(item_id,country_id,price,captured_at,source_url) VALUES(?,?,?,?,?)')
        .run('copper', null, 7, '2026-08-01T09:00:00.000Z', 'https://example.test');
    } catch (error) { store.sqlite.close(); throw error; }
    try {
      const plan = await prepareHistoryMaintenance(store.db, NOW);
      const staleConcurrentPlan = await prepareHistoryMaintenance(store.db, NOW);
      expect(plan.selectedSnapshots).toBe(2);
      expect(plan.selectedPrices).toBe(1);
      expect(plan.statements.length).toBeLessThan(12);
      await store.db.batch(plan.statements);
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM entity_snapshots').get()?.n).toBe(0);
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM market_prices').get()?.n).toBe(2);
      expect(store.sqlite.prepare('SELECT price FROM market_prices WHERE item_id=?').get('iron')?.price).toBe(14);
      expect((await readHistorySeries(store.db, 'markets', 'copper', '90d', NOW)).points.map(p => p.metrics.price)).toEqual([7]);
      const daily = store.sqlite.prepare("SELECT observations,first_at,last_at,first_metrics_json,last_metrics_json FROM history_rollups WHERE resource='players' AND entity_id='p1' AND grain='day'").get()!;
      expect(daily.observations).toBe(2);
      expect(daily.first_at).toBe('2026-08-01T08:00:00.000Z');
      expect(daily.last_at).toBe('2026-08-01T10:00:00.000Z');
      expect(JSON.parse(String(daily.first_metrics_json)).level).toBe(1);
      expect(JSON.parse(String(daily.last_metrics_json)).level).toBe(2);
      expect(store.sqlite.prepare("SELECT COUNT(*) n FROM history_rollups WHERE resource='players'").get()?.n).toBe(3);
      expect(store.sqlite.prepare("SELECT COUNT(*) n FROM history_rollups WHERE resource='markets'").get()?.n).toBe(3);
      expect(store.sqlite.prepare("SELECT first_at FROM history_baselines WHERE resource='players' AND entity_id='p1'").get()?.first_at).toBe('2026-08-01T08:00:00.000Z');
      await store.db.batch(staleConcurrentPlan.statements);
      expect(store.sqlite.prepare("SELECT observations FROM history_rollups WHERE resource='players' AND grain='day'").get()?.observations).toBe(2);
      const repeated = await prepareHistoryMaintenance(store.db, NOW);
      expect(repeated.selectedSnapshots + repeated.selectedPrices).toBe(0);
      await store.db.batch(repeated.statements);
      expect(store.sqlite.prepare("SELECT observations FROM history_rollups WHERE resource='players' AND grain='day'").get()?.observations).toBe(2);
    } finally { store.sqlite.close(); }
  });

  it('keeps source observations when a rollup transaction fails', async () => {
    const store = createTestDB();
    try {
      insertPlayer(store, '2026-08-01T08:00:00.000Z', 1);
      const plan = await prepareHistoryMaintenance(store.db, NOW);
      const failure = store.db.prepare("INSERT INTO countries(id,name,source_url,updated_at,first_seen,hash,data_json) VALUES('x','X','x','x','x','x','x'),('x','X','x','x','x','x','x')");
      await expect(store.db.batch([...plan.statements, failure])).rejects.toThrow();
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM entity_snapshots').get()?.n).toBe(1);
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM history_rollups').get()?.n).toBe(0);
    } finally { store.sqlite.close(); }
  });

  it('expires only bounded old tiers while keeping the 24-month monthly horizon and baseline', async () => {
    const store = createTestDB();
    try {
      const insert = store.sqlite.prepare(`INSERT INTO history_rollups
        (resource,entity_id,grain,bucket_start,first_at,last_at,first_metrics_json,last_metrics_json,observations)
        VALUES('players','p1',?,?,?,?,?,?,1)`);
      for (const grain of ['day', 'week', 'month']) {
        insert.run(grain, '2024-09-01T00:00:00.000Z', '2024-09-01T00:00:00.000Z', '2024-09-01T00:00:00.000Z', '{}', '{}');
      }
      insert.run('month', '2024-10-01T00:00:00.000Z', '2024-10-01T00:00:00.000Z', '2024-10-01T00:00:00.000Z', '{}', '{}');
      store.sqlite.prepare("INSERT INTO history_baselines(resource,entity_id,first_at,metrics_json) VALUES('players','p1','2024-09-01T00:00:00.000Z','{}')").run();
      await store.db.batch((await prepareHistoryMaintenance(store.db, NOW, 0)).statements);
      expect(store.sqlite.prepare('SELECT grain,bucket_start FROM history_rollups ORDER BY grain,bucket_start').all())
        .toEqual([{ grain: 'month', bucket_start: '2024-10-01T00:00:00.000Z' }]);
      expect(store.sqlite.prepare("SELECT first_at FROM history_baselines WHERE resource='players' AND entity_id='p1'").get()?.first_at)
        .toBe('2024-09-01T00:00:00.000Z');
    } finally { store.sqlite.close(); }
  });

  it('serves chronological observed values, marks gaps, validates IDs, and never fills missing metrics', async () => {
    const store = createTestDB();
    try {
      store.sqlite.prepare("INSERT INTO players(id,name,source_url,updated_at,first_seen,hash,data_json) VALUES('p1','Player','x','2026-10-12','2026-08-01','h','{}')").run();
      insertPlayer(store, '2026-08-01T08:00:00.000Z', 1);
      await store.db.batch((await prepareHistoryMaintenance(store.db, NOW)).statements);
      insertPlayer(store, '2026-10-10T08:00:00.000Z', 4);
      const series = await readHistorySeries(store.db, 'players', 'p1', '90d', NOW);
      expect(series.points.map(p => p.metrics.level)).toEqual([1, 4]);
      expect(series.points.map(p => p.observed_at)).toEqual(['2026-08-01T08:00:00.000Z', '2026-10-10T08:00:00.000Z']);
      expect(series.baseline?.metrics.level).toBe(1);
      expect(series.gaps.some(gap => gap.reason === 'no-observation')).toBe(true);
      expect(series.points.every(p => p.method === 'bucket-last')).toBe(true);
      const response = await historyRoute(new Request('https://example.test/api/history?resource=players&id=p1&period=90d'), { DB: store.db } as Env);
      expect(response?.status).toBe(200);
      expect((await historyRoute(new Request('https://example.test/api/history?resource=players&id=%20p1&period=90d'), { DB: store.db } as Env))?.status).toBe(400);
      expect(historyMetrics('players', { level: undefined }).level).toBeNull();
      expect(historyMetrics('regions', { country: 'es' }).country_id).toBe('es');
    } finally { store.sqlite.close(); }
  });

  it('archives public extended snapshots atomically and reads their actual metrics with unobserved gaps', async () => {
    const store = createTestDB();
    const client = new WarEraClient();
    const oldAt = '2026-08-01T08:00:00.000Z', newAt = '2026-10-10T08:00:00.000Z';
    const originals = {
      companies: normalizeExtendedEntity('companies', { _id: 'company-1', name: 'Foundry', country: 'es', user: 'owner-1',
        region: 'region-1', itemCode: 'steel', production: 20, workerCount: 4, estimatedValue: 300,
        concreteInvested: 100, isFull: false, activeUpgradeLevels: { storage: 1, automatedEngine: 2, breakRoom: 0 } }, client, oldAt),
      elections: normalizeExtendedEntity('elections', { _id: 'election-1', country: 'es', type: 'president', status: 'active',
        isActive: true, votesCount: 22, votesStartAt: oldAt }, client, oldAt),
      governments: normalizeExtendedEntity('governments', { _id: 'government-1', country: 'es', president: 'president-1',
        vicePresident: 'vice-1', minOfDefense: 'defense-1', minOfEconomy: 'economy-1',
        minOfForeignAffairs: 'foreign-1', congressMembers: ['member-1', 'member-2'] }, client, oldAt),
    };
    const insertMain = (table: string) => store.sqlite.prepare(`INSERT INTO ${table}(id,name,country_id,source_url,updated_at,first_seen,hash,data_json)
      VALUES(?,?,?,?,?,?,?,?)`);
    const insertSnapshot = store.sqlite.prepare('INSERT INTO entity_snapshots(entity_type,entity_id,captured_at,hash,data_json) VALUES(?,?,?,?,?)');
    try {
      for (const [resource, row] of Object.entries(originals)) {
        insertMain(resource)
          .run(row.id,row.name,row.country_id,row.source_url,row.updated_at,row.updated_at,`main-${resource}`,row.data_json);
        insertSnapshot.run(resource,row.id,oldAt,`old-${resource}`,row.data_json);
      }
      for (const [resource,id,data] of [
        ['battles','battle-1',{ isActive: true, currentRound: 1, attackerDamages: 4, defenderDamages: 2, endedAt: null, wonBy: null }],
        ['military-units','unit-1',{ level: 2, memberCount: 10, monthlyDamages: 120 }],
      ] as const) {
        insertMain(resource === 'military-units' ? 'military_units' : resource)
          .run(id,id,'es','https://example.test',oldAt,oldAt,`main-${resource}`,JSON.stringify(data));
        insertSnapshot.run(resource,id,oldAt,`old-${resource}`,JSON.stringify(data));
      }
      const plan = await prepareHistoryMaintenance(store.db, NOW);
      expect(plan.selectedSnapshots).toBe(5);
      const duplicate = store.db.prepare("INSERT INTO countries(id,name,source_url,updated_at,first_seen,hash,data_json) VALUES('x','X','x','x','x','x','x'),('x','X','x','x','x','x','x')");
      await expect(store.db.batch([...plan.statements, duplicate])).rejects.toThrow();
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM entity_snapshots').get()?.n).toBe(5);
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM history_rollups').get()?.n).toBe(0);
      await store.db.batch(plan.statements);
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM entity_snapshots').get()?.n).toBe(0);

      const newCompany = normalizeExtendedEntity('companies', { _id: 'company-1', name: 'Foundry', country: 'es', updatedAt: oldAt,
        production: 31, workerCount: 5, estimatedValue: 350, activeUpgradeLevels: { storage: 2 } }, client, newAt);
      expect(newCompany.updated_at).toBe(newAt);
      const newElection = normalizeExtendedEntity('elections', { _id: 'election-1', country: 'es', type: 'president',
        status: 'finished', isActive: false, votesCount: 55, electedCount: 1 }, client, newAt);
      const newGovernment = normalizeExtendedEntity('governments', { _id: 'government-1', country: 'es',
        president: 'president-2' }, client, newAt);
      for (const [resource,row] of Object.entries({ companies: newCompany, elections: newElection, governments: newGovernment }))
        insertSnapshot.run(resource,row.id,newAt,`new-${resource}`,row.data_json);
      insertSnapshot.run('battles','battle-1',newAt,'new-battle',JSON.stringify({ isActive: false, currentRound: 2,
        endedAt: newAt, wonBy: 'attacker' }));
      insertSnapshot.run('military-units','unit-1',newAt,'new-unit',JSON.stringify({ level: 2, memberCount: 10, monthlyDamages: 180 }));

      for (const [resource,id] of [['companies','company-1'],['elections','election-1'],['governments','government-1'],
        ['battles','battle-1'],['military-units','unit-1']] as const) {
        const series = await readHistorySeries(store.db, resource, id, '90d', NOW);
        expect(series.points.map(point => point.observed_at)).toEqual([oldAt,newAt]);
        expect(series.gaps.some(gap => gap.reason === 'no-observation')).toBe(true);
        expect(Object.keys(series.points[0].metrics)).toEqual(HISTORY_FIELDS[resource]);
      }
      expect((await readHistorySeries(store.db,'companies','company-1','90d',NOW)).points.map(point => point.metrics.production)).toEqual([20,31]);
      expect((await readHistorySeries(store.db,'elections','election-1','90d',NOW)).points.map(point => point.metrics.elected_count)).toEqual([null,1]);
      expect((await readHistorySeries(store.db,'governments','government-1','90d',NOW)).points.map(point => point.metrics.congress_count)).toEqual([2,null]);
      expect((await readHistorySeries(store.db,'battles','battle-1','90d',NOW)).points.map(point => point.metrics.ended_at)).toEqual([null,newAt]);
      expect((await readHistorySeries(store.db,'military-units','unit-1','90d',NOW)).points.map(point => point.metrics.monthly_damages)).toEqual([120,180]);
      for (const [resource,id] of [['companies','company-1'],['elections','election-1'],['governments','government-1']] as const)
        expect((await historyRoute(new Request(`https://example.test/api/history?resource=${resource}&id=${id}&period=90d`),{ DB: store.db } as Env))?.status).toBe(200);
    } finally { store.sqlite.close(); }
  });
});
