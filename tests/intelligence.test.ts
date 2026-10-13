import { describe, expect, it, vi } from 'vitest';
import { createTestDB } from './sqlite-d1';
import type { Env } from '../worker/types';
import { WarEraClient } from '../worker/warera';
import { fetchExtendedBatch, normalizeExtendedEntity } from '../worker/extended-ingestion';
import { intelligenceRoute } from '../worker/intelligence';
import { electionResultState, projectPublicGroupRelations } from '../shared/intelligence';

const observedAt = '2026-10-12T00:00:00.000Z';
const countryRows = `INSERT INTO countries(id,name,code,source_url,updated_at,first_seen,hash,data_json) VALUES
 ('es','Spain','es','https://api2.warera.io/trpc/country.getAllCountries','${observedAt}','${observedAt}','a','{}'),
 ('fr','France','fr','https://api2.warera.io/trpc/country.getAllCountries','${observedAt}','${observedAt}','b','{}')`;
function setup() {
  const store = createTestDB();
  store.sqlite.exec(countryRows);
  return { ...store, env: { DB: store.db } as Env };
}
const endpoint = (procedure: string, input?: Record<string, unknown>) => {
  const url = new URL(`https://api2.warera.io/trpc/${procedure}`);
  if (input) url.searchParams.set('input', JSON.stringify(input));
  return url.toString();
};
function client(pages: Record<string, unknown>) {
  const calls: { procedure: string; input: Record<string, unknown> | undefined }[] = [];
  const instance = {
    url: endpoint,
    get: vi.fn(async (procedure: string, input: Record<string, unknown> | undefined) => {
      calls.push({ procedure, input });
      const result = pages[`${procedure}:${JSON.stringify(input)}`];
      if (result === undefined) throw new Error(`Unexpected ${procedure}`);
      return result;
    }),
    getMany: vi.fn(async (procedure: string, inputs: Record<string, unknown>[]) => {
      calls.push({ procedure, input: { inputs } });
      return inputs.map(input => {
        const result = pages[`${procedure}:${JSON.stringify(input)}`];
        if (result === undefined) throw new Error(`Unexpected ${procedure}`);
        return result;
      });
    }),
  };
  return { instance: instance as unknown as WarEraClient, calls };
}
const row = (table: string, id: string, name: string, data: object, extra = '') =>
  `INSERT INTO ${table}(id,name,country_id,source_url,updated_at,first_seen,hash,data_json${extra ? ', ' + extra : ''}) VALUES
  ('${id}','${name}','es','https://api2.warera.io/trpc/test','${observedAt}','${observedAt}','h','${JSON.stringify(data)}'${extra ? ', ' + extra.split(',').map(() => 'NULL').join(', ') : ''})`;

