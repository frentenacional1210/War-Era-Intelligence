import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeWarEraEntity, runSync } from '../worker/ingestion';
import { WarEraClient } from '../worker/warera';
import type { Env } from '../worker/types';
import { createTestDB } from './sqlite-d1';

type Result = { meta: { changes: number } };
class MemoryDb {
  sourceId = 'countries';
  rows = new Map<string, { hash: string }>();
  snapshots = 0;
  latestSnapshotHash = new Map<string, string>();
  failOnId: string | null = null;
  failOnCleanup = false;
  denyBudget = false;
  failRunInsert = false;
  reservedWrites = 0;
  runStatuses = new Map<string, string>();
  rpcCalls = 0;
  private inBatch = false;
  onNextBatch: (() => void) | null = null;
  globalOwner: string | null = null;
  lease: string | null = null;
  cursor: string | null = null;
  due = '1970-01-01T00:00:00.000Z';
  prepare(sql: string) {
    const bound = (values: unknown[]) => ({
        first: async <T>() => {
          this.rpcCalls++;
          if (sql.includes('FROM source_registry r')) return { id: this.sourceId, endpoint: 'country.getAllCountries', interval_seconds: 86400, cursor: this.cursor, next_run_at: this.due, lease_until: this.lease } as T;
          if (sql.includes('COUNT(*)')) return { count: this.rows.size } as T;
          throw new Error(`Unexpected first: ${sql}`);
        },
        run: async (): Promise<Result> => {
          if (!this.inBatch) this.rpcCalls++;
          if (sql.startsWith('UPDATE ingestion_cursors SET lease_until=NULL')) {
            this.lease = null; return { meta: { changes: 1 } };
          }
          if (sql.startsWith('UPDATE ingestion_cursors SET lease_until')) {
            if (this.lease || this.globalOwner !== values[5]) return { meta: { changes: 0 } };
            this.lease = String(values[0]); return { meta: { changes: 1 } };
          }
          if (sql.startsWith('UPDATE ingestion_lock SET owner=?')) {
            if (this.globalOwner || this.lease || String(values[3]) !== this.sourceId
              || values[7] !== this.cursor || values[8] !== this.due) return { meta: { changes: 0 } };
            this.globalOwner = String(values[0]); return { meta: { changes: 1 } };
          }
          if (sql.startsWith('UPDATE ingestion_lock SET owner=NULL')) {
            if (this.globalOwner !== values[0]) return { meta: { changes: 0 } };
            this.globalOwner = null; return { meta: { changes: 1 } };
          }
          if (sql.startsWith('INSERT INTO ingestion_budget')) {
            if (this.denyBudget) return { meta: { changes: 0 } };
            this.reservedWrites += Number(values[1]); return { meta: { changes: 1 } };
          }
          if (sql.startsWith('INSERT INTO ingestion_runs')) {
            if (this.failRunInsert) throw new Error('simulated run insert failure');
            this.runStatuses.set(String(values[0]), String(values[3]));
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith('UPDATE ingestion_runs SET')) {
            const runId = String(values[values.length - 1]);
            if (!this.runStatuses.has(runId)) return { meta: { changes: 0 } };
            this.runStatuses.set(runId, String(values[1]));
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith('UPDATE ingestion_cursors SET cursor=')) {
            this.cursor = values[0] as string | null; this.due = String(values[1]); this.lease = null; return { meta: { changes: 1 } };
          }
          if (sql.startsWith('UPDATE ingestion_cursors SET next_run_at=')) {
            this.due = String(values[0]); this.lease = null; return { meta: { changes: 1 } };
          }
          if (sql.startsWith('INSERT INTO countries') || sql.startsWith('INSERT INTO regions') || sql.startsWith('INSERT INTO articles')) {
            const key = String(values[0]), hash = String(values[6]);
            if (key === this.failOnId) throw new Error('simulated D1 write failure');
            const previous = this.rows.get(key);
            if (previous?.hash === hash) return { meta: { changes: 0 } };
            this.rows.set(key, { hash }); return { meta: { changes: 1 } };
          }
          if (sql.startsWith('INSERT INTO entity_snapshots')) {
            const key = String(values[1]), digest = String(values[3]);
            if (this.latestSnapshotHash.get(key) !== digest) { this.snapshots++; this.latestSnapshotHash.set(key, digest); return { meta: { changes: 1 } }; }
            return { meta: { changes: 0 } };
          }
          if (sql.startsWith('DELETE FROM ingestion_runs') && this.failOnCleanup) throw new Error('simulated final batch failure');
          return { meta: { changes: 1 } };
        },
      });
    return { ...bound([]), bind: (...values: unknown[]) => bound(values) };
  }
  async batch(statements: { run: () => Promise<Result> }[]) {
    this.rpcCalls++;
    const onNextBatch = this.onNextBatch;
    this.onNextBatch = null;
    onNextBatch?.();
    const priorRows = new Map(this.rows), priorHashes = new Map(this.latestSnapshotHash), priorSnapshots = this.snapshots;
    const priorCursor = this.cursor, priorDue = this.due, priorLease = this.lease, priorOwner = this.globalOwner;
    const priorBudget = this.reservedWrites, priorRunStatuses = new Map(this.runStatuses);
    const results: Result[] = [];
    try {
      this.inBatch = true;
      for (const statement of statements) results.push(await statement.run());
      return results;
    } catch (error) {
      this.rows = priorRows; this.latestSnapshotHash = priorHashes; this.snapshots = priorSnapshots;
      this.cursor = priorCursor; this.due = priorDue; this.lease = priorLease; this.globalOwner = priorOwner;
      this.reservedWrites = priorBudget; this.runStatuses = priorRunStatuses;
      throw error;
    } finally {
      this.inBatch = false;
    }
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('incremental ingestion', () => {
  it('sanitizes labels and keeps only selected profile fields', () => {
    const client = new WarEraClient();
    const row = normalizeWarEraEntity('players', { _id: 'user1', username: '<b>Alpha</b>', country: 'country1', leveling: { level: 7, totalXp: 123 }, secret: 'not-for-storage' }, client, '2026-01-01T00:00:00.000Z');
    expect(row.name).toBe('Alpha');
    expect(row.extra).toMatchObject({ level: 7, experience: 123 });
    expect(row.data_json).not.toContain('secret');
  });

  it('keeps the last valid row and snapshot when the fetched data is unchanged', async () => {
    const database = new MemoryDb();
    let currentName = 'Spain';
    const fetcher = vi.fn(async () => Response.json({ result: { data: [{ _id: 'country1', name: currentName, code: 'es' }] } }, { headers: { 'ratelimit-remaining': '99' } }));
    vi.stubGlobal('fetch', fetcher);
    const env = { DB: database as unknown as D1Database } as Env;
    const first = await runSync(env, { source: 'countries', force: true });
    expect(first.status, JSON.stringify(first)).toBe('ok');
    expect(first).toMatchObject({ processed: 1, changed: 1 });
    expect(await runSync(env, { source: 'countries', force: true })).toMatchObject({ status: 'ok', processed: 1, changed: 0 });
    expect(database.rows.size).toBe(1);
    expect(database.snapshots).toBe(1);
    currentName = 'España';
    expect(await runSync(env, { source: 'countries', force: true })).toMatchObject({ status: 'ok', changed: 1 });
    expect(database.snapshots).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('recognizes the digest format used by rows written before the batching change', async () => {
    const database = new MemoryDb();
    const client = new WarEraClient();
    const raw = { _id: 'country1', name: 'Spain', code: 'es' };
    const row = normalizeWarEraEntity('countries', raw, client, '2026-10-11T00:00:00.000Z');
    const oldPayload = JSON.stringify({ name: row.name, country_id: row.country_id, extra: row.extra, data: JSON.parse(row.data_json) });
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(oldPayload));
    const oldHash = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    database.rows.set('country1', { hash: oldHash });
    database.latestSnapshotHash.set('country1', oldHash);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ result: { data: [raw] } })));
    const env = { DB: database as unknown as D1Database } as Env;
    expect(await runSync(env, { source: 'countries', force: true })).toMatchObject({ status: 'ok', changed: 0 });
    expect(database.snapshots).toBe(0);
  });

