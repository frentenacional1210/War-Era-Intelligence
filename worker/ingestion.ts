import type { Env } from './types';
import { extendedSourceTables, fetchExtendedBatch, normalizeExtendedEntity } from './extended-ingestion';
import { fetchBattleReconciliation } from './battle-reconciliation';
import { orderbookSourceTables,fetchOrderbookBatch,saveOrderbookBatch,normalizeOrderbookEntity } from './orderbook';
import type { ExtendedSource } from '../shared/intelligence';
import { projectPublicGroupRelations } from '../shared/intelligence';
import { COLLECTOR_HANDOFF_SECONDS, COLLECTOR_PLAYER_ROWS, DETAIL_ROWS, INGESTION_DAILY_BUDGET, INGESTION_DAILY_READ_BUDGET, INGESTION_READ_RESERVATION, INGESTION_SLOTS, PAGE_ROWS, PLAYER_ROWS } from '../shared/ingestion-config';
import {
  WarEraClient, WarEraError, articleSchema, countryDetailSchema, countryFeedSchema, namedSchema,
  objectSchema, pagedObjectsSchema, pagedPlayersSchema,
  playerSchema, pricesSchema, regionDetailSchema, regionsObjectSchema,
} from './warera';

type CoreSourceId = 'countries' | 'regions' | 'players' | 'parties' | 'military-units' | 'battles' | 'articles' | 'markets';
type SourceId = CoreSourceId | ExtendedSource | 'battle-reconciliation' | 'orderbooks';
type Row = Record<string, unknown>;
type SourceRow = { id: string; endpoint: string; interval_seconds: number; cursor: string | null; next_run_at: string; lease_until: string | null };
type Cursor = { offset?: number; ids?: string[]; token?: string; recentTokens?: string[]; pages?: number; countryId?: string; lastCountryId?:string;lastItemId?:string;tokens?:Record<string,string>;rotation?: boolean; archiveToken?: string; archiveComplete?: boolean; headNextAt?: string };
type Normalized = { table: string; id: string; name: string; country_id: string | null; source_url: string; updated_at: string; data_json: string; extra: Record<string, string | number | null> };
export type SyncResult = { status: 'ok' | 'error' | 'busy' | 'idle' | 'quota-paused' | 'unknown-source'; source?: string; processed?: number; changed?: number; nextRunAt?: string; error?: string; checkedPlayers?: number; skippedInactive?: number; skippedUnknownActivity?: number };

const MAX_ROWS = DETAIL_ROWS;
const MAX_PLAYER_ROWS = PLAYER_ROWS;
const DAILY_INGESTION_WRITE_BUDGET = INGESTION_DAILY_BUDGET;
const TICK_SUBREQUEST_UPPER_BOUND = 9; // at most three upstream calls, three attempts each
const written = (results: D1Result[]) => results.reduce((total, result) => total + Number(result.meta.rows_written ?? 0), 0);
const measured = (results: D1Result[]) => results.every(result => Number.isFinite(result.meta.rows_written));
const sourceTable: Record<SourceId, string> = {
  countries: 'countries', regions: 'regions', players: 'players', parties: 'parties',
  'military-units': 'military_units', battles: 'battles', 'battle-reconciliation':'battles', articles: 'articles', markets: 'market_items',...extendedSourceTables,...orderbookSourceTables,
};
const supportedIdsSql = Object.keys(sourceTable).map(id => `'${id}'`).join(',');
const detailProcedure: Record<Exclude<CoreSourceId, 'markets'>, [string, string]> = {
  countries: ['country.getCountryById', 'countryId'],
  regions: ['region.getById', 'regionId'],
  players: ['user.getUserLite', 'userId'],
  parties: ['party.getById', 'partyId'],
  'military-units': ['mu.getById', 'muId'],
  battles: ['battle.getById', 'battleId'],
  articles: ['article.getArticleById', 'articleId'],
};
const string = (value: unknown): string | null => typeof value === 'string' && value.length ? value : null;
const id = (value: unknown): string | null => string(value) && String(value).length <= 100 ? String(value) : null;
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const boolean = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;
const asRow = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const label = (value: unknown): string => String(value ?? '').replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300);
const iso = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string') return fallback;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : fallback;
};
const isoOptional = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(new Date(value).valueOf()) ? new Date(value).toISOString() : null;
const json = (value: unknown): string => JSON.stringify(value);
const parseCursor = (raw: string | null): Cursor => {
  if (!raw) return {};
  try { const value = JSON.parse(raw); return value && typeof value === 'object' ? value as Cursor : {}; }
  catch { return {}; }
};
const plus = (date: Date, seconds: number) => new Date(date.getTime() + seconds * 1000).toISOString();
const nextUtcDay = (isoDate: string) => new Date(Date.parse(`${isoDate.slice(0, 10)}T00:00:00.000Z`) + 86400_000).toISOString();
const hash = async (value: string) => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
};
const continuation = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 500) throw new Error('Invalid continuation cursor');
  return value;
};
const tokenFingerprint = async (value: string) => `sha256:${(await hash(value)).slice(0,24)}`;
const tokenHistory = async (value: unknown): Promise<string[]> => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64 || value.some(item => typeof item !== 'string' || item.length < 1 || item.length > 500))
    throw new Error('Invalid continuation history');
  // Older cursors stored raw tokens. Convert them as they advance so a long
  // archive cannot outgrow the collector's 16 KB expected-cursor limit.
  return Promise.all(value.map(item => /^sha256:[0-9a-f]{24}$/.test(item) ? item : tokenFingerprint(item)));
};

