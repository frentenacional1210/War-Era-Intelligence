import type { Env } from './types';
import { runSync } from './ingestion';
import { runHistoryMaintenance } from './history-maintenance';
import { WarEraError } from './warera';
import { INGESTION_DAILY_BUDGET, INGESTION_DAILY_READ_BUDGET, INGESTION_READ_RESERVATION, PAGE_ROWS, COLLECTOR_PLAYER_ROWS } from '../shared/ingestion-config';
import { projectPlayer, projectPublicPage, type PublicPage, type PublicSource } from '../shared/public-projection';

type Plan = { status: 'ready'; source: PublicSource; cursorExpected: string | null; procedure: string; inputs: Record<string, unknown> };
type State = { cursor: string | null; next_run_at: string; lease_until: string | null; enabled: number };
type Cursor = { token?: string; countryId?: string; rotation?: boolean; archiveToken?: string; archiveComplete?: boolean; headNextAt?: string };
const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers });
const sourceValue = (value: unknown): PublicSource | null => value === 'players' || value === 'articles' ? value : null;
const parseCursor = (value: string | null): Cursor => { try { return value ? JSON.parse(value) as Cursor : {}; } catch { return {}; } };
const sameInput = (actual: unknown, expected: Record<string, unknown>): boolean => {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const values = actual as Record<string, unknown>;
  return Object.keys(values).length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => values[key] === value);
};
const validInput = (source: PublicSource, input: unknown): input is Record<string, unknown> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const row = input as Record<string, unknown>;
  const keys = Object.keys(row).sort().join(',');
  const optionalCursor = row.cursor === undefined || (typeof row.cursor === 'string' && row.cursor.length > 0 && row.cursor.length <= 500);
  if (!optionalCursor) return false;
  if (source === 'players') return (keys === 'countryId,limit' || keys === 'countryId,cursor,limit') &&
    typeof row.countryId === 'string' && row.countryId.length > 0 && row.countryId.length <= 100 && row.limit === COLLECTOR_PLAYER_ROWS;
  return (keys === 'limit,type' || keys === 'cursor,limit,type') && row.type === 'last' && row.limit === PAGE_ROWS;
};
const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
async function authorized(request: Request, secret: string | undefined): Promise<boolean> {
  if (!secret || secret.length < 24 || secret.length > 512) return false;
  const match = /^Bearer ([^\s]{1,512})$/.exec(request.headers.get('Authorization') ?? '');
  if (!match) return false;
  const [candidate, expected] = await Promise.all([digest(match[1]), digest(secret)]);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= candidate[i] ^ expected[i];
  return difference === 0;
}
async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('Content-Length') ?? 0) > 32_768) throw new WarEraError('Collector body too large', 413);
  const reader=request.body?.getReader(),chunks:Uint8Array[]=[];let length=0;
  if(reader)while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>32_768){await reader.cancel();throw new WarEraError('Collector body too large',413);}chunks.push(part.value);}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  const text=new TextDecoder().decode(bytes);
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Invalid JSON is handled below. */ }
  throw new WarEraError('Invalid collector body', 400);
}

async function plan(env: Env, source: PublicSource): Promise<Plan | { status: string; source: PublicSource; nextRunAt?: string }> {
  if (env.SYNC_ENABLED === 'false') return { status: 'disabled', source };
  const now = new Date().toISOString();
  const state = await env.DB.prepare(`SELECT c.cursor,c.next_run_at,c.lease_until,r.enabled FROM ingestion_cursors c
    JOIN source_registry r ON r.id=c.source_id WHERE c.source_id=?`).bind(source).first<State>();
  if (!state || !state.enabled) return { status: 'disabled', source };
  if (state.lease_until && state.lease_until > now) return { status: 'busy', source };
  const reservation = 140 + (source === 'players' ? COLLECTOR_PLAYER_ROWS*70 : PAGE_ROWS*35);
  const budget = await env.DB.prepare('SELECT reserved_writes,reserved_reads,database_bytes FROM ingestion_budget WHERE day_key=?').bind(now.slice(0, 10)).first<{ reserved_writes: number; reserved_reads:number;database_bytes:number|null }>();
  if (Number(budget?.reserved_writes ?? 0) + reservation > INGESTION_DAILY_BUDGET) return { status: 'quota-paused', source };
  if (Number(budget?.reserved_reads ?? 0) + INGESTION_READ_RESERVATION > INGESTION_DAILY_READ_BUDGET || Number(budget?.database_bytes ?? 0)>450_000_000) return {status:'quota-paused',source};
  const cursor = parseCursor(state.cursor);
  if (source === 'articles') {
    const archiveToken = cursor.archiveToken ?? cursor.token;
    const head = cursor.archiveComplete || Boolean(archiveToken && cursor.headNextAt && cursor.headNextAt <= now);
    return { status: 'ready', source, cursorExpected: state.cursor, procedure: 'article.getArticlesPaginated',
      inputs: { limit: PAGE_ROWS, type: 'last', ...(!head && archiveToken ? { cursor: archiveToken } : {}) } };
  }
  const country = cursor.countryId && !cursor.rotation
    ? await env.DB.prepare('SELECT id FROM countries WHERE id=? LIMIT 1').bind(cursor.countryId).first<{ id: string; token?: string }>()
    : await env.DB.prepare(`SELECT c.id,s.cursor token FROM countries c LEFT JOIN player_census_state s ON s.country_id=c.id
        WHERE s.next_run_at IS NULL OR s.next_run_at<=?
        ORDER BY COALESCE(s.last_scanned_at,''),CASE WHEN lower(c.code)='es' OR c.name='Spain' THEN 0 ELSE 1 END,c.id LIMIT 1`)
      .bind(now).first<{ id: string; token?: string }>();
  if (!country) return { status: 'idle', source };
  const token = cursor.countryId && !cursor.rotation ? cursor.token : country.token;
  return { status: 'ready', source, cursorExpected: state.cursor, procedure: 'user.getUsersByCountry',
    inputs: { countryId: country.id, limit: COLLECTOR_PLAYER_ROWS, ...(token ? { cursor: token } : {}) } };
}

