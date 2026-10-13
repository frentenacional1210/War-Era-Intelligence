import type { Env } from './types';
import { asObject, electionResultState, relationRefs, safeId, type RelationRef, type RelationResource } from '../shared/intelligence';

const tables: Record<RelationResource, string> = {
  players: 'players', parties: 'parties', 'military-units': 'military_units', companies: 'companies',
  countries: 'countries', elections: 'elections', governments: 'governments',
};
type DbRow = { id: string; name: string; country_id?: string | null; source_url: string; updated_at: string; data_json: string; [key: string]: unknown };
const respond = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const parsedData = (value: string) => { try { return asObject(JSON.parse(value)); } catch { return {}; } };
const uniqueRefs = (refs: RelationRef[]) => [...new Map(refs.map(ref => [`${ref.type}:${ref.id}:${ref.relation}`, ref])).values()];
function currentRefs(resource: RelationResource, row: DbRow): RelationRef[] {
  const refs = relationRefs(resource, parsedData(row.data_json));
  const add = (type: RelationResource, value: unknown, relation: string) => {
    const id = safeId(value);
    if (id) refs.push({ type, id, relation });
  };
  if (resource === 'players') {
    add('countries', row.country_id, 'country');
    add('parties', row.party_id, 'party-member');
    add('military-units', row.military_unit_id, 'military-unit-member');
  } else if (resource === 'parties') {
    add('countries', row.country_id, 'country');
    add('players', row.leader_id, 'party-leader');
  } else if (resource === 'military-units') {
    add('countries', row.country_id, 'country');
    add('players', row.leader_id, 'unit-owner');
  } else if (resource === 'companies') {
    add('countries', row.country_id, 'country');
    add('players', row.owner_id, 'company-owner');
  } else if (resource === 'elections' || resource === 'governments') add('countries', row.country_id, 'country');
  return uniqueRefs(refs).slice(0, 100);
}
async function relations(env: Env, resource: RelationResource, id: string) {
  const row = await env.DB.prepare(`SELECT * FROM ${tables[resource]} WHERE id=?`).bind(id).first<DbRow>();
  if (!row) return respond({ error: 'Entity not found in collected data' }, 404);
  const snapshots = (await env.DB.prepare('SELECT captured_at,data_json FROM entity_snapshots WHERE entity_type=? AND entity_id=? ORDER BY captured_at DESC LIMIT 90')
    .bind(resource, id).all<{ captured_at: string; data_json: string }>()).results;
  const nodes = new Map<string, { type: RelationResource; id: string; name?: string }>();
  nodes.set(`${resource}:${id}`, { type: resource, id, name: row.name });
  const edges: { from: string; to: string; relation: string; observedAt: string; state: 'current' | 'historical-observation'; sourceUrl: string }[] = [];
  const append = (refs: RelationRef[], observedAt: string, state: 'current' | 'historical-observation', sourceUrl = row.source_url, targetName?: string) => {
    for (const ref of refs) {
      if (edges.length >= 180 || nodes.size >= 120) break;
      const target = `${ref.type}:${ref.id}`;
      if (target === `${resource}:${id}`) continue;
      const previous = nodes.get(target);
      nodes.set(target, { type: ref.type, id: ref.id, ...(previous?.name || targetName ? { name: previous?.name ?? targetName } : {}) });
      edges.push({ from: `${resource}:${id}`, to: target, relation: ref.relation, observedAt, state, sourceUrl });
    }
  };
  append(currentRefs(resource, row), row.updated_at, 'current');
  const inverseCoverage: Record<string, string> = {};
  if (resource === 'players') {
    type Related = { id: string; name: string; source_url: string; updated_at: string; leader_id?: string | null; data_json?: string };
    const partyId = safeId(row.party_id), unitId = safeId(row.military_unit_id), countryId = safeId(row.country_id);
    const [party, unit, government, companies] = await Promise.all([
      partyId ? env.DB.prepare('SELECT id,name,leader_id,source_url,updated_at FROM parties WHERE id=?').bind(partyId).first<Related>() : Promise.resolve(null),
      unitId ? env.DB.prepare('SELECT id,name,leader_id,source_url,updated_at FROM military_units WHERE id=?').bind(unitId).first<Related>() : Promise.resolve(null),
      countryId ? env.DB.prepare('SELECT id,name,data_json,source_url,updated_at FROM governments WHERE country_id=? ORDER BY updated_at DESC,id LIMIT 1').bind(countryId).first<Related>() : Promise.resolve(null),
      env.DB.prepare('SELECT id,name,source_url,updated_at FROM companies WHERE owner_id=? ORDER BY id LIMIT 21').bind(id).all<Related>(),
    ]);
    if (party?.leader_id === id) append([{ type: 'parties', id: party.id, relation: 'party-leader' }], party.updated_at, 'current', party.source_url, party.name);
    if (unit?.leader_id === id) append([{ type: 'military-units', id: unit.id, relation: 'unit-owner' }], unit.updated_at, 'current', unit.source_url, unit.name);
    if (government?.data_json) {
      const governmentData = parsedData(government.data_json);
      for (const [field, role] of [['president', 'president'], ['vicePresident', 'vice-president'],
        ['minOfDefense', 'minister-defense'], ['minOfEconomy', 'minister-economy'],
        ['minOfForeignAffairs', 'minister-foreign-affairs']] as const) {
        if (safeId(governmentData[field]) === id) append([{ type: 'governments', id: government.id, relation: role }],
          government.updated_at, 'current', government.source_url, government.name);
      }
      if (Array.isArray(governmentData.congressMembers) && governmentData.congressMembers.slice(0, 200).includes(id))
        append([{ type: 'governments', id: government.id, relation: 'congress-member' }],
          government.updated_at, 'current', government.source_url, government.name);
    }
    for (const company of companies.results.slice(0, 20)) append([{ type: 'companies', id: company.id, relation: 'company-owner' }],
      company.updated_at, 'current', company.source_url, company.name);
    inverseCoverage.companies = companies.results.length > 20 ? 'limited-to-20' : 'collected-only';
    inverseCoverage.government = countryId ? 'current-collected-country-only' : 'country-unavailable';
  } else if (resource === 'parties' || resource === 'military-units') {
    const field = resource === 'parties' ? 'party_id' : 'military_unit_id';
    const members = (await env.DB.prepare(`SELECT id,name,source_url,updated_at FROM players WHERE ${field}=? ORDER BY name,id LIMIT 21`)
      .bind(id).all<{ id: string; name: string; source_url: string; updated_at: string }>()).results;
    for (const member of members.slice(0, 20)) append([{ type: 'players', id: member.id,
      relation: resource === 'parties' ? 'party-member' : 'military-unit-member' }],
      member.updated_at, 'current', member.source_url, member.name);
    inverseCoverage.players = members.length > 20 ? 'limited-to-20' : 'collected-only';
  }
  const seen = new Set<string>();
  for (const snapshot of snapshots) {
    const refs = relationRefs(resource, parsedData(snapshot.data_json));
    for (const ref of refs) {
      const key = `${ref.type}:${ref.id}:${ref.relation}`;
      if (seen.has(key)) continue;
      seen.add(key);
      append([ref], snapshot.captured_at, 'historical-observation');
    }
  }
  return respond({ root: { type: resource, id, name: row.name, updatedAt: row.updated_at, sourceUrl: row.source_url },
    nodes: [...nodes.values()], edges, inverseCoverage, historyLimit: 90,
    historyMeaning: 'Observed snapshot, not a proven start or end date' });
}