/** Keep a small allowlist of public fields; never persist complete upstream profiles or article HTML. */
export function normalizeWarEraEntity(source: Exclude<SourceId, 'markets'>, input: unknown, client: WarEraClient, now: string): Normalized {
  if(source==='battle-reconciliation')return normalizeWarEraEntity('battles',input,client,now);
  if(source==='orderbooks')return normalizeOrderbookEntity(input,client,now);
  if(source==='companies'||source==='elections'||source==='governments')return normalizeExtendedEntity(source,input,client,now);
  const raw = asRow(input);
  const recordId = id(raw._id);
  if (!recordId) throw new Error(`${source}: missing stable ID`);
  const [procedure, key] = detailProcedure[source];
  const sourceUrl = client.url(procedure, { [key]: recordId });
  const base = { table: sourceTable[source], id: recordId, source_url: sourceUrl, updated_at: now };
  const level = asRow(raw.leveling);
  const dates = asRow(raw.dates);
  const stats = asRow(raw.stats);
  if (source === 'countries') {
    namedSchema.parse(raw);
    const data = { code: string(raw.code), currentPopulation: number(raw.currentPopulation), currentDevelopment: number(raw.currentDevelopment), money: number(raw.money), rulingParty: id(raw.rulingParty) };
    return { ...base, name: label(raw.name), country_id: recordId, data_json: json(data), extra: { code: string(raw.code) } };
  }
  if (source === 'regions') {
    objectSchema.parse(raw);
    const position=Array.isArray(raw.position) && raw.position.length===2 && raw.position.every(value=>number(value)!==null)?raw.position:null;
    const neighbors=Array.isArray(raw.neighbors)?raw.neighbors.map(id).filter(value=>value!==null).slice(0,64):null;
    const data = { code: string(raw.code), country: id(raw.country), initialCountry: id(raw.initialCountry), isCapital: boolean(raw.isCapital),position,neighbors };
    return { ...base, name: label(raw.name ?? raw.code ?? recordId), country_id: id(raw.country), data_json: json(data), extra: { code: string(raw.code) } };
  }
  if (source === 'players') {
    playerSchema.parse(raw);
    const data = { username: label(raw.username), level: number(level.level), experience: number(level.totalXp ?? level.xp), lastConnectionAt: string(dates.lastConnectionAt), damagesCount: number(stats.damagesCount), isActive: boolean(raw.isActive), mu: id(raw.mu) };
    return { ...base, name: label(raw.username), country_id: id(raw.country), data_json: json(data), extra: { level: number(level.level), experience: number(level.totalXp ?? level.xp), last_active_at: string(dates.lastConnectionAt), party_id: id(raw.party), military_unit_id: id(raw.mu) } };
  }
  if (source === 'parties') {
    namedSchema.parse(raw);
    const relations=projectPublicGroupRelations(source,raw),members=relations.memberCount;
    const data = { description: label(raw.description).slice(0, 500), country: id(raw.country), leader: id(raw.leader), createdAt: string(raw.createdAt),...relations };
    return { ...base, name: label(raw.name), country_id: id(raw.country), data_json: json(data), extra: { leader_id: id(raw.leader), member_count: members } };
  }
  if (source === 'military-units') {
    namedSchema.parse(raw);
    const relations=projectPublicGroupRelations(source,raw),members=relations.memberCount;
    const data = { country: id(raw.country), owner: id(raw.user), level: number(level.level), createdAt: string(raw.createdAt),...relations };
    return { ...base, name: label(raw.name), country_id: id(raw.country), data_json: json(data), extra: { leader_id: id(raw.user), member_count: members, level: number(level.level) } };
  }
  if (source === 'battles') {
    objectSchema.parse(raw);
    const attacker = asRow(raw.attacker), defender = asRow(raw.defender);
    const data = { type: string(raw.type), attackerCountry: id(attacker.country), defenderCountry: id(defender.country), region: id(defender.region ?? attacker.region), isActive: boolean(raw.isActive), createdAt: string(raw.createdAt), endedAt:isoOptional(raw.endedAt), wonBy:string(raw.wonBy), currentRound: number(raw.currentRound), attackerDamages: number(attacker.damages), defenderDamages: number(defender.damages) };
    return { ...base, name: `Battle ${recordId.slice(0, 8)}`, country_id: id(defender.country), data_json: json(data), extra: { is_active: boolean(raw.isActive) === null ? null : raw.isActive === true ? 1 : 0, attacker_country_id: id(attacker.country), defender_country_id: id(defender.country), region_id: id(defender.region ?? attacker.region) } };
  }
  articleSchema.parse(raw);
  const data = { title: label(raw.title), author: id(raw.author), publishedAt: isoOptional(raw.publishedAt), language: string(raw.language), category: string(raw.category), stats: { views: number(stats.views), likes: number(stats.likes), comments: number(stats.comments) }, slug: string(raw.slug) };
  return { ...base, name: label(raw.title), country_id: id(raw.country), data_json: json(data), extra: { title: label(raw.title), author_id: id(raw.author), published_at: isoOptional(raw.publishedAt), language: string(raw.language), category: string(raw.category) } };
}

// Fields that change on almost every observation. They still refresh the
// current row, but alone they add at most one history snapshot per UTC day;
// any other field change is captured immediately. Battles keep every change:
// their damage progression within a short battle is the history itself.
const VOLATILE_SNAPSHOT_PATHS: Partial<Record<SourceId, string[]>> = {
  players: ['$.experience', '$.lastConnectionAt', '$.last_active_at', '$.damagesCount'],
  articles: ['$.stats'],
};
/** SQL guard that skips a snapshot differing from the latest one only in volatile fields on the same UTC day. */
function volatileSnapshotGuard(source: SourceId, idSql: string, nowSql: string, snapshotSql: string): string {
  const paths = VOLATILE_SNAPSHOT_PATHS[source];
  if (!paths) return '';
  // CASE keeps json_remove from ever evaluating a malformed legacy snapshot.
  const material = (expr: string) => `CASE WHEN json_valid(${expr}) THEN json_remove(${expr},${paths.map(path => `'${path}'`).join(',')}) END`;
  return ` AND NOT EXISTS(SELECT 1 FROM (SELECT data_json,captured_at FROM entity_snapshots WHERE entity_type=? AND entity_id=${idSql} ORDER BY id DESC LIMIT 1) p
    WHERE substr(p.captured_at,1,10)=substr(${nowSql},1,10) AND ${material('p.data_json')}=${material(snapshotSql)})`;
}

