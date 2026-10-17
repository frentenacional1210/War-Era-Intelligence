import { z } from 'zod';
import type { Env } from './types';
import { WarEraClient } from './warera';
import { asObject, dateString, finite, safeId, safeText, type ExtendedSource } from '../shared/intelligence';

export const sourceTable: Record<ExtendedSource, string> = { companies: 'companies', elections: 'elections', governments: 'governments' };
export const extendedSourceTables = sourceTable;
export type ExtendedCursor = { token?: string; ids?: string[]; offset?: number; countryId?: string; lastCountryId?: string;
  tokens?: Record<string, string>; recentTokens?: string[]; recentTokensByCountry?: Record<string, string[]> };
export type ExtendedBatch = { records: unknown[]; next: ExtendedCursor | null; delay?: number; sourceUrl?: string };
export type ExtendedNormalized = { table: string; id: string; name: string; country_id: string | null; source_url: string; updated_at: string; data_json: string; extra: Record<string, string | number | null> };

const detailSchema = z.object({ _id: z.string().min(1) }).passthrough();
const pageSchema = z.object({ items: z.array(z.unknown()), nextCursor: z.string().nullish() });
const requiredId = (value: unknown, context: string) => {
  const id = safeId(value);
  if (!id) throw new Error(`${context}: invalid ID`);
  return id;
};
const idsOf = (values: unknown[], context: string) => {
  const ids = values.map(value => requiredId(value, context));
  if (new Set(ids).size !== ids.length) throw new Error(`${context}: repeated ID`);
  return ids;
};
const smallNumber = (value: unknown): number | null => {
  const n = finite(value);
  return n !== null && n >= 0 ? n : null;
};
const booleanNumber = (value: unknown): number | null => value === true ? 1 : value === false ? 0 : null;
const checkedLimit = (value: number) => { if (!Number.isInteger(value) || value < 1 || value > 3) throw new Error('Extended page limit must be 1–3'); return value; };
const checkedToken = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.length || value.length > 500) throw new Error('Invalid continuation cursor');
  return value;
};
const RECENT_TOKEN_LIMIT = 64;
const fingerprint = async (token: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest).slice(0, 12)].map(byte => byte.toString(16).padStart(2, '0')).join('');
};
const checkedRecent = (value: unknown): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > RECENT_TOKEN_LIMIT
    || value.some(item => typeof item !== 'string' || !/^[0-9a-f]{24}$/.test(item))) throw new Error('Invalid recent cursor tokens');
  return [...new Set(value)];
};
const checkedCountryHistory = (value: unknown): Record<string, string[]> => {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid country token history');
  const entries = Object.entries(value);
  if (entries.length > 500) throw new Error('Too many country token histories');
  return Object.fromEntries(entries.map(([country, history]) => [requiredId(country, 'history country'), checkedRecent(history)]));
};
const appendRecent = (history: string[], key: string): string[] => [...history.filter(item => item !== key), key].slice(-RECENT_TOKEN_LIMIT);
async function advanceToken(history: string[], current: string | undefined, next: string | undefined, context: string) {
  const withCurrent = current ? appendRecent(history, await fingerprint(current)) : history;
  if (!next) return [];
  const nextKey = await fingerprint(next);
  if (withCurrent.includes(nextKey)) throw new Error(`${context}: continuation cursor cycle detected`);
  return appendRecent(withCurrent, nextKey);
}
const checkedTokens = (value: unknown): Record<string, string> => {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid country cursors');
  const entries = Object.entries(value);
  if (entries.length > 500) throw new Error('Too many country cursors');
  return Object.fromEntries(entries.map(([id, token]) => {
    const checked = checkedToken(token);
    if (!checked) throw new Error('Invalid country continuation');
    return [requiredId(id, 'country cursor'), checked];
  }));
};
const checkedPage = (value: unknown, maximum: number, context: string) => {
  const page = pageSchema.parse(value);
  if (page.items.length > maximum) throw new Error(`${context}: page exceeds requested limit`);
  const nextCursor = checkedToken(page.nextCursor);
  if (nextCursor && !page.items.length) throw new Error(`${context}: empty continuation page`);
  return { items: page.items, nextCursor };
};
async function nextCountry(env: Env, after?: string): Promise<string | null> {
  const row = after
    ? await env.DB.prepare('SELECT id FROM countries WHERE id>? ORDER BY id LIMIT 1').bind(after).first<{ id: string }>()
    : null;
  const fallback = row ?? await env.DB.prepare('SELECT id FROM countries ORDER BY id LIMIT 1').first<{ id: string }>();
  return fallback ? requiredId(fallback.id, 'country') : null;
}

