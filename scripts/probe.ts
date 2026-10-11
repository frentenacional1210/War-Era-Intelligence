/** Small, anonymous, sequential contract probe. Writes metadata only, never response bodies. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const base = 'https://api2.warera.io/trpc/';
const results: Record<string, unknown>[] = [];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function shape(data: unknown): Record<string, unknown> {
  if (Array.isArray(data)) return { kind: 'array', count: data.length, itemKeys: data[0] && typeof data[0] === 'object' ? Object.keys(data[0]) : [] };
  if (data && typeof data === 'object') {
    const object = data as Record<string, unknown>;
    if (Array.isArray(object.items)) return { kind: 'page', count: object.items.length, itemKeys: object.items[0] && typeof object.items[0] === 'object' ? Object.keys(object.items[0]) : [], hasNextCursor: typeof object.nextCursor === 'string' };
    return { kind: 'object', count: Object.keys(object).length, keys: Object.keys(object).slice(0, 12) };
  }
  return { kind: typeof data };
}
async function probe(name: string, procedure: string, input?: Record<string, unknown>, method: 'GET' | 'POST' = 'GET') {
  const url = new URL(procedure, base);
  if (input && method === 'GET') url.searchParams.set('input', JSON.stringify(input));
  const response = await fetch(url, { method, headers: { Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, body: method === 'POST' ? JSON.stringify(input ?? {}) : undefined, signal: AbortSignal.timeout(15_000) });
  let body: unknown;
  try { body = await response.json(); } catch { body = null; }
  const data = (body as { result?: { data?: unknown } } | null)?.result?.data;
  const entry = { name, procedure, method, input: input ?? {}, status: response.status, rateLimit: { limit: response.headers.get('ratelimit-limit'), remaining: response.headers.get('ratelimit-remaining'), reset: response.headers.get('ratelimit-reset') }, ...shape(data) };
  results.push(entry);
  console.log(JSON.stringify(entry));
  await sleep(600);
  return data;
}
async function main() {
  const countries = await probe('countries', 'country.getAllCountries') as { _id: string; name: string }[];
  const spain = countries.find(country => country.name === 'Spain')?._id;
  if (!spain) throw new Error('Spain ID not found in live countries; cannot probe player pagination');
  await probe('country-detail', 'country.getCountryById', { countryId: spain });
  const regions = await probe('regions', 'region.getRegionsObject') as Record<string, unknown>;
  const regionId = Object.keys(regions)[0];
  if (regionId) await probe('region-detail', 'region.getById', { regionId });
  const users = await probe('players', 'user.getUsersByCountry', { countryId: spain, limit: 2 }) as { items: { _id: string }[] };
  if (users.items[0]) await probe('player-detail', 'user.getUserLite', { userId: users.items[0]._id });
  const parties = await probe('parties', 'party.getManyPaginated', { countryId: spain, limit: 2 }) as { items: { _id: string }[] };
  if (parties.items[0]) await probe('party-detail', 'party.getById', { partyId: parties.items[0]._id });
  const units = await probe('military-units', 'mu.getManyPaginated', { limit: 2 }) as { items: { _id: string }[] };
  if (units.items[0]) await probe('unit-detail', 'mu.getById', { muId: units.items[0]._id });
  const battles = await probe('battles', 'battle.getBattles', { limit: 2, isActive: true }) as { items: { _id: string }[] };
  if (battles.items[0]) await probe('battle-detail', 'battle.getById', { battleId: battles.items[0]._id });
  const articles = await probe('articles', 'article.getArticlesPaginated', { type: 'last', limit: 2 }) as { items: { _id: string }[] };
  if (articles.items[0]) {
    await probe('article-detail', 'article.getArticleById', { articleId: articles.items[0]._id });
    await probe('article-lite', 'article.getArticleLiteById', { articleId: articles.items[0]._id });
  }
  await probe('markets', 'itemTrading.getPrices');
  await probe('markets-post', 'itemTrading.getPrices', {}, 'POST');
  const path = join('artifacts', 'probes');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'probe-results.json'), JSON.stringify({ probedAt: new Date().toISOString(), results }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
