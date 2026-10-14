import type { Env } from './types';
import { resourceTables } from './types';
import { isHistoryResource } from '../shared/history';
import { DATA_LIMITS, DATA_RESOURCES, DATA_SCHEMA_VERSION, type DataResource, type PublicDataEnvelope, type PublicDataRecord, type PublicDataset } from '../shared/data';

type Row = Record<string, unknown>;
const BASE = 'id,name,country_id,source_url,updated_at,first_seen,data_json';
const COLUMNS: Partial<Record<DataResource, string[]>> = {
  players: ['level', 'experience', 'last_active_at', 'party_id', 'military_unit_id'],
  parties: ['leader_id', 'member_count'], 'military-units': ['leader_id', 'member_count', 'level'],
  battles: ['is_active', 'attacker_country_id', 'defender_country_id', 'region_id'],
  articles: ['title', 'author_id', 'published_at', 'language', 'category'],
  companies: ['owner_id', 'item_code', 'level'], events: ['event_type'], alerts: ['severity'],
};
const FIELDS: Record<DataResource, string[]> = {
  countries: ['code', 'currentPopulation', 'currentDevelopment', 'money', 'rulingParty'],
  regions: ['code', 'country', 'initialCountry', 'isCapital', 'position', 'neighbors'],
  players: ['username', 'level', 'experience', 'lastConnectionAt', 'damagesCount', 'isActive', 'mu'],
  parties: ['description', 'country', 'leader', 'createdAt', 'memberCount', 'roleIds', 'roleCounts', 'rolesTruncated'],
  'military-units': ['country', 'owner', 'level', 'createdAt', 'memberCount', 'roleIds', 'roleCounts', 'rolesTruncated', 'monthlyDamages'],
  battles: ['type', 'attackerCountry', 'defenderCountry', 'region', 'isActive', 'createdAt', 'endedAt', 'wonBy', 'currentRound', 'attackerDamages', 'defenderDamages'],
  articles: ['title', 'author', 'publishedAt', 'language', 'category', 'stats', 'slug'],
  companies: ['owner', 'region', 'itemCode', 'isFull', 'production', 'workerCount', 'estimatedValue', 'concreteInvested', 'movedUpAt', 'upgrades'],
  elections: ['country', 'type', 'status', 'isActive', 'votesStartAt', 'votesEndAt', 'votesCount', 'electedCount', 'electedCandidates', 'candidates', 'candidatesTruncated', 'electedCandidatesTruncated'],
  governments: ['country', 'president', 'vicePresident', 'minOfDefense', 'minOfEconomy', 'minOfForeignAffairs', 'congressMembers', 'congressTruncated'],
  events: ['theme', 'severity', 'entityType', 'entityId', 'explanation', 'verification', 'before', 'after', 'rule'],
  alerts: ['theme', 'severity', 'entityType', 'entityId', 'explanation', 'verification', 'before', 'after', 'rule'],
  markets: ['price', 'priceCapturedAt', 'priceSourceUrl'],
  orderbooks: ['itemCode', 'buyOrders', 'sellOrders', 'coverage'],
};
const NESTED: Record<string, string[]> = {
  stats: ['views', 'likes', 'comments'], roleIds: ['councilMembers', 'managers', 'commanders'],
  roleCounts: ['councilMembers', 'managers', 'commanders'], upgrades: ['storage', 'automatedEngine', 'breakRoom'],
  candidates: ['user', 'party', 'voteCount', 'isElected'], buyOrders: ['price', 'quantity', 'offeredAt'], sellOrders: ['price', 'quantity', 'offeredAt'],
  before: ['price', 'country', 'party', 'mu', 'president', 'vicePresident', 'memberCount', 'isActive'],
  after: ['price', 'country', 'party', 'mu', 'president', 'vicePresident', 'memberCount', 'isActive', 'attackerCountry', 'defenderCountry', 'region', 'endedAt', 'wonBy', 'votesCount', 'electedCount'],
};
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown, limit = 1000) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit) : null;
const timestamp = (value: unknown) => typeof value === 'string' && value.length <= 80 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const sourceUrl = (value: unknown) => typeof value === 'string' && value.length <= 2000 && /^https:\/\/(?:[a-z0-9-]+\.)*warera\.io(?:[/:?#]|$)/i.test(value) ? value : null;
function publicValue(value: unknown, key: string): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return text(value);
  if (Array.isArray(value)) return value.slice(0, key === 'buyOrders' || key === 'sellOrders' ? 5 : 200).map(item => {
    if (typeof item === 'string') return text(item, 100);
    if (typeof item === 'number') return Number.isFinite(item) ? item : null;
    return Object.fromEntries((NESTED[key] ?? []).map(field => [field, publicValue(object(item)[field], field)]));
  });
  return Object.fromEntries((NESTED[key] ?? []).map(field => [field, publicValue(object(value)[field], field)]));
}

export function dataCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Accept, Content-Type');
  headers.set('Access-Control-Expose-Headers', 'Retry-After');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(response.body, { status: response.status, headers });
}