async function politics(env: Env, countryId: string) {
  const country = await env.DB.prepare('SELECT id,name,source_url,updated_at FROM countries WHERE id=?').bind(countryId)
    .first<{ id: string; name: string; source_url: string; updated_at: string }>();
  if (!country) return respond({ error: 'Country not found in collected data' }, 404);
  const [governments, elections, parties] = await Promise.all([
    env.DB.prepare('SELECT * FROM governments WHERE country_id=? ORDER BY updated_at DESC,id LIMIT 1').bind(countryId).all<DbRow>(),
    env.DB.prepare('SELECT * FROM elections WHERE country_id=? ORDER BY votes_start_at DESC,updated_at DESC,id LIMIT 40').bind(countryId).all<DbRow>(),
    env.DB.prepare('SELECT id,name,leader_id,member_count,source_url,updated_at FROM parties WHERE country_id=? ORDER BY name,id LIMIT 40').bind(countryId)
      .all<{ id: string; name: string; leader_id: string | null; member_count: number | null; source_url: string; updated_at: string }>(),
  ]);
  const government = governments.results[0];
  return respond({ country: { id: country.id, name: country.name, sourceUrl: country.source_url, updatedAt: country.updated_at },
    government: government ? { id: government.id, data: parsedData(government.data_json), sourceUrl: government.source_url, updatedAt: government.updated_at } : null,
    elections: elections.results.map(row => {
      const data = parsedData(row.data_json);
      return { id: row.id, data, resultState: electionResultState(data), sourceUrl: row.source_url, updatedAt: row.updated_at };
    }),
    parties: parties.results.map(row => ({ id: row.id, name: row.name, leaderId: row.leader_id, memberCount: row.member_count,
      sourceUrl: row.source_url, updatedAt: row.updated_at })),
    completeness: { elections: elections.results.length === 40 ? 'limited-to-40' : 'collected-only',
      parties: parties.results.length === 40 ? 'limited-to-40' : 'collected-only' } });
}