/** Store only verified public fields, never whole upstream company/election/government objects. */
export function normalizeExtendedEntity(source: ExtendedSource, input: unknown, client: WarEraClient, now: string): ExtendedNormalized {
  const raw = asObject(input);
  const recordId = requiredId(raw._id, source);
  // updated_at is the WINT observation time, matching snapshots and other sources.
  const base = { table: sourceTable[source], id: recordId, updated_at: now };
  if (source === 'companies') {
    const owner = safeId(raw.user), region = safeId(raw.region), itemCode = safeText(raw.itemCode, 100) || null;
    const upgrades = asObject(raw.activeUpgradeLevels);
    const data = { owner, region, itemCode, isFull: raw.isFull === true ? true : raw.isFull === false ? false : null,
      production: smallNumber(raw.production), workerCount: smallNumber(raw.workerCount), estimatedValue: smallNumber(raw.estimatedValue),
      concreteInvested: smallNumber(raw.concreteInvested), movedUpAt: dateString(raw.movedUpAt),
      upgrades: { storage: smallNumber(upgrades.storage), automatedEngine: smallNumber(upgrades.automatedEngine), breakRoom: smallNumber(upgrades.breakRoom) } };
    return { ...base, name: safeText(raw.name) || `Company ${recordId.slice(0, 8)}`, country_id: safeId(raw.country),
      source_url: client.url('company.getById', { companyId: recordId }), data_json: JSON.stringify(data),
      extra: { owner_id: owner, item_code: itemCode, level: null } };
  }
  if (source === 'elections') {
    const country = requiredId(raw.country, 'election country');
    // WarEra publishes per-candidate tallies in a separate `votes` map (candidate user ID -> votes);
    // `candidates[].voteCount` is observed as 0. Prefer the map, keep the field only as fallback.
    const tally = asObject(raw.votes);
    const hasTally = Object.keys(tally).length > 0;
    const candidates = Array.isArray(raw.candidates) ? raw.candidates.slice(0, 200).map(candidate => {
      const row = asObject(candidate), user = safeId(row.user);
      const mapped = user && hasTally ? smallNumber(tally[user] ?? 0) : null;
      return { user, party: safeId(row.party), voteCount: mapped ?? smallNumber(row.voteCount), isElected: row.isElected === true };
    }) : [];
    const electedCandidates = Array.isArray(raw.electedCandidates) ? idsOf(raw.electedCandidates.slice(0, 200), 'elected candidate') : [];
    const electionType = safeText(raw.type, 40) || null, status = safeText(raw.status, 60) || null;
    const data = { country, type: electionType, status, isActive: raw.isActive === true ? true : raw.isActive === false ? false : null,
      votesStartAt: dateString(raw.votesStartAt), votesEndAt: dateString(raw.votesEndAt), votesCount: smallNumber(raw.votesCount),
      electedCount: smallNumber(raw.electedCount), electedCandidates, candidates,
      candidatesTruncated: Array.isArray(raw.candidates) && raw.candidates.length > 200,
      electedCandidatesTruncated: Array.isArray(raw.electedCandidates) && raw.electedCandidates.length > 200,
      voteSource: hasTally ? 'votes-map' : 'candidate-field' };
    return { ...base, name: `Election ${electionType ?? 'unknown'}`, country_id: country,
      source_url: client.url('election.getElections', { countryId: country, limit: 3 }), data_json: JSON.stringify(data),
      extra: { election_type: electionType, status, votes_count: smallNumber(raw.votesCount), is_active: booleanNumber(raw.isActive),
        votes_start_at: dateString(raw.votesStartAt), votes_end_at: dateString(raw.votesEndAt), elected_count: smallNumber(raw.electedCount) } };
  }
  const country = requiredId(raw.country, 'government country');
  const members = Array.isArray(raw.congressMembers) ? idsOf(raw.congressMembers.slice(0, 200), 'congress member') : [];
  const data = { country, president: safeId(raw.president), vicePresident: safeId(raw.vicePresident),
    minOfDefense: safeId(raw.minOfDefense), minOfEconomy: safeId(raw.minOfEconomy),
    minOfForeignAffairs: safeId(raw.minOfForeignAffairs), congressMembers: members,
    congressTruncated: Array.isArray(raw.congressMembers) && raw.congressMembers.length > 200 };
  return { ...base, name: 'Government', country_id: country,
    source_url: client.url('government.getByCountryId', { countryId: country }), data_json: JSON.stringify(data),
    extra: { president_id: data.president, vice_president_id: data.vicePresident, congress_count: members.length } };
}

