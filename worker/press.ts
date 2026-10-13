import type { Env } from './types';
import {
  classifyPressTitle, relatedPressArticles, PRESS_CLASSIFICATION, PRESS_COVERAGE,
  PRESS_SAMPLE_LIMIT, PRESS_TOPICS, type PressArticle, type PressResponse,
} from '../shared/press';

type ArticleRow = { id: string; title: string; country_id: string | null; author_id: string | null;
  published_at: string | null; language: string | null; source_url: string; updated_at: string };
const readHeaders = { 'Cache-Control': 'public, max-age=60, s-maxage=90', 'X-Content-Type-Options': 'nosniff' };
const error = (status: number, message: string) => Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
const one = (params: URLSearchParams, key: string): string | null => {
  const values = params.getAll(key);
  if (values.length > 1) throw new Error(`Repeated ${key} filter`);
  return values.length ? values[0] : null;
};
const day = (value: string | null): string | null => {
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0,10) !== value)
    throw new Error('Invalid UTC day');
  return value;
};
const dateTime = (value: string | null): string | null => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const title = (value: string): string => value.replace(/<[^>]*>/g,'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,300);
const source = (value: string): string => {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.toString() : ''; }
  catch { return ''; }
};

/** D1-only press sample. No article body, upstream fetch, or derived persistence. */
export async function pressRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/press') return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return error(405, 'La hemeroteca es de solo lectura.');
  let country: string | null, language: string | null, from: string | null, to: string | null, limit: number;
  try {
    for (const key of url.searchParams.keys()) if (!['country','language','from','to','limit'].includes(key)) throw new Error('Unsupported filter');
    country = one(url.searchParams,'country');
    language = one(url.searchParams,'language');
    from = day(one(url.searchParams,'from'));
    to = day(one(url.searchParams,'to'));
    const rawLimit = one(url.searchParams,'limit');
    limit = rawLimit === null ? 50 : Number(rawLimit);
    if (country !== null && !/^[A-Za-z0-9_-]{1,100}$/.test(country)) throw new Error('Invalid country');
    if (language !== null && !/^[A-Za-z-]{2,16}$/.test(language)) throw new Error('Invalid language');
    if (!Number.isInteger(limit) || limit < 1 || limit > PRESS_SAMPLE_LIMIT) throw new Error('Invalid limit');
    if (from && to && from > to) throw new Error('Invalid date range');
  } catch { return error(400, 'Filtros de hemeroteca inválidos.'); }
  const clauses: string[] = [];
  const bindings: (string | number)[] = [];
  if (country) { clauses.push('country_id=?'); bindings.push(country); }
  if (from) { clauses.push('published_at>=?'); bindings.push(`${from}T00:00:00.000Z`); }
  if (to) {
    const exclusive = new Date(Date.parse(`${to}T00:00:00.000Z`) + 86_400_000).toISOString();
    clauses.push('published_at<?'); bindings.push(exclusive);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  // Country/date predicates use existing published-at indexes; language is
  // applied to this fixed sample so sparse languages never cause an unbounded scan.
  const rows = (await env.DB.prepare(`SELECT id,title,country_id,author_id,published_at,language,source_url,updated_at
    FROM articles ${where} ORDER BY published_at DESC,id DESC LIMIT ${PRESS_SAMPLE_LIMIT}`)
    .bind(...bindings).all<ArticleRow>()).results;
  const all: PressArticle[] = rows.filter(row => language === null || row.language?.toLowerCase() === language.toLowerCase())
    .map(row => {
      const safeTitle = title(row.title);
      return { id: row.id, title: safeTitle, countryId: row.country_id, authorId: row.author_id,
        publishedAt: dateTime(row.published_at), observedAt: row.updated_at,
        language: row.language, sourceUrl: source(row.source_url), topics: classifyPressTitle(safeTitle), related: [] };
    });
  const daily = new Map<string,number>();
  const topics = new Map<(typeof PRESS_TOPICS)[number],number>(PRESS_TOPICS.map(topic => [topic,0]));
  let unknownDateCount = 0;
  for (const article of all) {
    if (article.publishedAt) {
      const date = article.publishedAt.slice(0,10);
      daily.set(date,(daily.get(date) ?? 0)+1);
    } else unknownDateCount++;
    for (const topic of article.topics) topics.set(topic,(topics.get(topic) ?? 0)+1);
  }
  const items = all.slice(0,limit);
  for (const article of items) article.related = relatedPressArticles(article,all,6);
  const result: PressResponse = { items,
    trends: { daily: [...daily].sort(([a],[b]) => a.localeCompare(b)).map(([date,count]) => ({date,count})),
      unknownDateCount, topics: PRESS_TOPICS.map(topic => ({topic,count:topics.get(topic) ?? 0})) },
    sampled: rows.length, matched: all.length, limit, coverage: PRESS_COVERAGE,
    isSample: true, classification: PRESS_CLASSIFICATION };
  return request.method === 'HEAD' ? new Response(null,{status:200,headers:readHeaders}) : Response.json(result,{headers:readHeaders});
}