async function saveEntities(env: Env, source: Exclude<SourceId, 'markets'>, items: unknown[], client: WarEraClient, now: string): Promise<{changed:number;results:D1Result[]}> {
  if(source==='battle-reconciliation')return saveEntities(env,'battles',items,client,now);
  if (!items.length) return {changed:0,results:[]};
  // Validate the selected page before preparing any write. A failed item cannot advance its cursor.
  const rows = items.map(item => normalizeWarEraEntity(source, item, client, now));
  const readResults:D1Result[]=[];
  // Public profiles can omit affiliations and country. Omission is unknown;
  // only an explicit null clears a previously observed value.
  if(source==='players' && items.some(item=>['party','mu','country'].some(field=>!Object.prototype.hasOwnProperty.call(asRow(item),field)))) {
    const previous=await env.DB.prepare(`SELECT id,country_id,party_id,military_unit_id FROM players WHERE id IN (${rows.map(()=>'?').join(',')})`)
      .bind(...rows.map(row=>row.id)).all<{id:string;country_id:string|null;party_id:string|null;military_unit_id:string|null}>();
    readResults.push(previous);
    const known=new Map(previous.results.map(row=>[row.id,row]));
    rows.forEach((row,index)=>{
      const raw=asRow(items[index]),prior=known.get(row.id);
      if(!Object.prototype.hasOwnProperty.call(raw,'country'))row.country_id=prior?.country_id ?? null;
      if(!Object.prototype.hasOwnProperty.call(raw,'party'))row.extra.party_id=prior?.party_id ?? null;
      if(!Object.prototype.hasOwnProperty.call(raw,'mu')){
        row.extra.military_unit_id=prior?.military_unit_id ?? null;
        row.data_json=json({...JSON.parse(row.data_json),mu:prior?.military_unit_id ?? null});
      }
    });
  }
  // Preserve the pre-batch digest format so a deployment does not fabricate changes or snapshots.
  // data_json is already a compact JSON object; embedding it avoids parsing and stringifying it again.
  const digests = await Promise.all(rows.map(row => hash(`{"name":${json(row.name)},"country_id":${json(row.country_id)},"extra":${json(row.extra)},"data":${row.data_json}}`)));
  // Enrich only future observations, without changing the canonical digest or
  // inventing a historical transition for rows captured before this method.
  const snapshots=rows.map(row=>json({...JSON.parse(row.data_json),name:row.name,countryId:row.country_id,
    ...row.extra,source_url:row.source_url,methodology:'public-observation-v2'}));
  const first = rows[0];
  const columns = ['id', 'name', 'country_id', 'source_url', 'updated_at', 'first_seen', 'hash', 'data_json', ...Object.keys(first.extra)];
  const updates = columns.filter(column => column !== 'id' && column !== 'first_seen').map(column => `${column}=excluded.${column}`).join(',');
  const upsert = env.DB.prepare(`INSERT INTO ${first.table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${updates} WHERE ${first.table}.hash<>excluded.hash`);
  const snapshot = env.DB.prepare(`INSERT INTO entity_snapshots(entity_type,entity_id,captured_at,hash,data_json)
    SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM ${first.table} WHERE id=? AND hash=?)
    AND COALESCE((SELECT hash FROM entity_snapshots WHERE entity_type=? AND entity_id=? ORDER BY id DESC LIMIT 1),'')<>?${volatileSnapshotGuard(source, '?', '?', '?')}`);
  const sampled = Boolean(VOLATILE_SNAPSHOT_PATHS[source]);
  const statements: D1PreparedStatement[] = [];
  if(rows.length>3){
    // Transfer one compact page instead of two D1 result envelopes per entity.
    const page=rows.map((row,index)=>({...row,...row.extra,first_seen:now,hash:digests[index],snapshot_json:snapshots[index]}));
    const encoded=json(page);
    const fields=columns.map(column=>`json_extract(value,'$.${column}')`).join(',');
    const bulk=env.DB.prepare(`INSERT INTO ${first.table}(${columns.join(',')}) SELECT ${fields} FROM json_each(?) WHERE 1
      ON CONFLICT(id) DO UPDATE SET ${updates} WHERE ${first.table}.hash<>excluded.hash RETURNING id`).bind(encoded);
    const history=env.DB.prepare(`INSERT INTO entity_snapshots(entity_type,entity_id,captured_at,hash,data_json)
      SELECT ?,json_extract(value,'$.id'),?,json_extract(value,'$.hash'),json_extract(value,'$.snapshot_json') FROM json_each(?)
      WHERE EXISTS(SELECT 1 FROM ${first.table} WHERE id=json_extract(value,'$.id') AND hash=json_extract(value,'$.hash'))
      AND COALESCE((SELECT hash FROM entity_snapshots WHERE entity_type=? AND entity_id=json_extract(value,'$.id') ORDER BY id DESC LIMIT 1),'')<>json_extract(value,'$.hash')${volatileSnapshotGuard(source, "json_extract(value,'$.id')", '?', "json_extract(value,'$.snapshot_json')")}`)
      .bind(source,now,encoded,source,...(sampled?[source,now]:[]));
    const results=await env.DB.batch([bulk,history]);
    return {changed:results[0].results.length,results:[...readResults,...results]};
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i], digest = digests[i];
    statements.push(upsert.bind(row.id, row.name, row.country_id, row.source_url, row.updated_at, now, digest, row.data_json, ...Object.values(row.extra)));
    statements.push(snapshot.bind(source, row.id, now, digest, snapshots[i], row.id, digest, source, row.id, digest, ...(sampled ? [source, row.id, now, snapshots[i], snapshots[i]] : [])));
  }
  // The whole page is one D1 transaction, preserving every entity/snapshot pair atomically.
  const results = await env.DB.batch(statements);
  return {changed:results.reduce((count, result, index) => count + (index % 2 === 0 && result.meta.changes ? 1 : 0), 0),results:[...readResults,...results]};
}

