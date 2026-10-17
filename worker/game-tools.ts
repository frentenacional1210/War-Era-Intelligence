import type { Env } from './types';
import { WarEraClient, WarEraError, pagedObjectsSchema } from './warera';
import { normalizeExtendedEntity } from './extended-ingestion';
import { projectGameConfig, type GameConfig } from '../shared/game-config';
import { projectElection } from '../shared/election-projection';
import snapshot from '../shared/game-config.snapshot.json';
import { z } from 'zod';

/**
 * Read-only tool endpoints. Live upstream reads are public, cached at the edge
 * and never written to D1, so they cost no ingestion budget.
 */
const CONFIG_TTL = 6 * 3600, LIVE_TTL = 120;
const json = (data: unknown, maxAge: number, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': `public, max-age=${maxAge}, s-maxage=${maxAge}`, 'X-Content-Type-Options': 'nosniff' } });
const anyData = z.unknown();
const liteName = z.object({ _id: z.string(), username: z.string().max(100), leveling: z.object({ level: z.number().nullable().optional() }).partial().optional() }).passthrough();

async function cached(request: Request, ttl: number, build: () => Promise<Response>): Promise<Response> {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const key = new Request(new URL(request.url).toString(), { method: 'GET' });
  const hit = cache ? await cache.match(key) : undefined;
  if (hit) return hit;
  const response = await build();
  if (cache && response.ok) await cache.put(key, response.clone()).catch(() => undefined);
  return response;
}

export async function loadGameConfig(env: Env): Promise<GameConfig> {
  try {
    const raw = await new WarEraClient(env.WARERA_BASE_URL, env.WARERA_API_KEY).get('gameConfig.getGameConfig', {}, anyData);
    const config = projectGameConfig(raw, 'live', new Date().toISOString());
    if (Object.keys(config.skills).length && config.items.length) return config;
  } catch { /* fall back to the dated snapshot below */ }
  return snapshot as unknown as GameConfig;
}

type ElectionRow = { id: string; country_id: string; votes_end_at: string | null; is_active: number | null };

export async function liveElections(env: Env, countryId: string, now = new Date()) {
  const client = new WarEraClient(env.WARERA_BASE_URL, env.WARERA_API_KEY);
  const page = await client.get('election.getElections', { countryId, limit: 3 }, pagedObjectsSchema);
  const elections = page.items.map(item => {
    const row = normalizeExtendedEntity('elections', item, client, now.toISOString());
    const data = JSON.parse(row.data_json) as { type: string | null; status: string | null; electedCount: number | null; votesStartAt: string | null; votesEndAt: string | null; votesCount: number | null; voteSource: string;
      candidates: { user: string | null; party: string | null; voteCount: number | null }[] };
    const projection = projectElection({ type: data.type, electedCount: data.electedCount, votesStartAt: data.votesStartAt, votesEndAt: data.votesEndAt,
      candidates: data.candidates.filter(c => c.user).map(c => ({ user: c.user!, party: c.party, votes: c.voteCount ?? 0 })) }, now);
    return { id: row.id, type: data.type, status: data.status, votesStartAt: data.votesStartAt, votesEndAt: data.votesEndAt, votesCount: data.votesCount, voteSource: data.voteSource, sourceUrl: row.source_url, projection };
  });
  const users = [...new Set(elections.flatMap(e => e.projection.candidates.map(c => c.user)))].slice(0, 90);
  const parties = [...new Set(elections.flatMap(e => e.projection.candidates.map(c => c.party).filter((p): p is string => !!p)))].slice(0, 90);
  const [players, partyRows, country] = await Promise.all([
    users.length ? env.DB.prepare(`SELECT id,name,level FROM players WHERE id IN (${users.map(() => '?').join(',')})`).bind(...users).all<{ id: string; name: string; level: number | null }>() : { results: [] },
    parties.length ? env.DB.prepare(`SELECT id,name FROM parties WHERE id IN (${parties.map(() => '?').join(',')})`).bind(...parties).all<{ id: string; name: string }>() : { results: [] },
    env.DB.prepare('SELECT id,name FROM countries WHERE id=?').bind(countryId).first<{ id: string; name: string }>(),
  ]);
  const known: Record<string, { name: string; level: number | null }> = Object.fromEntries(players.results.map(p => [p.id, { name: p.name, level: p.level }]));
  // Candidates WINT has not captured (e.g. not yet swept) still deserve a name: look up the
  // leading places only, in at most three public batches of eight, never persisted.
  const leading = [...new Set(elections.flatMap(e => e.projection.candidates.slice(0, Math.max(8, e.projection.seats + 3)).map(c => c.user)))].filter(id => !known[id]).slice(0, 24);
  for (let start = 0; start < leading.length; start += 8) {
    try {
      const rows = await client.getMany('user.getUserLite', leading.slice(start, start + 8).map(userId => ({ userId })), liteName);
      for (const row of rows) known[row._id] = { name: row.username, level: row.leveling?.level ?? null };
    } catch { break; }
  }
  return { country: country ?? { id: countryId, name: null }, observedAt: now.toISOString(), elections,
    names: { players: known, parties: Object.fromEntries(partyRows.results.map(p => [p.id, p.name])) } };
}

export async function gameToolsRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!['/api/game-config', '/api/elections/live'].includes(url.pathname)) return null;
  if (!['GET', 'HEAD'].includes(request.method)) return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'GET, HEAD' } });
  if (url.pathname === '/api/game-config') return cached(request, CONFIG_TTL, async () => json(await loadGameConfig(env), CONFIG_TTL));
  const country = url.searchParams.get('country');
  if (!country) {
    // Countries with an election open now or closed in the last 48 hours, from captured records.
    const now = new Date(), recent = new Date(now.getTime() - 48 * 3_600_000).toISOString();
    const rows = await env.DB.prepare(`SELECT e.id,e.country_id,c.name country_name,e.election_type,e.votes_end_at,e.is_active FROM elections e LEFT JOIN countries c ON c.id=e.country_id
      WHERE e.votes_end_at>=? ORDER BY e.votes_end_at DESC LIMIT 60`).bind(recent).all<ElectionRow & { country_name: string | null; election_type: string | null }>();
    // The stored is_active flag can lag; the official closing time decides whether voting is open.
    return json({ elections: rows.results.map(row => ({ id: row.id, countryId: row.country_id, countryName: row.country_name, type: row.election_type, votesEndAt: row.votes_end_at,
      active: !!row.votes_end_at && row.votes_end_at > now.toISOString() })) }, 300);
  }
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(country)) return Response.json({ error: 'País no válido.' }, { status: 400 });
  return cached(request, LIVE_TTL, async () => {
    try { return json(await liveElections(env, country), LIVE_TTL); }
    catch (error) {
      const message = error instanceof WarEraError && error.status === 429 ? 'WarEra limita las consultas; inténtalo en un minuto.' : 'No se pudo consultar WarEra en este momento.';
      return Response.json({ error: message }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  });
}
