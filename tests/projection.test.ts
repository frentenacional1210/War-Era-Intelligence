import { describe, expect, it, vi } from 'vitest';
import { COLLECTOR_PLAYER_ROWS } from '../shared/ingestion-config';
import { MAX_PROJECTED_PROFILE_BYTES, projectPlayerBatch, projectPublicPage } from '../shared/public-projection';
import { WarEraClient, playerSchema } from '../worker/warera';

describe('anonymous full-profile collection contract', () => {
  it('batches user.getUserById in order and strips fields outside the public allowlist', async () => {
    const ids = ['u1', 'u2'];
    const full = [
      { _id: 'u1', username: 'One', country: 'es', party: 'p1', mu: 'm1',
        dates: { lastConnectionAt: '2026-10-12T00:00:00Z', privateDate: 'secret' },
        stats: { damagesCount: 5, wealth: 999 }, preferences: { secret: true }, email: 'private@example.test' },
      { _id: 'u2', username: 'Two', country: 'es', dates: { lastConnectionAt: null },
        stats: { damagesCount: 0 }, password: 'secret' },
    ];
    const fetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(request));
      expect(url.pathname).toBe('/trpc/user.getUserById,user.getUserById');
      expect(url.searchParams.get('batch')).toBe('1');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ '0': { userId: 'u1' }, '1': { userId: 'u2' } });
      return Response.json(full.map(profile => ({ result: { data: profile } })));
    });
    const client = new WarEraClient('https://api2.warera.io/trpc', undefined, fetcher as typeof fetch);
    const projected = projectPlayerBatch(await client.getMany('user.getUserById', ids.map(userId => ({ userId })), playerSchema), ids);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(projected[0]).toMatchObject({ _id: 'u1', username: 'One', party: 'p1', mu: 'm1', stats: { damagesCount: 5 } });
    expect(projected[1]).not.toHaveProperty('party');
    expect(projected[1]).not.toHaveProperty('mu');
    expect(JSON.stringify(projected)).not.toMatch(/private@example\.test|password|preferences|wealth|privateDate/);
  });

  it('keeps eight projected profiles and the full commit below the Worker body limit', () => {
    const ids = Array.from({ length: COLLECTOR_PLAYER_ROWS }, (_, index) => `u${index}`);
    const full = ids.map((_id, index) => ({ _id, username: 'N'.repeat(300), country: 'c'.repeat(100),
      party: 'p'.repeat(100), mu: 'm'.repeat(100), updatedAt: '2026-10-12T00:00:00.000Z',
      dates: { lastConnectionAt: '2026-10-12T00:00:00.000Z' },
      leveling: { level: 999, totalXp: 999999, xp: 999999 }, stats: { damagesCount: 999999 },
      email: `private${index}@example.test`, unrelated: 'do-not-persist'.repeat(10_000) }));
    const projected = projectPlayerBatch(full, ids, COLLECTOR_PLAYER_ROWS);
    const profileBytes = new TextEncoder().encode(JSON.stringify(projected)).byteLength;
    const page = projectPublicPage('players', { items: ids.map(_id => ({ _id })), nextCursor: 'next' }, COLLECTOR_PLAYER_ROWS);
    const commitBytes = new TextEncoder().encode(JSON.stringify({ source: 'players', cursorExpected: null,
      input: { countryId: 'es', limit: COLLECTOR_PLAYER_ROWS }, page, profiles: projected })).byteLength;
    expect(profileBytes).toBeLessThanOrEqual(MAX_PROJECTED_PROFILE_BYTES);
    expect(commitBytes).toBeLessThanOrEqual(32_768);
    expect(JSON.stringify(projected)).not.toContain('do-not-persist');
    expect(JSON.stringify(projected)).not.toContain('private0@example.test');
  });

  it('preserves omitted versus explicit null party and rejects mismatched or oversized batches', () => {
    const omitted = { _id: 'u1', username: 'One' };
    const explicitNull = { _id: 'u2', username: 'Two', party: null };
    const result = projectPlayerBatch([omitted, explicitNull], ['u1', 'u2']);
    expect(result[0]).not.toHaveProperty('party');
    expect(result[1]).toHaveProperty('party', null);
    expect(() => projectPlayerBatch([omitted], ['u2'])).toThrow('order mismatch');
    expect(() => projectPlayerBatch([omitted], ['u1', 'u2'])).toThrow('count mismatch');
    expect(() => projectPlayerBatch(Array(9).fill(omitted), Array(9).fill('u1'), 8)).toThrow('count mismatch');
  });
});