  it('rolls back an interrupted page and retries from the same cursor', async () => {
    const database = new MemoryDb(); database.failOnId = 'country2';
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ result: { data: [{ _id: 'country1', name: 'Spain' }, { _id: 'country2', name: 'France' }] } })));
    const env = { DB: database as unknown as D1Database } as Env;
    expect(await runSync(env, { source: 'countries', force: true })).toMatchObject({ status: 'error' });
    expect(database.cursor).toBeNull();
    expect(database.snapshots).toBe(0);
    database.failOnId = null;
    expect(await runSync(env, { source: 'countries', force: true })).toMatchObject({ status: 'ok', processed: 2, changed: 2 });
    expect(database.snapshots).toBe(2);
  });

  it('validates only the selected three-country slice and keeps the cursor on a bad later row', async () => {
    const database = new MemoryDb();
    const countries = Array.from({ length: 3 }, (_, index) => ({ _id: `country${index}`, name: `Country ${index}` }));
    countries.push({ _id: 'bad', name: '' });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ result: { data: countries } })));
    const env = { DB: database as unknown as D1Database } as Env;
    expect(await runSync(env, { source: 'countries', force: true })).toMatchObject({ status: 'ok', processed: 3, changed: 3 });
    expect(JSON.parse(database.cursor!)).toEqual({ offset: 3, ids: ['country0', 'country1', 'country2', 'bad'] });
    expect(await runSync(env, { source: 'countries', force: true })).toMatchObject({ status: 'error' });
    expect(JSON.parse(database.cursor!)).toEqual({ offset: 3, ids: ['country0', 'country1', 'country2', 'bad'] });
    expect(database.rows.size).toBe(3);
  });

  it('discovers countries once, then hydrates only the remaining IDs before a new sweep', async () => {
    const database = new MemoryDb();
    const feed = Array.from({ length: 5 }, (_, index) => ({ _id: `country${index}`, name: `Country ${index}`, currentPopulation: index + 1 }));
    const procedures: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input);
      const procedure = url.pathname.split('/').at(-1)!;
      procedures.push(procedure);
      if (procedure === 'country.getAllCountries') return Response.json({ result: { data: feed } });
      const recordId = JSON.parse(url.searchParams.get('input')!).countryId;
      return Response.json({ result: { data: feed.find(row => row._id === recordId) } });
    }));
    const env = { DB: database as unknown as D1Database } as Env;
    expect(await runSync(env, { source: 'countries', force: true })).toMatchObject({ status: 'ok', processed: 3 });
    expect(JSON.parse(database.cursor!)).toEqual({ offset: 3, ids: feed.map(row => row._id) });
    expect(await runSync(env, { source: 'countries', force: true })).toMatchObject({ status: 'ok', processed: 2 });
    expect(database.cursor).toBeNull();
    expect(procedures).toEqual(['country.getAllCountries', 'country.getCountryById', 'country.getCountryById']);
    expect(database.rows.size).toBe(5);
    expect(await runSync(env, { source: 'countries', force: true })).toMatchObject({ status: 'ok', processed: 3, changed: 0 });
    expect(procedures.at(-1)).toBe('country.getAllCountries');
  });

  it('preserves a legacy offset and stores ordered region IDs for later detail requests', async () => {
    const database = new MemoryDb(); database.sourceId = 'regions'; database.cursor = '{"offset":3}';
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const feed = Object.fromEntries([...ids].reverse().map(_id => [_id, { _id, name: `Region ${_id}`, country: 'country1' }]));
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input), procedure = url.pathname.split('/').at(-1)!;
      requested.push(procedure);
      if (procedure === 'region.getRegionsObject') return Response.json({ result: { data: feed } });
      const recordId = JSON.parse(url.searchParams.get('input')!).regionId;
      requested.push(recordId);
      return Response.json({ result: { data: feed[recordId] } });
    }));
    const env = { DB: database as unknown as D1Database } as Env;
    expect(await runSync(env, { source: 'regions', force: true })).toMatchObject({ status: 'ok', processed: 3 });
    expect(JSON.parse(database.cursor!)).toEqual({ offset: 6, ids });
    expect([...database.rows.keys()]).toEqual(['d', 'e', 'f']);
    expect(await runSync(env, { source: 'regions', force: true })).toMatchObject({ status: 'ok', processed: 1 });
    expect(requested).toEqual(['region.getRegionsObject', 'region.getById', 'g']);
    expect(database.cursor).toBeNull();
  });

  it('refuses malformed discovery IDs and mismatched detail IDs without advancing', async () => {
    const database = new MemoryDb();
    const fetcher = vi.fn(async () => Response.json({ result: { data: { _id: 'wrong', name: 'Wrong' } } }));
    vi.stubGlobal('fetch', fetcher);
    const env = { DB: database as unknown as D1Database } as Env;
    database.cursor = '{"offset":0,"ids":["country1","country1"]}';
    expect(await runSync(env, { source: 'countries', force: true })).toMatchObject({ status: 'error' });
    expect(fetcher).not.toHaveBeenCalled();
    database.cursor = '{"offset":0,"ids":["country1","country2"]}';
    expect(await runSync(env, { source: 'countries', force: true })).toMatchObject({ status: 'error' });
    expect(database.cursor).toBe('{"offset":0,"ids":["country1","country2"]}');
    expect(database.rows.size).toBe(0);
  });

  it('does not advance a cursor when the final state transaction fails', async () => {
    const database = new MemoryDb(); database.failOnCleanup = true;
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ result: { data: [{ _id: 'country1', name: 'Spain' }] } })));
    const env = { DB: database as unknown as D1Database } as Env;
    expect(await runSync(env, { source: 'countries', force: true })).toMatchObject({ status: 'error' });
    expect(database.cursor).toBeNull();
    expect(database.snapshots).toBe(1);
    database.failOnCleanup = false;
    expect(await runSync(env, { source: 'countries', force: true })).toMatchObject({ status: 'ok', changed: 0 });
    expect(database.snapshots).toBe(1);
  });

  it('does not fetch on a forced sync when the daily reservation is exhausted', async () => {
    const database = new MemoryDb(); database.denyBudget = true;
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const env = { DB: database as unknown as D1Database } as Env;
    const result = await runSync(env, { source: 'countries', force: true });
    expect(result.status).toBe('quota-paused');
    expect(result.nextRunAt).toMatch(/T00:00:00\.000Z$/);
    expect(database.lease).toBeNull();
    expect(database.globalOwner).toBeNull();
    expect([...database.runStatuses.values()]).toEqual(['quota-paused']);
    expect(database.reservedWrites).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses three D1 calls before fetching and rolls back a failed run insert with its reservation', async () => {
    const database = new MemoryDb(); database.failRunInsert = true;
    const fetcher = vi.fn(async () => {
      expect(database.rpcCalls).toBe(3);
      return Response.json({ result: { data: [{ _id: 'country1', name: 'Spain' }] } });
    });
    vi.stubGlobal('fetch', fetcher);
    const env = { DB: database as unknown as D1Database } as Env;
    expect(await runSync(env, { source: 'countries', force: true })).toMatchObject({ status: 'error' });
    expect(database.reservedWrites).toBe(0);
    expect(database.runStatuses.size).toBe(0);
    expect(database.globalOwner).toBeNull();
    expect(database.lease).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    database.failRunInsert = false;
    const before = database.rpcCalls;
    fetcher.mockImplementationOnce(async () => {
      expect(database.rpcCalls - before).toBe(3);
      return Response.json({ result: { data: [{ _id: 'country1', name: 'Spain' }] } });
    });
    expect(await runSync(env, { source: 'countries', force: true })).toMatchObject({ status: 'ok', processed: 1 });
  });

  it('serializes sources behind the shared global lease', async () => {
    const database = new MemoryDb(); database.globalOwner = 'another-tick';
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const env = { DB: database as unknown as D1Database } as Env;
    expect(await runSync(env, { source: 'countries', force: true })).toMatchObject({ status: 'busy' });
    expect(database.lease).toBeNull();
    expect(database.reservedWrites).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a forced sync if another tick advanced the cursor after source selection', async () => {
    const database = new MemoryDb();
    database.onNextBatch = () => {
      database.cursor = '{"offset":3}';
      database.due = '2099-01-01T00:00:00.000Z';
    };
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const env = { DB: database as unknown as D1Database } as Env;
    expect(await runSync(env, { source: 'countries', force: true })).toMatchObject({ status: 'busy' });
    expect(database.cursor).toBe('{"offset":3}');
    expect(database.globalOwner).toBeNull();
    expect(database.reservedWrites).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('ignores article rows marked non-public by the upstream API', async () => {
    const database = new MemoryDb(); database.sourceId = 'articles';
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ result: { data: { items: [
      { _id: 'public', title: 'Public report', isPublic: true, isPublished: true, isDeleted: false },
      { _id: 'private', title: 'Private report', isPublic: false, isPublished: true, isDeleted: false },
    ], nextCursor: null } } })));
    const env = { DB: database as unknown as D1Database } as Env;
    expect(await runSync(env, { source: 'articles', force: true })).toMatchObject({ status: 'ok', processed: 1, changed: 1 });
    expect([...database.rows.keys()]).toEqual(['public']);
  });

  it('honors a live lease before fetching', async () => {
    const database = new MemoryDb(); database.lease = '2099-01-01T00:00:00.000Z';
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const env = { DB: database as unknown as D1Database } as Env;
    expect(await runSync(env, { source: 'countries', force: true })).toMatchObject({ status: 'busy' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps long article continuation history below the collector cursor limit and detects legacy cycles', async () => {
    const store = createTestDB();
    const oldTokens = Array.from({length:30},(_,index)=>`${String(index).padStart(3,'0')}${'x'.repeat(497)}`);
    const current = 'y'.repeat(500), next = 'z'.repeat(500);
    const initial = JSON.stringify({ archiveToken:current,recentTokens:oldTokens,headNextAt:'2099-01-01T00:00:00.000Z' });
    expect(initial.length).toBeLessThan(16_000);
    store.sqlite.prepare("UPDATE ingestion_cursors SET cursor=? WHERE source_id='articles'").run(initial);
    let nextCursor = next;
    const fetcher = vi.fn(async () => Response.json({result:{data:{items:[{_id:'public-article',title:'Public report',isPublic:true,isPublished:true}],nextCursor}}})) as typeof fetch;
    try {
      const env = {DB:store.db} as Env;
      expect(await runSync(env,{source:'articles',force:true,fetcher})).toMatchObject({status:'ok',processed:1});
      const saved = String(store.sqlite.prepare("SELECT cursor FROM ingestion_cursors WHERE source_id='articles'").get()?.cursor);
      expect(saved.length).toBeLessThan(16_000);
      const parsed = JSON.parse(saved) as {recentTokens:string[]};
      expect(parsed.recentTokens).toHaveLength(31);
      expect(parsed.recentTokens.every(token => /^sha256:[0-9a-f]{24}$/.test(token))).toBe(true);
      nextCursor = oldTokens[8];
      expect(await runSync(env,{source:'articles',force:true,fetcher})).toMatchObject({status:'error'});
      expect(store.sqlite.prepare("SELECT cursor FROM ingestion_cursors WHERE source_id='articles'").get()?.cursor).toBe(saved);
    } finally {store.sqlite.close();}
  });

  it('refreshes the article head without treating its page token as an archive cycle', async () => {
    const store = createTestDB();
    store.sqlite.prepare("UPDATE ingestion_cursors SET cursor=? WHERE source_id='articles'")
      .run(JSON.stringify({archiveToken:'archive-token',recentTokens:['older-token'],headNextAt:'1970-01-01T00:00:00.000Z'}));
    const fetcher = vi.fn(async () => Response.json({result:{data:{items:[
      {_id:'headline',title:'Latest headline',isPublic:true,isPublished:true}],nextCursor:'archive-token'}}})) as typeof fetch;
    try {
      expect(await runSync({DB:store.db} as Env,{source:'articles',force:true,fetcher})).toMatchObject({status:'ok',processed:1});
      const cursor = JSON.parse(String(store.sqlite.prepare("SELECT cursor FROM ingestion_cursors WHERE source_id='articles'").get()?.cursor));
      expect(cursor.archiveToken).toBe('archive-token');
      expect(cursor.recentTokens).toHaveLength(1);
      expect(cursor.recentTokens[0]).toMatch(/^sha256:[0-9a-f]{24}$/);
    } finally {store.sqlite.close();}
  });

  it('compacts per-country player cursor history without changing the active continuation token', async () => {
    const store = createTestDB();
    const oldTokens = Array.from({length:30},(_,index)=>`${String(index).padStart(3,'0')}${'x'.repeat(497)}`);
    const current = 'y'.repeat(500), next = 'z'.repeat(500);
    store.sqlite.prepare(`INSERT INTO countries(id,name,code,source_url,updated_at,first_seen,hash,data_json)
      VALUES('es','Spain','es','https://example.test','2026-01-01','2026-01-01','h','{}')`).run();
    store.sqlite.prepare(`INSERT INTO player_census_state(country_id,cursor,next_run_at,last_scanned_at,recent_tokens)
      VALUES('es',?,'1970-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',?)`).run(current,JSON.stringify(oldTokens));
    let nextCursor = next;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
      ? Response.json([{result:{data:{_id:'player-one',username:'Player One',country:'es'}}}])
      : Response.json({result:{data:{items:[{_id:'player-one'}],nextCursor}}})) as typeof fetch;
    try {
      const env = {DB:store.db} as Env;
      expect(await runSync(env,{source:'players',force:true,fetcher})).toMatchObject({status:'ok',processed:1});
      const saved = store.sqlite.prepare("SELECT cursor,recent_tokens FROM player_census_state WHERE country_id='es'").get()!;
      expect(saved.cursor).toBe(next);
      expect(String(saved.recent_tokens).length).toBeLessThan(2_500);
      expect((JSON.parse(String(saved.recent_tokens)) as string[]).every(token => /^sha256:[0-9a-f]{24}$/.test(token))).toBe(true);
      nextCursor = oldTokens[8];
      expect(await runSync(env,{source:'players',force:true,fetcher})).toMatchObject({status:'error'});
      expect(store.sqlite.prepare("SELECT cursor FROM player_census_state WHERE country_id='es'").get()?.cursor).toBe(next);
    } finally {store.sqlite.close();}
  });

  it('preserves known country and unit on omission, but clears explicit null without a false transition', async () => {
    const store = createTestDB();
    store.sqlite.prepare(`INSERT INTO countries(id,name,code,source_url,updated_at,first_seen,hash,data_json)
      VALUES('es','Spain','es','https://example.test','2026-01-01','2026-01-01','h','{}')`).run();
    const profiles = [
      {_id:'player-one',username:'Player One',country:'es',mu:'unit-one',leveling:{level:3}},
      {_id:'player-one',username:'Player One',leveling:{level:3}},
      {_id:'player-one',username:'Player One',country:null,mu:null,leveling:{level:3}},
    ];
    let observation = 0;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
      ? Response.json([{result:{data:profiles[observation++]}}])
      : Response.json({result:{data:{items:[{_id:'player-one'}],nextCursor:`next-${observation+1}`}}})) as typeof fetch;
    try {
      const env = {DB:store.db} as Env;
      expect(await runSync(env,{source:'players',force:true,fetcher})).toMatchObject({status:'ok',changed:1});
      expect(await runSync(env,{source:'players',force:true,fetcher})).toMatchObject({status:'ok',changed:0});
      const known = store.sqlite.prepare("SELECT country_id,military_unit_id,data_json FROM players WHERE id='player-one'").get()!;
      expect(known.country_id).toBe('es');
      expect(known.military_unit_id).toBe('unit-one');
      expect(JSON.parse(String(known.data_json)).mu).toBe('unit-one');
      expect(store.sqlite.prepare("SELECT COUNT(*) n FROM entity_snapshots WHERE entity_type='players' AND entity_id='player-one'").get()?.n).toBe(1);
      expect(store.sqlite.prepare("SELECT COUNT(*) n FROM events WHERE event_type IN ('player-country','player-unit')").get()?.n).toBe(0);
      expect(await runSync(env,{source:'players',force:true,fetcher})).toMatchObject({status:'ok',changed:1});
      const cleared = store.sqlite.prepare("SELECT country_id,military_unit_id,data_json FROM players WHERE id='player-one'").get()!;
      expect(cleared.country_id).toBeNull();
      expect(cleared.military_unit_id).toBeNull();
      expect(JSON.parse(String(cleared.data_json)).mu).toBeNull();
      expect(store.sqlite.prepare("SELECT COUNT(*) n FROM entity_snapshots WHERE entity_type='players' AND entity_id='player-one'").get()?.n).toBe(2);
      expect(store.sqlite.prepare("SELECT COUNT(*) n FROM events WHERE event_type IN ('player-country','player-unit')").get()?.n).toBe(0);
    } finally {store.sqlite.close();}
  });
});