describe('verified extended source storage and normalization', () => {
  it('enables only verified new sources with independent cursors and counters', () => {
    const store = setup();
    try {
      const sources = store.sqlite.prepare("SELECT id,enabled,status FROM source_registry WHERE id IN ('companies','elections','governments') ORDER BY id").all();
      expect(sources).toEqual([
        { id: 'companies', enabled: 1, status: 'pending' },
        { id: 'elections', enabled: 1, status: 'pending' },
        { id: 'governments', enabled: 1, status: 'pending' },
      ]);
      expect(store.sqlite.prepare("SELECT COUNT(*) n FROM ingestion_cursors WHERE source_id IN ('companies','elections','governments')").get()).toMatchObject({ n: 3 });
      store.sqlite.exec(row('elections', 'e1', 'Election', { country: 'es', candidates: [] }, 'election_type'));
      expect(store.sqlite.prepare("SELECT record_count FROM source_registry WHERE id='elections'").get()).toMatchObject({ record_count: 1 });
    } finally { store.sqlite.close(); }
  });

  it('retains only bounded public fields and keeps candidate results distinct from unavailable results', () => {
    const { instance } = client({});
    const company = normalizeExtendedEntity('companies', { _id: 'c1', user: 'u1', region: 'r1', name: 'Forge',
      itemCode: 'iron', workerCount: 2, production: 5, estimatedValue: Infinity, privateInventory: ['secret'] }, instance, observedAt);
    expect(company).toMatchObject({ table: 'companies', id: 'c1', name: 'Forge', country_id: null,
      extra: { owner_id: 'u1', item_code: 'iron' } });
    expect(JSON.parse(company.data_json)).toMatchObject({ owner: 'u1', region: 'r1', workerCount: 2, estimatedValue: null });
    expect(company.data_json).not.toContain('privateInventory');

    const election = normalizeExtendedEntity('elections', { _id: 'e1', country: 'es', type: 'presidential',
      status: 'completed', isActive: false, votesCount: 12, votes: { u1: ['private'] },
      candidates: [{ user: 'u1', party: 'p1', voteCount: 12, isElected: true }], electedCandidates: ['u1'] }, instance, observedAt);
    expect(election.extra).toMatchObject({ votes_count: 12, is_active: 0 });
    expect(election.data_json).not.toContain('private');
    expect(JSON.parse(election.data_json)).toMatchObject({ candidatesTruncated: false, electedCandidatesTruncated: false });
    expect(electionResultState(JSON.parse(election.data_json))).toBe('official-results');
    expect(electionResultState({ isActive: false, status: 'finished', electedCount: 11, electedCandidates: [], candidates: [] })).toBe('official-results');
    expect(electionResultState({ candidates: [{ user: 'u1' }], isActive: true })).toBe('candidates-only');
    expect(electionResultState({ candidates: [] })).toBe('results-unavailable');

    const government = normalizeExtendedEntity('governments', { _id: 'g1', country: 'es', president: 'u1',
      congressMembers: ['u2', 'u3'], unpublishedDetail: 'omit' }, instance, observedAt);
    expect(government.extra).toMatchObject({ president_id: 'u1', congress_count: 2 });
    expect(government.data_json).not.toContain('unpublishedDetail');
    expect(() => normalizeExtendedEntity('governments', { _id: 'g2', country: 'es', congressMembers: ['u2', 'u2'] }, instance, observedAt)).toThrow('repeated ID');
  });

  it('projects public group counts and a bounded sample of role IDs without copying member lists', () => {
    const party = projectPublicGroupRelations('parties', { members: Array.from({ length: 1000 }, (_, i) => `u${i}`),
      councilMembers: Array.from({ length: 70 }, (_, i) => `c${i}`), privateNotes: 'omit' });
    expect(party.memberCount).toBe(1000);
    expect(party.roleIds.councilMembers).toHaveLength(64);
    expect(party.roleCounts.councilMembers).toBe(70);
    expect(party.rolesTruncated).toBe(true);
    expect(JSON.stringify(party)).not.toContain('privateNotes');
    expect(JSON.stringify(party)).not.toContain('u999');
    const unit = projectPublicGroupRelations('military-units', { members: ['u1', 'u2'],
      roles: { managers: ['u1', 'u1', 'u2'], commanders: ['u2'] }, leveling: { monthlyDamages: 4000 } });
    expect(unit).toMatchObject({ memberCount: 2, monthlyDamages: 4000,
      roleIds: { managers: ['u1', 'u2'], commanders: ['u2'] }, roleCounts: { managers: 3, commanders: 1 } });
  });

  it('hydrates bounded company ID pages and validates detail identity', async () => {
    const store = setup();
    const page = { items: ['c1', 'c2'], nextCursor: 'page2' };
    const pages = {
      [`company.getCompanies:${JSON.stringify({ perPage: 2 })}`]: page,
      [`company.getById:${JSON.stringify({ companyId: 'c1' })}`]: { _id: 'c1', user: 'u1' },
      [`company.getById:${JSON.stringify({ companyId: 'c2' })}`]: { _id: 'c2', user: 'u2' },
    };
    const mock = client(pages);
    try {
      const batch = await fetchExtendedBatch(store.env, mock.instance, 'companies', {}, 2);
      expect(batch.records).toHaveLength(2);
      expect(batch.next).toMatchObject({ token: 'page2', recentTokens: [expect.stringMatching(/^[0-9a-f]{24}$/)] });
      expect(mock.calls.map(call => call.procedure)).toEqual(['company.getCompanies', 'company.getById']);
      const legacy = await fetchExtendedBatch(store.env, mock.instance, 'companies', { ids: ['c1', 'c2'], offset: 1 }, 1);
      expect(legacy.records).toEqual([{ _id: 'c2', user: 'u2' }]);
      expect(legacy.next).toBeNull();
      await expect(fetchExtendedBatch(store.env, mock.instance, 'companies', { ids: [], offset: 0, token: 'next' }, 1)).rejects.toThrow('empty continuation');
      const bad = client({ ...pages, [`company.getById:${JSON.stringify({ companyId: 'c2' })}`]: { _id: 'wrong' } });
      await expect(fetchExtendedBatch(store.env, bad.instance, 'companies', {}, 2)).rejects.toThrow('ID mismatch');
    } finally { store.sqlite.close(); }
  });

  it('detects multi-page company cycles using only the latest 64 compact token fingerprints', async () => {
    const store = setup();
    const pages: Record<string, unknown> = { [`company.getById:${JSON.stringify({ companyId: 'c1' })}`]: { _id: 'c1' } };
    for (let i = 0; i <= 70; i++) pages[`company.getCompanies:${JSON.stringify({ perPage: 1, ...(i ? { cursor: `t${i}` } : {}) })}`]
      = { items: ['c1'], nextCursor: i === 70 ? 't10' : `t${i + 1}` };
    const mock = client(pages);
    try {
      let cursor = {};
      for (let i = 0; i < 70; i++) {
        const page = await fetchExtendedBatch(store.env, mock.instance, 'companies', cursor, 1);
        cursor = page.next ?? {};
      }
      expect((cursor as { recentTokens: string[] }).recentTokens).toHaveLength(64);
      await expect(fetchExtendedBatch(store.env, mock.instance, 'companies', cursor, 1)).rejects.toThrow('cycle');
      const empty = client({ [`company.getCompanies:${JSON.stringify({ perPage: 1 })}`]: { items: [], nextCursor: 'orphan' } });
      await expect(fetchExtendedBatch(store.env, empty.instance, 'companies', {}, 1)).rejects.toThrow('empty continuation');
    } finally { store.sqlite.close(); }
  });

  it('rotates countries while preserving each election pagination token', async () => {
    const store = setup();
    const pages = {
      [`election.getElections:${JSON.stringify({ countryId: 'es', limit: 1, cursor: 'es-next' })}`]:
        { items: [{ _id: 'e2', country: 'es' }], nextCursor: 'es-next-2' },
      [`election.getElections:${JSON.stringify({ countryId: 'fr', limit: 1, cursor: 'fr-next' })}`]:
        { items: [{ _id: 'e3', country: 'fr' }], nextCursor: null },
      [`government.getByCountryId:${JSON.stringify({ countryId: 'es' })}`]: { _id: 'g1', country: 'es' },
      [`government.getByCountryId:${JSON.stringify({ countryId: 'fr' })}`]: null,
    };
    const mock = client(pages);
    try {
      const first = await fetchExtendedBatch(store.env, mock.instance, 'elections',
        { lastCountryId: 'fr', tokens: { es: 'es-next', fr: 'fr-next' } }, 1);
      expect(first.next).toMatchObject({ lastCountryId: 'es', tokens: { es: 'es-next-2', fr: 'fr-next' } });
      expect(first.next?.recentTokensByCountry?.es).toHaveLength(2);
      const second = await fetchExtendedBatch(store.env, mock.instance, 'elections', first.next ?? {}, 1);
      expect(second.next).toMatchObject({ lastCountryId: 'fr', tokens: { es: 'es-next-2' } });
      expect(second.next?.recentTokensByCountry?.fr).toBeUndefined();
      const government = await fetchExtendedBatch(store.env, mock.instance, 'governments', { lastCountryId: 'fr' });
      expect(government.records).toEqual([{ _id: 'g1', country: 'es' }]);
      expect(government.next).toEqual({ lastCountryId: 'es' });
      const emptyGovernment = await fetchExtendedBatch(store.env, mock.instance, 'governments', { lastCountryId: 'es' });
      expect(emptyGovernment).toMatchObject({ records: [], next: { lastCountryId: 'fr' } });
      await expect(fetchExtendedBatch(store.env, mock.instance, 'governments', { lastCountryId: 'not valid' })).rejects.toThrow('invalid ID');
    } finally { store.sqlite.close(); }
  });

  it('rejects a returning election cursor and an empty continuation page per country', async () => {
    const store = setup();
    const pages: Record<string, unknown> = {
      [`election.getElections:${JSON.stringify({ countryId: 'es', limit: 1 })}`]: { items: [{ _id: 'e1', country: 'es' }], nextCursor: 'a' },
      [`election.getElections:${JSON.stringify({ countryId: 'es', limit: 1, cursor: 'a' })}`]: { items: [{ _id: 'e2', country: 'es' }], nextCursor: 'b' },
      [`election.getElections:${JSON.stringify({ countryId: 'es', limit: 1, cursor: 'b' })}`]: { items: [{ _id: 'e3', country: 'es' }], nextCursor: 'a' },
    };
    store.sqlite.exec("DELETE FROM countries WHERE id='fr'");
    try {
      const mock = client(pages);
      const first = await fetchExtendedBatch(store.env, mock.instance, 'elections', {}, 1);
      const second = await fetchExtendedBatch(store.env, mock.instance, 'elections', first.next ?? {}, 1);
      await expect(fetchExtendedBatch(store.env, mock.instance, 'elections', second.next ?? {}, 1)).rejects.toThrow('cycle');
      const empty = client({ [`election.getElections:${JSON.stringify({ countryId: 'es', limit: 1 })}`]: { items: [], nextCursor: 'orphan' } });
      await expect(fetchExtendedBatch(store.env, empty.instance, 'elections', {}, 1)).rejects.toThrow('empty continuation');
    } finally { store.sqlite.close(); }
  });
});