function suppliedFetcher(planValue: Plan, page: PublicPage, profiles: Record<string, unknown>[]): typeof fetch {
  let listUsed = false, detailsUsed = false;
  return (async (request, init) => {
    const url = new URL(String(request));
    const procedure = url.pathname.split('/').at(-1);
    if (procedure === planValue.procedure && init?.method === 'GET' && !listUsed) {
      let input: unknown;
      try { input = JSON.parse(url.searchParams.get('input') ?? '{}'); } catch { throw new WarEraError('Collector input mismatch', 409); }
      if (!sameInput(input, planValue.inputs)) throw new WarEraError('Collector input mismatch', 409);
      listUsed = true;
      return Response.json({ result: { data: page } });
    }
    if (planValue.source === 'players' && init?.method === 'POST' && !detailsUsed) {
      if (url.searchParams.get('batch') !== '1' || procedure !== Array(profiles.length).fill('user.getUserLite').join(',')) throw new WarEraError('Collector batch mismatch', 409);
      let input: Record<string, { userId?: unknown }>;
      try { input = JSON.parse(String(init.body)); } catch { throw new WarEraError('Collector batch mismatch', 409); }
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== profiles.length || !profiles.every((profile, index) => input[String(index)]?.userId === profile._id)) throw new WarEraError('Collector batch mismatch', 409);
      detailsUsed = true;
      return Response.json(profiles.map(profile => ({ result: { data: profile } })));
    }
    throw new WarEraError('Collector request mismatch', 409);
  }) as typeof fetch;
}

/** Route authenticated collector traffic before the public API router. */
export async function collectorRoute(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!['/api/collector/plan','/api/collector/commit','/api/collector/maintenance'].includes(path)) return null;
  if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  if (!await authorized(request, (env as Env & { COLLECTOR_SECRET?: string }).COLLECTOR_SECRET)) return reply({ error: 'Unauthorized' }, 401);
  if(path.endsWith('/maintenance'))return reply(await runHistoryMaintenance(env));
  try {
    const body = await bodyOf(request);
    const source = sourceValue(body.source);
    if (!source) return reply({ error: 'Invalid source' }, 400);
    if(env.SYNC_ENABLED==='false')return reply({status:'disabled',source});
    if (path.endsWith('/plan')) return reply(await plan(env, source));
    if ((body.cursorExpected !== null && (typeof body.cursorExpected !== 'string' || body.cursorExpected.length > 16_000)) ||
      !validInput(source, body.input)) return reply({ error: 'Invalid collector plan' }, 400);
    const expected: Plan = { status: 'ready', source, cursorExpected: body.cursorExpected,
      procedure: source === 'players' ? 'user.getUsersByCountry' : 'article.getArticlesPaginated', inputs: body.input };
    const page = projectPublicPage(source, body.page, source === 'players' ? COLLECTOR_PLAYER_ROWS : PAGE_ROWS);
    let profiles: Record<string, unknown>[] = [];
    if (source === 'players') {
      if (!Array.isArray(body.profiles) || body.profiles.length !== page.items.length || body.profiles.length > COLLECTOR_PLAYER_ROWS) return reply({ error: 'Player profile count mismatch' }, 400);
      profiles = body.profiles.map(projectPlayer);
      if (profiles.some((profile, index) => profile._id !== page.items[index]._id)) return reply({ error: 'Player profile order mismatch' }, 400);
    } else if (body.profiles !== undefined) return reply({ error: 'Unexpected profiles' }, 400);
    const result = await runSync(env, { source, force: true, expectedCursor: expected.cursorExpected, fetcher: suppliedFetcher(expected, page, profiles) });
    console.info('wint_collector_sync', { status: result.status, source: result.source, processed: result.processed });
    return reply(result, result.status === 'busy' ? 409 : 200);
  } catch (error) {
    if (error instanceof WarEraError && error.status === 409) return reply({ error: 'Stale collector plan' }, 409);
    const status = error instanceof WarEraError && error.status === 413 ? 413 : 400;
    return reply({ error: status === 413 ? 'Collector body too large' : 'Invalid collector payload' }, status);
  }
}