type Batch = { records: unknown[]; next: Cursor | null; sourceUrl?: string; checkpoint?: D1PreparedStatement; delay?: number; checkedPlayers?: number; skippedInactive?: number; skippedUnknownActivity?: number };
const checkedIds = (values: unknown, allowEmpty = false): string[] => {
  if (!Array.isArray(values) || (!allowEmpty && !values.length) || values.length > 5000) throw new Error('Invalid discovery cursor IDs');
  const unique = new Set<string>();
  for (const value of values) {
    const candidate = id(value);
    if (!candidate || unique.has(candidate)) throw new Error('Invalid or repeated discovery ID');
    unique.add(candidate);
  }
  return values as string[];
};
async function getBatch(env: Env, client: WarEraClient, source: SourceId, cursor: Cursor, owner:string,playerLimit=MAX_PLAYER_ROWS): Promise<Batch> {
  if(source==='orderbooks')return fetchOrderbookBatch(env,client,cursor);
  if(source==='battle-reconciliation')return fetchBattleReconciliation(env,client);
  if(source==='companies'||source==='elections'||source==='governments')return fetchExtendedBatch(env,client,source,cursor,MAX_ROWS);
  if (source === 'countries' || source === 'regions') {
    const offset = cursor.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid discovery cursor offset');
    let ids: string[];
    let records: unknown[];
    if (cursor.ids !== undefined) {
      ids = checkedIds(cursor.ids);
      const selected = ids.slice(offset, offset + MAX_ROWS);
      const [procedure, key] = detailProcedure[source];
      const schema = source === 'countries' ? countryDetailSchema : regionDetailSchema;
      records = [];
      for (const recordId of selected) {
        const detail = await client.get(procedure, { [key]: recordId }, schema);
        if (detail._id !== recordId) throw new Error(`${procedure} returned a mismatched ID`);
        records.push(detail);
      }
    } else if (source === 'countries') {
      const feed = await client.get('country.getAllCountries', undefined, countryFeedSchema);
      ids = checkedIds(feed.map(record => asRow(record)._id), true);
      records = feed.slice(offset, offset + MAX_ROWS);
    } else {
      const feed = await client.get('region.getRegionsObject', undefined, regionsObjectSchema);
      ids = checkedIds(Object.keys(feed).sort((a, b) => a < b ? -1 : a > b ? 1 : 0), true);
      for (const recordId of ids) {
        if (asRow(feed[recordId])._id !== recordId) throw new Error('region.getRegionsObject returned a mismatched ID');
      }
      records = ids.slice(offset, offset + MAX_ROWS).map(recordId => feed[recordId]);
    }
    return { records, next: offset + MAX_ROWS < ids.length ? { offset: offset + MAX_ROWS, ids } : null };
  }
  if (source === 'markets') {
    const prices = await client.get('itemTrading.getPrices', undefined, pricesSchema);
    const values = Object.entries(prices).sort(([a], [b]) => a.localeCompare(b));
    const offset = Math.max(0, Number(cursor.offset) || 0);
    return { records: values.slice(offset, offset + MAX_ROWS), next: offset + MAX_ROWS < values.length ? { offset: offset + MAX_ROWS } : null, sourceUrl: client.url('itemTrading.getPrices') };
  }
  if (source === 'players') {
    const now = new Date().toISOString();
    // Preserve a legacy in-progress country once, then rotate one page per country.
    const country = cursor.countryId && !cursor.rotation
      ? await env.DB.prepare('SELECT id FROM countries WHERE id=? LIMIT 1').bind(cursor.countryId).first<{id:string;token?:string}>()
      : await env.DB.prepare(`SELECT c.id,s.cursor token,s.recent_tokens FROM countries c LEFT JOIN player_census_state s ON s.country_id=c.id
          WHERE s.next_run_at IS NULL OR s.next_run_at<=?
          ORDER BY COALESCE(s.last_scanned_at,''),CASE WHEN lower(c.code)='es' OR c.name='Spain' THEN 0 ELSE 1 END,c.id LIMIT 1`)
          .bind(now).first<{id:string;token?:string;recent_tokens?:string}>();
    if (!country) return { records: [], next: null };
    const token = cursor.countryId && !cursor.rotation ? cursor.token : country.token;
    const input = { countryId: country.id, limit: playerLimit, ...(token ? { cursor: token } : {}) };
    const page = await client.get('user.getUsersByCountry', input, pagedPlayersSchema);
    const nextToken = continuation(page.nextCursor);
    if (page.items.length > playerLimit) throw new Error('Player page exceeds requested limit');
    const ids = checkedIds(page.items.map(reference => reference._id), true);
    const profiles = await client.getMany('user.getUserLite', ids.map(userId => ({userId})), playerSchema);
    profiles.forEach((record,index)=>{if(record._id!==ids[index])throw new Error('Player batch returned a mismatched ID');});
    // WarEra's country feed has no activity filter. Check its public boolean,
    // then retain only confirmed active profiles; dates are not a substitute.
    const records = profiles.filter(profile => profile.isActive === true);
    const recentTokens = await tokenHistory(JSON.parse('recent_tokens' in country && typeof country.recent_tokens==='string'?country.recent_tokens:'[]'));
    if (nextToken && (nextToken===token || recentTokens.includes(await tokenFingerprint(nextToken)))) throw new Error('Player cursor did not advance');
    if (nextToken && !page.items.length) throw new Error('Empty player page has a continuation cursor');
    const continuing = Boolean(nextToken && page.items.length);
    return { records, checkedPlayers: profiles.length, skippedInactive: profiles.filter(profile => profile.isActive === false).length,
      skippedUnknownActivity: profiles.filter(profile => profile.isActive !== true && profile.isActive !== false).length,
      next: {rotation:true}, checkpoint: env.DB.prepare(`INSERT INTO player_census_state(country_id,cursor,next_run_at,last_scanned_at,records_observed,completed_sweeps,recent_tokens)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM ingestion_lock WHERE id='global' AND owner=? AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(country_id) DO UPDATE SET cursor=excluded.cursor,next_run_at=excluded.next_run_at,
      last_scanned_at=excluded.last_scanned_at,records_observed=records_observed+excluded.records_observed,completed_sweeps=completed_sweeps+excluded.completed_sweeps,recent_tokens=excluded.recent_tokens`)
      .bind(country.id,continuing?nextToken:null,continuing?now:plus(new Date(),21600),now,records.length,continuing?0:1,
        json(continuing?[...recentTokens,...(token?[await tokenFingerprint(token)]:[])].slice(-64):[]),owner) };
  }
  if (source === 'articles') {
    const now = new Date();
    const archiveToken = cursor.archiveToken ?? cursor.token;
    const head = cursor.archiveComplete || Boolean(archiveToken && cursor.headNextAt && cursor.headNextAt<=now.toISOString());
    const page = await client.get('article.getArticlesPaginated', {limit:PAGE_ROWS,type:'last',...(!head && archiveToken?{cursor:archiveToken}:{})},pagedObjectsSchema);
    const nextToken = continuation(page.nextCursor);
    const recentTokens = await tokenHistory(cursor.recentTokens);
    if(page.items.length>PAGE_ROWS)throw new Error('Article page exceeds requested limit');
    if(!head && nextToken && (nextToken===archiveToken || recentTokens.includes(await tokenFingerprint(nextToken))))throw new Error('Article cursor repeated');
    if(!head && nextToken && !page.items.length)throw new Error('Empty article page has a continuation cursor');
    const records = page.items.filter(item=>{const row=asRow(item);return row.isPublic===true && row.isPublished===true && row.isDeleted!==true;});
    const complete = cursor.archiveComplete || (!head && !nextToken);
    return {records,next:{archiveToken:head?archiveToken:nextToken ?? undefined,archiveComplete:complete,
      recentTokens:head?recentTokens:[...recentTokens,...(archiveToken?[await tokenFingerprint(archiveToken)]:[])].slice(-64),
      headNextAt:head || !cursor.headNextAt?plus(now,300):cursor.headNextAt},delay:complete?300:60};
  }
  const pages = Math.max(0, Number(cursor.pages) || 0);
  const specs: Record<'parties' | 'military-units' | 'battles', [string, Record<string, unknown>]> = {
    parties: ['party.getManyPaginated', { limit: PAGE_ROWS }],
    'military-units': ['mu.getManyPaginated', { limit: PAGE_ROWS }],
    battles: ['battle.getBattles', { limit: PAGE_ROWS, isActive: true }],
  };
  const [procedure, input] = specs[source];
  const page = await client.get(procedure, { ...input, ...(cursor.token ? { cursor: cursor.token } : {}) }, pagedObjectsSchema);
  const nextToken = continuation(page.nextCursor);
  const recentTokens = await tokenHistory(cursor.recentTokens);
  if(page.items.length>PAGE_ROWS)throw new Error('Page exceeds requested limit');
  if(nextToken && (nextToken===cursor.token || recentTokens.includes(await tokenFingerprint(nextToken))))throw new Error('Cursor repeated');
  if(nextToken && !page.items.length)throw new Error('Empty page has a continuation cursor');
  return { records:page.items, next: nextToken && page.items.length ? { token: nextToken, pages: pages + 1,recentTokens:[...recentTokens,...(cursor.token?[await tokenFingerprint(cursor.token)]:[])].slice(-64) } : null };
}