function project(row: Row, resource: DataResource, origin: string): PublicDataRecord {
  let stored: Row = {};
  try { stored = object(JSON.parse(String(row.data_json ?? '{}'))); } catch { /* Keep the sourced record if stored JSON is malformed. */ }
  if (resource === 'markets') stored = { price: row.price, priceCapturedAt: timestamp(row.price_captured_at), priceSourceUrl: sourceUrl(row.price_source_url) };
  const id = String(row.id);
  const details = Object.fromEntries(FIELDS[resource].map(key => [key, publicValue(stored[key], key)]));
  for (const key of COLUMNS[resource] ?? []) details[key] = publicValue(row[key], key);
  return { id, name: text(row.name, 300) ?? id, countryId: text(row.country_id, 100),
    updatedAt: timestamp(row.updated_at), firstSeenAt: timestamp(row.first_seen), sourceUrl: sourceUrl(row.source_url),
    detailUrl: resource === 'markets' ? `${origin}/api/markets/prices?q=${encodeURIComponent(id)}` : resource === 'orderbooks'
      ? `${origin}/api/markets/orderbook?item=${encodeURIComponent(id)}` : `${origin}/api/${resource}/${encodeURIComponent(id)}`,
    historyUrl: isHistoryResource(resource) ? `${origin}/api/history?resource=${resource}&id=${encodeURIComponent(id)}&period=30d` : null,
    data: details };
}

function query(db: D1Database, resource: DataResource, after: string | null, limit: number): D1PreparedStatement {
  if (resource === 'markets') return db.prepare(`SELECT i.id,i.name,i.country_id,i.source_url,i.updated_at,i.first_seen,i.data_json,
    p.price,p.captured_at price_captured_at,p.source_url price_source_url FROM market_items i LEFT JOIN market_prices p ON p.id=
    (SELECT id FROM market_prices WHERE item_id=i.id AND country_id IS NULL ORDER BY captured_at DESC,id DESC LIMIT 1)
    ${after === null ? '' : 'WHERE i.id>?'} ORDER BY i.id LIMIT ?`).bind(...(after === null ? [] : [after]), limit + 1);
  const table = resource === 'orderbooks' ? 'orderbook_snapshots' : resourceTables[resource];
  const extra = COLUMNS[resource] ?? [];
  return db.prepare(`SELECT ${BASE}${extra.length ? ',' + extra.join(',') : ''} FROM ${table}
    ${after === null ? '' : 'WHERE id>?'} ORDER BY id LIMIT ?`).bind(...(after === null ? [] : [after]), limit + 1);
}

