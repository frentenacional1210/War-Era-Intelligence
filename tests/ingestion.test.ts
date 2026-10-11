import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeWarEraEntity, runSync } from '../worker/ingestion';
import { WarEraClient } from '../worker/warera';
import type { Env } from '../worker/types';

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
          if (sql.startsWith('DELETE FROM entity_snapshots') && this.failOnCleanup) throw new Error('simulated final batch failure');
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
});