describe('read-only intelligence routes', () => {
  it('adds sourced inverse leadership, government, ownership, and bounded membership from indexed records', async () => {
    const store = setup();
    const base = 'https://api2.warera.io/trpc/test';
    try {
      store.sqlite.prepare(`INSERT INTO players(id,name,country_id,party_id,military_unit_id,source_url,updated_at,first_seen,hash,data_json)
        VALUES('u1','Player','es','p1','m1',?,?,?,'h','{}')`).run(base, observedAt, observedAt);
      store.sqlite.prepare(`INSERT INTO parties(id,name,country_id,leader_id,source_url,updated_at,first_seen,hash,data_json)
        VALUES('p1','Party','es','u1',?,?,?,'h','{}')`).run(base, observedAt, observedAt);
      store.sqlite.prepare(`INSERT INTO military_units(id,name,country_id,leader_id,source_url,updated_at,first_seen,hash,data_json)
        VALUES('m1','Unit','es','u1',?,?,?,'h','{}')`).run(base, observedAt, observedAt);
      store.sqlite.prepare(`INSERT INTO governments(id,name,country_id,president_id,source_url,updated_at,first_seen,hash,data_json)
        VALUES('g1','Government','es','u1',?,?,?,'h',?)`).run(base, observedAt, observedAt,
        JSON.stringify({ country: 'es', president: 'u1', congressMembers: ['u1'] }));
      store.sqlite.prepare(`INSERT INTO companies(id,name,country_id,owner_id,source_url,updated_at,first_seen,hash,data_json)
        VALUES('c1','Forge','es','u1',?,?,?,'h','{}')`).run(base, observedAt, observedAt);
      const body = await (await intelligenceRoute(new Request('https://test/api/relations?resource=players&id=u1'), store.env))!.json() as Record<string, any>;
      expect(body.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ to: 'parties:p1', relation: 'party-leader', sourceUrl: base }),
        expect.objectContaining({ to: 'military-units:m1', relation: 'unit-owner' }),
        expect.objectContaining({ to: 'governments:g1', relation: 'president' }),
        expect.objectContaining({ to: 'governments:g1', relation: 'congress-member' }),
        expect.objectContaining({ to: 'companies:c1', relation: 'company-owner' }),
      ]));
      expect(body.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'companies', id: 'c1', name: 'Forge' })]));
      expect(body.inverseCoverage).toMatchObject({ companies: 'collected-only', government: 'current-collected-country-only' });
      const plans = [
        ["SELECT id FROM players WHERE party_id=? ORDER BY name,id LIMIT 21", 'p1', 'idx_players_party'],
        ["SELECT id FROM players WHERE military_unit_id=? ORDER BY name,id LIMIT 21", 'm1', 'idx_players_unit'],
        ["SELECT id FROM companies WHERE owner_id=? ORDER BY id LIMIT 21", 'u1', 'idx_companies_owner'],
        ["SELECT id FROM governments WHERE country_id=? ORDER BY updated_at DESC,id LIMIT 1", 'es', 'idx_governments_country'],
      ] as const;
      for (const [query, parameter, index] of plans) {
        const plan = store.sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(parameter)
          .map(row => String(row.detail)).join(' ');
        expect(plan).toContain(index);
      }
    } finally { store.sqlite.close(); }
  });

  it('caps inverse party and unit member edges at twenty collected players', async () => {
    const store = setup();
    try {
      store.sqlite.exec("INSERT INTO parties(id,name,country_id,source_url,updated_at,first_seen,hash,data_json) VALUES ('p1','Party','es','https://api2.warera.io/trpc/test','2026-10-12','2026-10-12','h','{}')");
      store.sqlite.exec("INSERT INTO military_units(id,name,country_id,source_url,updated_at,first_seen,hash,data_json) VALUES ('m1','Unit','es','https://api2.warera.io/trpc/test','2026-10-12','2026-10-12','h','{}')");
      const insert = store.sqlite.prepare(`INSERT INTO players(id,name,country_id,party_id,military_unit_id,source_url,updated_at,first_seen,hash,data_json)
        VALUES(?,?, 'es','p1','m1','https://api2.warera.io/trpc/test','2026-10-12','2026-10-12','h','{}')`);
      for (let index = 0; index < 21; index++) insert.run(`u${index}`, `Player ${index}`);
      const party = await (await intelligenceRoute(new Request('https://test/api/relations?resource=parties&id=p1'), store.env))!.json() as Record<string, any>;
      const unit = await (await intelligenceRoute(new Request('https://test/api/relations?resource=military-units&id=m1'), store.env))!.json() as Record<string, any>;
      expect(party.edges.filter((edge: { relation: string }) => edge.relation === 'party-member')).toHaveLength(20);
      expect(unit.edges.filter((edge: { relation: string }) => edge.relation === 'military-unit-member')).toHaveLength(20);
      expect(party.inverseCoverage.players).toBe('limited-to-20');
      expect(unit.inverseCoverage.players).toBe('limited-to-20');
    } finally { store.sqlite.close(); }
  });
  it('exposes current and observed historical edges with source and time', async () => {
    const store = setup();
    try {
      store.sqlite.exec("INSERT INTO players(id,name,country_id,party_id,military_unit_id,source_url,updated_at,first_seen,hash,data_json) VALUES ('u1','Player','es','p2','m1','https://api2.warera.io/trpc/user.getUserLite','2026-10-12','2026-10-12','h','{}')");
      store.sqlite.exec("INSERT INTO entity_snapshots(entity_type,entity_id,captured_at,hash,data_json) VALUES ('players','u1','2026-10-01','old','{\"party_id\":\"p1\",\"countryId\":\"es\"}')");
      const response = await intelligenceRoute(new Request('https://test/api/relations?resource=players&id=u1'), store.env);
      expect(response?.status).toBe(200);
      const body = await response!.json() as Record<string, any>;
      expect(body.root).toMatchObject({ type: 'players', id: 'u1', name: 'Player' });
      expect(body.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ from: 'players:u1', to: 'parties:p2', state: 'current', sourceUrl: expect.any(String) }),
        expect.objectContaining({ from: 'players:u1', to: 'parties:p1', state: 'historical-observation', observedAt: '2026-10-01' }),
      ]));
      expect(body.historyMeaning).toContain('Observed snapshot');
    } finally { store.sqlite.close(); }
  });

  it('reports politics completeness and partial military roster without invented participation', async () => {
    const store = setup();
    try {
      store.sqlite.exec(row('elections', 'e1', 'Election', { country: 'es', isActive: true, candidates: [{ user: 'u1', voteCount: 1 }] }, 'election_type'));
      store.sqlite.exec(row('governments', 'g1', 'Government', { country: 'es', president: 'u1' }, 'president_id'));
      store.sqlite.exec("INSERT INTO military_units(id,name,country_id,leader_id,source_url,updated_at,first_seen,hash,data_json) VALUES ('m1','Unit','es','u1','https://api2.warera.io/trpc/mu.getManyPaginated','2026-10-12','2026-10-12','h','{}')");
      store.sqlite.exec("INSERT INTO players(id,name,country_id,military_unit_id,source_url,updated_at,first_seen,hash,data_json) VALUES ('u1','Player','es','m1','https://api2.warera.io/trpc/user.getUserLite','2026-10-12','2026-10-12','h','{}')");
      const politics = await (await intelligenceRoute(new Request('https://test/api/politics?country=es'), store.env))!.json() as Record<string, any>;
      expect(politics.government).toMatchObject({ id: 'g1', data: { president: 'u1' } });
      expect(politics.elections[0]).toMatchObject({ id: 'e1', resultState: 'candidates-only' });
      expect(politics.completeness).toMatchObject({ elections: 'collected-only' });
      const military = await (await intelligenceRoute(new Request('https://test/api/military?unit=m1'), store.env))!.json() as Record<string, any>;
      expect(military.observedPlayers).toHaveLength(1);
      expect(military).toMatchObject({ rosterCoverage: 'partial-collected-records', battleParticipation: 'unverified' });
    } finally { store.sqlite.close(); }
  });

  it('rejects unsupported methods, arbitrary table names, and unbounded IDs', async () => {
    const store = setup();
    try {
      expect(await intelligenceRoute(new Request('https://test/other'), store.env)).toBeNull();
      expect((await intelligenceRoute(new Request('https://test/api/relations?resource=sqlite_master&id=x'), store.env))?.status).toBe(400);
      expect((await intelligenceRoute(new Request('https://test/api/relations?resource=__proto__&id=x'), store.env))?.status).toBe(400);
      expect((await intelligenceRoute(new Request('https://test/api/politics?country=%27%20OR%201'), store.env))?.status).toBe(400);
      expect((await intelligenceRoute(new Request('https://test/api/military?unit=m1', { method: 'POST' }), store.env))?.status).toBe(405);
    } finally { store.sqlite.close(); }
  });
});