export async function dataRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/data') return null;
  const error = (message: string, status = 400) => Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (!['GET', 'HEAD'].includes(request.method)) return error('This endpoint is read-only. Use GET, HEAD or OPTIONS.', 405);
  let resource: DataResource | null = null, after: string | null = null, limit: number;
  try {
    for (const key of url.searchParams.keys()) if (!['resource', 'after', 'limit'].includes(key) || url.searchParams.getAll(key).length !== 1) throw Error();
    const value = url.searchParams.get('resource');
    if (value !== null) { if (!DATA_RESOURCES.includes(value as DataResource)) throw Error(); resource = value as DataResource; }
    after = url.searchParams.get('after');
    if (after !== null && (!resource || !after.length || after.length > 100 || after.trim() !== after || /[\u0000-\u001f\u007f]/.test(after))) throw Error();
    const raw = url.searchParams.get('limit');
    limit = raw === null ? resource ? DATA_LIMITS.page : DATA_LIMITS.preview : Number(raw);
    if (raw !== null && !/^\d+$/.test(raw)) throw Error();
    if (!Number.isInteger(limit) || limit < 1 || limit > (resource ? DATA_LIMITS.pageMax : DATA_LIMITS.previewMax)) throw Error();
  } catch { return error('Invalid parameters. Catalog limit: 1–10; dataset limit: 1–50. after requires a valid resource.'); }
  if (request.method === 'HEAD') return new Response(null, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  const resources = resource ? [resource] : [...DATA_RESOURCES];
  const statements = [env.DB.prepare(`SELECT id,status,last_success,record_count FROM source_registry WHERE id IN (${resources.map(() => '?').join(',')}) ORDER BY id`).bind(...resources),
    ...resources.map(key => query(env.DB, key, after, limit))];
  if (!resource) statements.push(env.DB.prepare(`SELECT COUNT(*) countries_total,
    COALESCE(SUM(s.country_id IS NOT NULL),0) countries_started,COALESCE(SUM(s.completed_sweeps>0),0) countries_completed,
    COALESCE(SUM(s.completed_sweeps),0) completed_sweeps FROM countries c LEFT JOIN player_census_state s ON s.country_id=c.id`));
  const results = await env.DB.batch<Row>(statements);
  const sources = new Map(results[0].results.map(row => [String(row.id), row]));
  const datasets: PublicDataEnvelope['datasets'] = {};
  for (const [index, key] of resources.entries()) {
    const rows = results[index + 1].results, source = sources.get(key);
    const items = rows.slice(0, limit).map(row => project(row, key, url.origin));
    const hasMore = rows.length > limit, nextAfter = hasMore ? items.at(-1)!.id : null;
    const next = new URL('/api/data', url.origin);
    next.searchParams.set('resource', key); next.searchParams.set('limit', String(resource ? limit : DATA_LIMITS.page));
    if (nextAfter) next.searchParams.set('after', nextAfter);
    const dataset: PublicDataset = { url: `${url.origin}/api/data?resource=${key}`, totalCaptured: typeof source?.record_count === 'number' ? source.record_count : null,
      lastSuccessfulCollectionAt: timestamp(source?.last_success), status: text(source?.status, 60) ?? 'unknown', items,
      pagination: { limit, returned: items.length, hasMore, nextAfter, nextUrl: hasMore ? next.toString() : null } };
    datasets[key] = dataset;
  }
  const counts = resource ? null : results.at(-1)!.results[0];
  const coverage = counts ? { countriesTotal: Number(counts.countries_total), countriesStarted: Number(counts.countries_started),
    countriesCompleted: Number(counts.countries_completed), countriesPending: Number(counts.countries_total) - Number(counts.countries_completed),
    completedSweeps: Number(counts.completed_sweeps), worldPlayerTotal: null, activePlayerTotal: null } : null;
  const value: PublicDataEnvelope = { schemaVersion: DATA_SCHEMA_VERSION, generatedAt: new Date().toISOString(), scope: 'captured-public-data',
    mode: resource ? 'dataset' : 'catalog', resource, datasets, coverage,
    links: { self: url.toString(), catalog: `${url.origin}/api/data`, openapi: `${url.origin}/openapi.json`,
      documentation: 'https://github.com/frentenacional1210/War-Era-Intelligence/blob/main/PUBLIC_DATA_API.md',
      website: url.origin, sourceCode: 'https://github.com/frentenacional1210/War-Era-Intelligence', coverage: `${url.origin}/api/coverage`,
      search: `${url.origin}/api/search?q={query}`, history: `${url.origin}/api/history?resource={resource}&id={id}&period={period}`,
      strategy: `${url.origin}/api/strategy?country={id}`, press: `${url.origin}/api/press`, aiTools: `${url.origin}/api/ai/tools` },
    limitations: ['Counts describe captured WINT records, not the whole game or active-player population.',
      'Player collection now stores only profiles with WarEra isActive=true. Previously captured players and history are preserved; inactive candidates are rechecked in later country sweeps.',
      'Follow every pagination.nextUrl to read more records. Pages are a live view, not an atomic export; repeat collection to discover later inserts and updates.',
      'Article bodies, private data and credentials are excluded. Orderbooks contain up to five offers per side; prices are global.',
      'generatedAt is response generation time; updatedAt is the stored record update time. lastSuccessfulCollectionAt describes the collector.',
      'Historical observations and reports are available through the supplied links. This endpoint performs no AI inference or upstream collection.'] };
  return Response.json(value);
}
