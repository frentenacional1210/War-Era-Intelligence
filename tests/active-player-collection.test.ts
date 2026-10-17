import { describe, expect, it, vi } from 'vitest';
import type { WarEraClient } from '../worker/warera';
import { collectPlayerProfiles } from '../shared/active-player-collection';

const direct = <T>(call: () => Promise<T>) => call();
const clientOf = (getMany: ReturnType<typeof vi.fn>) => ({ getMany }) as unknown as Pick<WarEraClient, 'getMany'>;

describe('active player collection', () => {
  it('splits a 24-candidate collector page into upstream batches of eight and keeps positions', async () => {
    const ids = Array.from({ length: 24 }, (_, index) => `u${index}`);
    const getMany = vi.fn(async (_procedure: string, inputs: { userId: string }[]) =>
      inputs.map(({ userId }) => ({ _id: userId, username: userId, isActive: Number(userId.slice(1)) % 2 === 0 })));
    const rows = await collectPlayerProfiles(clientOf(getMany), ids, direct, 24);
    expect(getMany.mock.calls.map(call => [call[0], call[1].length])).toEqual([
      ['user.getUserLite', 8], ['user.getUserLite', 8], ['user.getUserLite', 8], ['user.getUserById', 8], ['user.getUserById', 4]]);
    expect(rows.map(row => row._id)).toEqual(ids);
    expect(rows.filter(row => row.isActive === true)).toHaveLength(12);
  });
  it('fetches full profiles only for active lite IDs and preserves candidate positions', async () => {
    const getMany = vi.fn(async (procedure: string, inputs: { userId: string }[]) => procedure === 'user.getUserLite'
      ? inputs.map(({ userId }) => ({ _id: userId, username: userId.toUpperCase(), isActive: userId !== 'b' }))
      : inputs.map(({ userId }) => ({ _id: userId, username: userId.toUpperCase(), isActive: true })));

    const rows = await collectPlayerProfiles(clientOf(getMany), ['a', 'b', 'c'], direct);

    expect(getMany.mock.calls.map(call => [call[0], call[1].map((input: { userId: string }) => input.userId)]))
      .toEqual([['user.getUserLite', ['a', 'b', 'c']], ['user.getUserById', ['a', 'c']]]);
    expect(rows).toEqual([
      { _id: 'a', username: 'A', isActive: true },
      { _id: 'b', username: 'B', isActive: false },
      { _id: 'c', username: 'C', isActive: true },
    ]);
  });

  it('does no full lookup when no lite profile is explicitly active', async () => {
    const getMany = vi.fn(async (_procedure: string, inputs: { userId: string }[]) =>
      inputs.map(({ userId }, index) => ({ _id: userId, username: userId.toUpperCase(), isActive: index === 0 ? false : null })));

    expect(await collectPlayerProfiles(clientOf(getMany), ['a', 'b'], direct))
      .toEqual([{ _id: 'a', username: 'A', isActive: false }, { _id: 'b', username: 'B', isActive: null }]);
    expect(getMany).toHaveBeenCalledTimes(1);
  });

  it('honors a later inactive flag, keeps lite proof when full omits it, and strips private fields', async () => {
    const getMany = vi.fn(async (procedure: string, inputs: { userId: string }[]) => procedure === 'user.getUserLite'
      ? inputs.map(({ userId }) => ({ _id: userId, username: userId.toUpperCase(), isActive: true, email: 'private@example.test' }))
      : [
          { _id: inputs[0].userId, username: 'Old', isActive: false, email: 'private@example.test' },
          { _id: inputs[1].userId, username: 'Current', dates: { lastConnectionAt: '2026-01-01T00:00:00Z', email: 'private@example.test' }, email: 'private@example.test' },
        ]);

    const rows = await collectPlayerProfiles(clientOf(getMany), ['a', 'b'], direct);
    expect(rows).toEqual([
      { _id: 'a', username: 'A', isActive: false },
      { _id: 'b', username: 'Current', isActive: true, dates: { lastConnectionAt: '2026-01-01T00:00:00Z' } },
    ]);
    expect(JSON.stringify(rows)).not.toContain('private@example.test');

    const reversed = vi.fn(async (procedure: string) => procedure === 'user.getUserLite'
      ? [{ _id: 'b', isActive: true }, { _id: 'a', isActive: true }]
      : []);
    await expect(collectPlayerProfiles(clientOf(reversed), ['a', 'b'], direct))
      .rejects.toThrow('Collector lite profile order mismatch');
  });
});