async function saveMarkets(env: Env, inputs: unknown[], sourceUrl: string, now: string): Promise<{changed:number;results:D1Result[]}> {
  if (!inputs.length) return {changed:0,results:[]};
  const entries = inputs.map(input => {
    if (!Array.isArray(input) || typeof input[0] !== 'string' || typeof input[1] !== 'number') throw new Error('Invalid market item');
    const [itemId, price] = input as [string, number];
    if (!Number.isFinite(price) || price < 0 || itemId.length > 100) throw new Error('Invalid market price');
    return [itemId, price, json({ code: itemId })] as const;
  });
  const digests = await Promise.all(entries.map(([, , itemJson]) => hash(itemJson)));
  const item = env.DB.prepare(`INSERT INTO market_items(id,name,country_id,source_url,updated_at,first_seen,hash,data_json)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`);
  const price = env.DB.prepare(`INSERT INTO market_prices(item_id,country_id,price,captured_at,source_url)
    SELECT ?,NULL,?,?,? WHERE NOT EXISTS (
      SELECT 1 FROM market_prices WHERE item_id=? AND country_id IS NULL ORDER BY captured_at DESC,id DESC LIMIT 1
    ) OR ? != (SELECT price FROM market_prices WHERE item_id=? AND country_id IS NULL ORDER BY captured_at DESC,id DESC LIMIT 1)`);
  const statements: D1PreparedStatement[] = [];
  entries.forEach(([itemId, value, itemJson], index) => {
    statements.push(item.bind(itemId, label(itemId), null, sourceUrl, now, now, digests[index], itemJson));
    statements.push(price.bind(itemId, value, now, sourceUrl, itemId, value, itemId));
  });
  const results = await env.DB.batch(statements);
  return {changed:results.reduce((count, result, index) => count + (index % 2 === 1 && result.meta.changes ? 1 : 0), 0),results};
}