/** One bounded public page per tick. Country tokens stay in the atomic source cursor. */
export async function fetchExtendedBatch(env: Env, client: WarEraClient, source: ExtendedSource, cursor: ExtendedCursor = {}, limit = 3): Promise<ExtendedBatch> {
  const size = checkedLimit(limit);
  if (source === 'companies') {
    let ids: string[], nextCursor: string | undefined;
    const recent = checkedRecent(cursor.recentTokens);
    let nextRecent = recent;
    if (cursor.ids !== undefined) {
      if (!Array.isArray(cursor.ids) || cursor.ids.length > 5000) throw new Error('Invalid company ID cursor');
      ids = idsOf(cursor.ids, 'company cursor');
      nextCursor = checkedToken(cursor.token);
    } else {
      const token = checkedToken(cursor.token);
      const page = checkedPage(await client.get('company.getCompanies', { perPage: size, ...(token ? { cursor: token } : {}) }, pageSchema), size, 'company');
      ids = idsOf(page.items, 'company page');
      nextCursor = page.nextCursor;
      nextRecent = await advanceToken(recent, token, nextCursor, 'Company');
    }
    const offset = cursor.ids === undefined ? 0 : cursor.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0 || offset > ids.length) throw new Error('Invalid company offset');
    if (cursor.ids !== undefined && offset === ids.length && nextCursor) throw new Error('Company: empty continuation page');
    const selected = ids.slice(offset, offset + size);
    const records = await client.getMany('company.getById', selected.map(companyId => ({ companyId })), detailSchema);
    records.forEach((record, index) => { if (record._id !== selected[index]) throw new Error('Company detail ID mismatch'); });
    const next = offset + size < ids.length ? { ids, offset: offset + size, ...(nextCursor ? { token: nextCursor } : {}), recentTokens: nextRecent }
      : nextCursor ? { token: nextCursor, recentTokens: nextRecent } : null;
    return { records, next, delay: next ? 300 : 86400 };
  }
  const lastCountryId = cursor.lastCountryId === undefined ? undefined : requiredId(cursor.lastCountryId, 'last country');
  const legacyCountry = cursor.countryId && !lastCountryId ? requiredId(cursor.countryId, 'legacy country') : null;
  const country = legacyCountry ?? await nextCountry(env, lastCountryId);
  if (!country) return { records: [], next: null, delay: 86400 };
  if (source === 'governments') {
    const record = await client.get('government.getByCountryId', { countryId: country }, detailSchema.nullable());
    if (record && record.country !== country) throw new Error('Government returned a mismatched country');
    return { records: record ? [record] : [], next: { lastCountryId: country }, delay: 300 };
  }
  const tokens = checkedTokens(cursor.tokens);
  const histories = checkedCountryHistory(cursor.recentTokensByCountry);
  for (const id of Object.keys(histories)) if (!tokens[id] && !(legacyCountry === id && cursor.token)) delete histories[id];
  const token = checkedToken(legacyCountry ? cursor.token : tokens[country]);
  const page = checkedPage(await client.get('election.getElections', { countryId: country, limit: size, ...(token ? { cursor: token } : {}) }, pageSchema), size, 'election');
  const ids = idsOf(page.items.map(item => asObject(item)._id), 'election page');
  page.items.forEach((item, index) => {
    const row = asObject(item);
    if (row._id !== ids[index] || row.country !== country) throw new Error('Election returned a mismatched country or ID');
  });
  const nextRecent = await advanceToken(histories[country] ?? [], token, page.nextCursor, 'Election');
  if (page.nextCursor) { tokens[country] = page.nextCursor; histories[country] = nextRecent; }
  else { delete tokens[country]; delete histories[country]; }
  return { records: page.items, next: { lastCountryId: country, tokens, recentTokensByCountry: histories }, delay: 300 };
}