async function military(env: Env, unitId: string) {
  const unit = await env.DB.prepare('SELECT * FROM military_units WHERE id=?').bind(unitId).first<DbRow>();
  if (!unit) return respond({ error: 'Unit not found in collected data' }, 404);
  const players = await env.DB.prepare('SELECT id,name,level,last_active_at,source_url,updated_at FROM players WHERE military_unit_id=? ORDER BY name,id LIMIT 50')
    .bind(unitId).all<{ id: string; name: string; level: number | null; last_active_at: string | null; source_url: string; updated_at: string }>();
  return respond({ unit: { id: unit.id, name: unit.name, countryId: unit.country_id, ownerId: unit.leader_id,
    data: parsedData(unit.data_json), sourceUrl: unit.source_url, updatedAt: unit.updated_at },
    observedPlayers: players.results.map(row => ({ id: row.id, name: row.name, level: row.level, lastActiveAt: row.last_active_at,
      sourceUrl: row.source_url, updatedAt: row.updated_at })),
    observedPlayerLimit: 50, rosterCoverage: 'partial-collected-records', battleParticipation: 'unverified' });
}

/** Fixed, read-only public routes. The main router may call this before generic resource routing. */
export async function intelligenceRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname;
  if (path !== '/api/relations' && path !== '/api/politics' && path !== '/api/military') return null;
  if (request.method !== 'GET') return respond({ error: 'Method not allowed' }, 405);
  if (path === '/api/relations') {
    const resource = url.searchParams.get('resource');
    const id = safeId(url.searchParams.get('id'));
    if (!resource || !Object.prototype.hasOwnProperty.call(tables, resource) || !id) return respond({ error: 'Invalid resource or ID' }, 400);
    return relations(env, resource as RelationResource, id);
  }
  if (path === '/api/politics') {
    const country = safeId(url.searchParams.get('country'));
    return country ? politics(env, country) : respond({ error: 'Invalid country ID' }, 400);
  }
  const unit = safeId(url.searchParams.get('unit'));
  return unit ? military(env, unit) : respond({ error: 'Invalid unit ID' }, 400);
}
