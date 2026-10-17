import { describe, expect, it } from 'vitest';
import { projectElection } from '../shared/election-projection';
import { normalizeExtendedEntity } from '../worker/extended-ingestion';
import { WarEraClient } from '../worker/warera';

const start = '2026-10-18T00:00:00.000Z', end = '2026-10-19T00:00:00.000Z';
const at = (hours: number) => new Date(Date.parse(start) + hours * 3_600_000);

describe('election projection from real tallies', () => {
  it('reads per-candidate votes from the WarEra votes map instead of the zero voteCount field', () => {
    const row = normalizeExtendedEntity('elections', { _id: 'e1', country: 'es', type: 'president', status: 'active', isActive: true,
      candidates: [{ user: 'a', voteCount: 0 }, { user: 'b', voteCount: 0 }, { user: 'c', voteCount: 0 }], votes: { a: 119, b: 26 }, votesCount: 145 },
      new WarEraClient(), '2026-10-18T10:00:00.000Z');
    const data = JSON.parse(row.data_json);
    expect(data.candidates.map((c: { voteCount: number }) => c.voteCount)).toEqual([119, 26, 0]);
    expect(data.voteSource).toBe('votes-map');
  });
  it('gives a near-certain win to a large late lead and an open race to an early tie', () => {
    const late = projectElection({ type: 'president', electedCount: 1, votesStartAt: start, votesEndAt: end,
      candidates: [{ user: 'a', party: null, votes: 119 }, { user: 'b', party: null, votes: 26 }] }, at(20));
    expect(late.phase).toBe('live');
    expect(late.confidence).toBe('high');
    expect(late.candidates[0]).toMatchObject({ user: 'a', rank: 1 });
    expect(late.candidates[0].electedProbability).toBeGreaterThan(0.99);
    expect(late.projectedTotal).toBe(145 + Math.round(145 * 4 / 20));
    const early = projectElection({ type: 'president', electedCount: 1, votesStartAt: start, votesEndAt: end,
      candidates: [{ user: 'a', party: null, votes: 11 }, { user: 'b', party: null, votes: 10 }] }, at(3));
    expect(early.confidence).toBe('low');
    expect(early.candidates[0].electedProbability).toBeGreaterThan(0.3);
    expect(early.candidates[0].electedProbability).toBeLessThan(0.8);
    expect(early.candidates[0].electedProbability + early.candidates[1].electedProbability).toBeCloseTo(1, 5);
  });
  it('fills every congress seat, is deterministic, and refuses to project too few votes', () => {
    const input = { type: 'congress', electedCount: 2, votesStartAt: start, votesEndAt: end,
      candidates: [{ user: 'a', party: null, votes: 40 }, { user: 'b', party: null, votes: 35 }, { user: 'c', party: null, votes: 5 }] };
    const first = projectElection(input, at(12)), second = projectElection(input, at(12));
    expect(first).toEqual(second);
    expect(first.candidates.reduce((sum, c) => sum + c.electedProbability, 0)).toBeCloseTo(2, 5);
    const thin = projectElection({ ...input, candidates: [{ user: 'a', party: null, votes: 3 }] }, at(12));
    expect(thin.confidence).toBe('none');
    expect(Number.isNaN(thin.candidates[0].electedProbability)).toBe(true);
  });
  it('reports final results as certain once voting has closed', () => {
    const final = projectElection({ type: 'president', electedCount: 1, votesStartAt: start, votesEndAt: end,
      candidates: [{ user: 'a', party: null, votes: 5 }, { user: 'b', party: null, votes: 9 }] }, at(30));
    expect(final).toMatchObject({ phase: 'final', confidence: 'final' });
    expect(final.candidates.map(c => [c.user, c.electedProbability])).toEqual([['b', 1], ['a', 0]]);
  });
});