export async function runSync(env: Env, options: { source?: string; force?: boolean; expectedCursor?:string|null;fetcher?:typeof fetch } = {}): Promise<SyncResult> {
  const started = new Date(), now = started.toISOString();
  const preferred = INGESTION_SLOTS[Math.floor(started.valueOf()/60000)%INGESTION_SLOTS.length];
  if (options.source && !(options.source in sourceTable)) return { status: 'unknown-source', source: options.source };
  const row = options.source
    ? await env.DB.prepare(`SELECT r.id,r.endpoint,r.interval_seconds,c.cursor,c.next_run_at,c.lease_until FROM source_registry r
        JOIN ingestion_cursors c ON c.source_id=r.id WHERE r.id=? AND r.enabled=1`).bind(options.source).first<SourceRow>()
    : await env.DB.prepare(`SELECT r.id,r.endpoint,r.interval_seconds,c.cursor,c.next_run_at,c.lease_until FROM source_registry r
        JOIN ingestion_cursors c ON c.source_id=r.id WHERE r.enabled=1 AND r.id IN (${supportedIdsSql}) AND c.next_run_at<=? AND (c.lease_until IS NULL OR c.lease_until<=?)
        AND NOT (r.id IN ('players','articles') AND EXISTS(SELECT 1 FROM ingestion_runs x WHERE x.source_id=r.id AND x.started_at>=? AND x.collector_mode='compact'))
        ORDER BY CASE WHEN r.id=? THEN 0 WHEN ? IS NULL AND r.id NOT IN ('players','articles') THEN 0 ELSE 1 END,c.next_run_at,r.id LIMIT 1`).bind(now, now,plus(started,-COLLECTOR_HANDOFF_SECONDS),preferred,preferred).first<SourceRow>();
  if (!row) return { status: 'idle' };
  if(options.expectedCursor!==undefined && row.cursor!==options.expectedCursor)return {status:'busy',source:row.id};
  if (!options.force && row.next_run_at > now) return { status: 'idle' };
  const source = row.id as SourceId;
  const playerLimit=options.fetcher?COLLECTOR_PLAYER_ROWS:MAX_PLAYER_ROWS;
  const rowLimit = source==='players'?playerLimit:['parties','military-units','battles','articles'].includes(source)?PAGE_ROWS:MAX_ROWS;
  // Cover entity/index writes, bounded retention and all bookkeeping. Refund
  // only from authoritative D1 metadata after the run is safely finalized.
  const reservation = 140 + rowLimit * (source==='players'?70:35);
  const leaseUntil = plus(started, 600);
  const runId = crypto.randomUUID();
  let claims: D1Result[];
  try {
    // D1.batch is transactional. The global claim checks the selected source is still due;
    // the source claim then requires this run to own the global lease. Neither can be
    // acquired on its own, and a competing tick cannot reserve an API slot.
    claims = await env.DB.batch([
      env.DB.prepare(`UPDATE ingestion_lock SET owner=?,lease_until=? WHERE id='global'
        AND (lease_until IS NULL OR lease_until<=?)
        AND EXISTS(SELECT 1 FROM ingestion_cursors c JOIN source_registry r ON r.id=c.source_id
          WHERE c.source_id=? AND r.enabled=1 AND (c.lease_until IS NULL OR c.lease_until<=?)
          AND (?=1 OR c.next_run_at<=?) AND c.cursor IS ? AND c.next_run_at=?)`)
        .bind(runId, leaseUntil, now, source, now, options.force ? 1 : 0, now, row.cursor, row.next_run_at),
      env.DB.prepare(`UPDATE ingestion_cursors SET lease_until=? WHERE source_id=?
        AND (lease_until IS NULL OR lease_until<=?) AND (?=1 OR next_run_at<=?)
        AND EXISTS(SELECT 1 FROM ingestion_lock WHERE id='global' AND owner=? AND lease_until=?)`)
        .bind(leaseUntil, source, now, options.force ? 1 : 0, now, runId, leaseUntil),
    ]);
  } catch (error) {
    return { status: 'error', source, error: error instanceof Error ? error.message.slice(0, 240) : 'Lease claim unavailable' };
  }
  if (!claims[0].meta.changes || !claims[1].meta.changes) {
    // The second claim can only fail after the first if an external schema trigger
    // changes the eligible row inside this transaction; release defensively.
    if (claims[0].meta.changes) await env.DB.prepare("UPDATE ingestion_lock SET owner=NULL,lease_until=NULL WHERE id='global' AND owner=?").bind(runId).run();
    return { status: 'busy', source };
  }
  let globalReleased = false;
  // Set once the reservation is held; cleared when entity writes begin. Until
  // then a failed run has only touched bookkeeping and can settle on metadata.
  let settleable: D1Result[] | null = null;
  try {
    // Reserve quota and create the run together. A failed INSERT rolls back the
    // reservation; a quota rejection still records an auditable paused run.
    const start = await env.DB.batch([
      env.DB.prepare(`INSERT INTO ingestion_budget(day_key,reserved_writes,tick_count,updated_at,reserved_reads)
        VALUES(?,?,1,?,?) ON CONFLICT(day_key) DO UPDATE SET
        reserved_writes=reserved_writes+excluded.reserved_writes,
        reserved_reads=reserved_reads+excluded.reserved_reads,
        tick_count=tick_count+1,updated_at=excluded.updated_at
        WHERE ingestion_budget.reserved_writes+excluded.reserved_writes<=? AND ingestion_budget.reserved_reads+excluded.reserved_reads<=? AND COALESCE(ingestion_budget.database_bytes,0)<450000000`)
        .bind(now.slice(0, 10), reservation, now, INGESTION_READ_RESERVATION, DAILY_INGESTION_WRITE_BUDGET,INGESTION_DAILY_READ_BUDGET),
      env.DB.prepare('INSERT INTO ingestion_runs(id,source_id,started_at,status) VALUES(?,?,?,?)').bind(runId, source, now, 'running'),
    ]);
    if (!start[0].meta.changes) {
      const nextRunAt = nextUtcDay(now);
      const doneAt = new Date();
      const paused = await env.DB.batch([
        env.DB.prepare('UPDATE ingestion_cursors SET next_run_at=?,lease_until=NULL WHERE source_id=? AND lease_until=?')
          .bind(nextRunAt, source, leaseUntil),
        env.DB.prepare('UPDATE source_registry SET status=?,last_attempt=?,last_error=? WHERE id=?')
          .bind('quota-paused', now, 'Daily ingestion write reservation exhausted; resumes next UTC day', source),
        env.DB.prepare('UPDATE ingestion_runs SET finished_at=?,status=?,records_count=?,error=?,duration_ms=? WHERE id=?')
          .bind(doneAt.toISOString(), 'quota-paused', 0, 'Daily ingestion write reservation exhausted', doneAt.valueOf() - started.valueOf(), runId),
        env.DB.prepare("UPDATE ingestion_lock SET owner=NULL,lease_until=NULL WHERE id='global' AND owner=?").bind(runId),
      ]);
      globalReleased = true;
      if (!paused[0].meta.changes) throw new Error('Sync lease expired before quota pause');
      return { status: 'quota-paused', source, nextRunAt };
    }
    settleable = [...claims, ...start];
    const client = new WarEraClient(env.WARERA_BASE_URL, env.WARERA_API_KEY,options.fetcher);
    const batch = await getBatch(env, client, source, parseCursor(row.cursor),runId,playerLimit);
    settleable = null;
    const saved = source==='orderbooks'?await saveOrderbookBatch(env,batch.records,client,now):source === 'markets'
      ? await saveMarkets(env, batch.records, batch.sourceUrl!, now)
      : await saveEntities(env, source, batch.records, client, now);
    const retention = Number(env.RETENTION_DAYS);
    const days = Number.isInteger(retention) && retention >= 30 && retention <= 3650 ? retention : 365;
    const cutoff = plus(new Date(), -days * 86400);
    const doneAt = new Date(), nextRunAt = plus(doneAt, batch.delay ?? (batch.next ? 60 : row.interval_seconds));
    const final = await env.DB.batch([
      ...(batch.checkpoint?[batch.checkpoint]:[]),
      env.DB.prepare('DELETE FROM ingestion_runs WHERE id IN (SELECT id FROM ingestion_runs WHERE started_at<? AND status<>? ORDER BY started_at LIMIT 10)').bind(cutoff, 'running'),
      env.DB.prepare('DELETE FROM ingestion_budget WHERE day_key IN (SELECT day_key FROM ingestion_budget WHERE day_key<? ORDER BY day_key LIMIT 2)').bind(cutoff.slice(0, 10)),
      env.DB.prepare(`UPDATE ingestion_cursors SET cursor=?,next_run_at=?,lease_until=NULL WHERE source_id=? AND lease_until=?
        AND EXISTS(SELECT 1 FROM ingestion_lock WHERE id='global' AND owner=? AND lease_until>?)`)
        .bind(batch.next ? json(batch.next) : null, nextRunAt, source, leaseUntil,runId,doneAt.toISOString()),
      env.DB.prepare(`UPDATE source_registry SET status=?,last_success=?,last_attempt=?,last_error=NULL WHERE id=?
        AND EXISTS(SELECT 1 FROM ingestion_lock WHERE id='global' AND owner=? AND lease_until>?)`)
        .bind(batch.records.length || batch.checkedPlayers ? 'ok' : 'empty', doneAt.toISOString(), now, source,runId,doneAt.toISOString()),
      env.DB.prepare(`UPDATE ingestion_runs SET finished_at=?,status=?,records_count=?,duration_ms=? WHERE id=?
        AND EXISTS(SELECT 1 FROM ingestion_lock WHERE id='global' AND owner=? AND lease_until>?)`)
        .bind(doneAt.toISOString(), 'ok', batch.records.length, doneAt.valueOf() - started.valueOf(), runId,runId,doneAt.toISOString()),
      env.DB.prepare("UPDATE ingestion_lock SET owner=NULL,lease_until=NULL WHERE id='global' AND owner=?").bind(runId),
    ]);
    globalReleased = true;
    if (!final[final.length-4].meta.changes) throw new Error('Sync lease expired before cursor advance');
    const metered = [...claims,...start,...saved.results,...final];
    const charge = measured(metered)?written(metered)+8:reservation;
    const reads=metered.reduce((sum,result)=>sum+Number(result.meta.rows_read ?? 0),0);
    const readCharge=metered.every(result=>Number.isFinite(result.meta.rows_read))?reads+500:INGESTION_READ_RESERVATION;
    const databaseBytes=Math.max(0,...metered.map(result=>Number(result.meta.size_after ?? 0)));
    // Eight extra writes conservatively cover the settlement itself (including
    // indexes). Missing metadata never gives an unearned refund.
    try {
      await env.DB.batch([
        env.DB.prepare('UPDATE ingestion_budget SET reserved_writes=MAX(0,reserved_writes-?+?),updated_at=?,reserved_reads=MAX(0,reserved_reads-?+?),measured_reads=measured_reads+?,measured_writes=measured_writes+?,database_bytes=CASE WHEN ?>0 THEN ? ELSE database_bytes END WHERE day_key=?')
          .bind(reservation,charge,doneAt.toISOString(),INGESTION_READ_RESERVATION,readCharge,reads,written(metered),databaseBytes,databaseBytes,now.slice(0,10)),
        env.DB.prepare('UPDATE ingestion_runs SET rows_written=?,reserved_writes=?,rows_read=?,collector_mode=? WHERE id=?')
          .bind(measured(metered)?written(metered):null,reservation,reads,options.fetcher?'compact':'direct',runId),
      ]);
    } catch {
      // Data and cursor are already committed. Retain the larger reservation;
      // a failed refund cannot turn a successful capture into a false retry.
      console.warn('wint_budget_settlement_deferred',{source});
    }
    return { status: 'ok', source, processed: batch.records.length, changed:saved.changed, nextRunAt,
      ...(source === 'players' ? { checkedPlayers: batch.checkedPlayers ?? 0, skippedInactive: batch.skippedInactive ?? 0,
        skippedUnknownActivity: batch.skippedUnknownActivity ?? 0 } : {}) };
  } catch (error) {
    const doneAt = new Date();
    if(error instanceof WarEraError && error.status===409){
      // A runner prepared a page while another capture advanced the country or
      // the live/archive turn. Never overwrite the successful source status.
      const released = await env.DB.prepare(`UPDATE ingestion_cursors SET lease_until=NULL WHERE source_id=? AND lease_until=?
        AND EXISTS(SELECT 1 FROM ingestion_lock WHERE id='global' AND owner=?)`).bind(source,leaseUntil,runId).run();
      const marked = await env.DB.prepare('UPDATE ingestion_runs SET finished_at=?,status=?,error=? WHERE id=?').bind(doneAt.toISOString(),'busy','Prepared page became stale',runId).run();
      await settleFailedRun(env, settleable, [released, marked], reservation, runId, now, doneAt, options.fetcher ? 'compact' : 'direct');
      return {status:'busy',source};
    }
    const message = error instanceof Error ? error.message.slice(0, 240) : 'Unknown sync error';
    const retryAfter = error instanceof WarEraError && error.retryAfterSeconds ? error.retryAfterSeconds : Math.min(900, Math.max(60, row.interval_seconds));
    const nextRunAt = plus(doneAt, retryAfter);
    const recorded = [
      await env.DB.prepare(`UPDATE source_registry SET status=?,last_attempt=?,last_error=? WHERE id=?
      AND EXISTS(SELECT 1 FROM ingestion_lock WHERE id='global' AND owner=?)`)
        .bind(error instanceof WarEraError && (error.status === 401 || error.status === 403) ? 'auth-required' : 'error', now, message, source,runId).run(),
      await env.DB.prepare(`UPDATE ingestion_cursors SET next_run_at=?,lease_until=NULL WHERE source_id=? AND lease_until=?
      AND EXISTS(SELECT 1 FROM ingestion_lock WHERE id='global' AND owner=?)`)
        .bind(nextRunAt, source, leaseUntil,runId).run(),
      await env.DB.prepare('UPDATE ingestion_runs SET finished_at=?,status=?,error=?,duration_ms=? WHERE id=?')
        .bind(doneAt.toISOString(), 'error', message, doneAt.valueOf() - started.valueOf(), runId).run(),
    ];
    await settleFailedRun(env, settleable, recorded, reservation, runId, now, doneAt, options.fetcher ? 'compact' : 'direct');
    return { status: 'error', source, error: message, nextRunAt };
  } finally {
    if (!globalReleased) await env.DB.prepare("UPDATE ingestion_lock SET owner=NULL,lease_until=NULL WHERE id='global' AND owner=?").bind(runId).run();
  }
}

