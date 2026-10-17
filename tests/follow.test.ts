import { describe, expect, it } from 'vitest';
import { diffFields, FOLLOW_KEY, markSeen, MAX_FOLLOWS, readFollows, saveFollows, toggleFollow, trackedFields } from '../src/follow-model';

const memory = () => { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } }; };
const NOW = new Date('2026-10-17T12:00:00.000Z');

describe('followed records in this browser', () => {
  it('tracks meaningful fields and ignores bookkeeping and last connection', () => {
    const fields = trackedFields({ id: 'p1', name: 'Fer37', level: 5, updated_at: 'x', source_url: 'y', last_active_at: 'z', data_json: '{}', data: { party_id: 'a', damagesCount: 3, nested: { no: 1 } } });
    expect(fields).toEqual({ name: 'Fer37', level: 5, party_id: 'a', damagesCount: 3 });
  });
  it('reports what changed since the last visit and clears it when marked as seen', () => {
    let list = toggleFollow([], 'players', { id: 'p1', name: 'Fer37', level: 5, party_id: 'a' }, 'Fer37', NOW);
    const now = { id: 'p1', name: 'Fer37', level: 6, party_id: null, updated_at: 'later' };
    expect(diffFields(list[0].seen, trackedFields(now))).toEqual([{ key: 'level', before: 5, after: 6 }, { key: 'party_id', before: 'a', after: null }]);
    list = markSeen(list, 'players', now, NOW);
    expect(diffFields(list[0].seen, trackedFields(now))).toEqual([]);
    expect(toggleFollow(list, 'players', now, 'Fer37')).toEqual([]);
  });
  it('bounds the list, survives corrupt storage and rejects unknown resources', () => {
    const storage = memory();
    let list = Array.from({ length: MAX_FOLLOWS }, (_, index) => ({ id: `p${index}` })).reduce((acc, row) => toggleFollow(acc, 'players', row, row.id, NOW), [] as ReturnType<typeof readFollows>);
    expect(toggleFollow(list, 'players', { id: 'extra' }, 'extra')).toHaveLength(MAX_FOLLOWS);
    expect(saveFollows(list, storage)).toBe(true);
    expect(readFollows(storage)).toHaveLength(MAX_FOLLOWS);
    storage.setItem(FOLLOW_KEY, '{not json');
    expect(readFollows(storage)).toEqual([]);
    storage.setItem(FOLLOW_KEY, JSON.stringify([{ resource: 'admin', id: 'x', name: 'x', seenAt: 'x', seen: {} }]));
    expect(readFollows(storage)).toEqual([]);
    list = [];
    expect(readFollows(undefined)).toEqual(list);
  });
});