/**
 * Refund a failed run's write reservation only when it failed before any entity
 * write and D1 reported every bookkeeping write. Anything else keeps the full
 * reservation, so an unmeasured or partial save never earns a refund.
 */
async function settleFailedRun(env: Env, settleable: D1Result[] | null, recorded: D1Result[], reservation: number,
  runId: string, now: string, doneAt: Date, mode: 'compact' | 'direct'): Promise<void> {
  if (!settleable) return;
  const metered = [...settleable, ...recorded];
  if (!measured(metered)) return;
  const rows = written(metered);
  try {
    await env.DB.batch([
      env.DB.prepare('UPDATE ingestion_budget SET reserved_writes=MAX(0,reserved_writes-?+?),measured_writes=measured_writes+?,updated_at=? WHERE day_key=?')
        .bind(reservation, rows + 8, rows, doneAt.toISOString(), now.slice(0, 10)),
      env.DB.prepare('UPDATE ingestion_runs SET rows_written=?,reserved_writes=?,collector_mode=? WHERE id=?').bind(rows, reservation, mode, runId),
    ]);
  } catch {
    console.warn('wint_budget_settlement_deferred', { runId });
  }
}

export const ingestionLimits = { maxRowsPerTick: PAGE_ROWS, maxDetailRowsPerTick:MAX_ROWS,maxPlayerRowsPerTick: MAX_PLAYER_ROWS, estimatedMaximumExternalSubrequests: TICK_SUBREQUEST_UPPER_BOUND, estimatedMaximumD1Queries:42, dailyIngestionWriteBudget: DAILY_INGESTION_WRITE_BUDGET };
