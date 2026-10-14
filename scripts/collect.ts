/** Scheduled public-data collector. Complete profiles and article bodies stay in this process only. */
import { WarEraClient, WarEraError, pagedObjectsSchema, pagedPlayersSchema } from '../worker/warera';
import { projectPublicPage, type PublicSource } from '../shared/public-projection';
import { collectPlayerProfiles } from '../shared/active-player-collection';
import { PAGE_ROWS, COLLECTOR_PLAYER_ROWS } from '../shared/ingestion-config';

type Plan = { status: string; source: PublicSource; cursorExpected?: string | null; procedure?: string; inputs?: Record<string, unknown> };
type Commit = { status: string; source?: string; processed?: number; changed?: number; nextRunAt?: string };
const origin = process.env.WINT_URL ?? 'https://warera-intelligence.warera-intelligence.workers.dev';
const secret = process.env.COLLECTOR_SECRET;
const stepLimit = Number(process.env.MAX_STEPS ?? 80);
if (!origin.startsWith('https://') || !secret || secret.length < 24 || !Number.isInteger(stepLimit) || stepLimit < 1 || stepLimit > 80) {
  throw new Error('Collector requires HTTPS WINT_URL, COLLECTOR_SECRET (24+ chars), and MAX_STEPS 1–80');
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const warera = new WarEraClient();
let lastUpstreamAt = 0;

async function upstream<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const pause = 2000 - (Date.now() - lastUpstreamAt);
    if (pause > 0) await sleep(pause);
    lastUpstreamAt = Date.now();
    try { return await call(); }
    catch (error) {
      if (!(error instanceof WarEraError) || error.status !== 429 || attempt === 2) throw error;
      await sleep(Math.max(2000, (error.retryAfterSeconds ?? 60) * 1000));
    }
  }
  throw new Error('WarEra request exhausted retries');
}

async function collectorRequest<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  const body = JSON.stringify(payload);
  if (new TextEncoder().encode(body).byteLength > 32_768) throw new Error('Collector request exceeds Worker body limit');
  const response = await fetch(new URL(path, origin), {
    method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body, signal: AbortSignal.timeout(30_000),
  });
  const value = await response.json() as T;
  if (response.status === 409) return { status: 'busy' } as T;
  if (!response.ok) throw new Error(`Collector ${path} HTTP ${response.status}`);
  return value;
}

async function collect(source: PublicSource): Promise<Commit | Plan> {
  const plan = await collectorRequest<Plan>('/api/collector/plan', { source });
  if (plan.status !== 'ready' || !plan.procedure || !plan.inputs) return plan;
  if (source === 'players') {
    const page = await upstream(() => warera.get(plan.procedure!, plan.inputs, pagedPlayersSchema));
    const projected = projectPublicPage(source, page, COLLECTOR_PLAYER_ROWS);
    const ids = projected.items.map(item => String(item._id));
    const profiles = await collectPlayerProfiles(warera, ids, upstream, COLLECTOR_PLAYER_ROWS);
    return collectorRequest<Commit>('/api/collector/commit', { source, cursorExpected: plan.cursorExpected ?? null, input: plan.inputs, page: projected, profiles });
  }
  const page = await upstream(() => warera.get(plan.procedure!, plan.inputs, pagedObjectsSchema));
  return collectorRequest<Commit>('/api/collector/commit', { source, cursorExpected: plan.cursorExpected ?? null, input: plan.inputs, page: projectPublicPage(source, page, PAGE_ROWS) });
}

async function main() {
  const maintenance=await collectorRequest<{status:string}>('/api/collector/maintenance',{});
  console.info(JSON.stringify({kind:'history-maintenance',status:maintenance.status,at:new Date().toISOString()}));
  for (let step = 0; step < stepLimit; step++) {
    const source: PublicSource = step % 2 === 0 ? 'players' : 'articles';
    const result = await collect(source);
    console.info(JSON.stringify({ at: new Date().toISOString(), source, status: result.status, processed: 'processed' in result ? result.processed : undefined, step: step + 1 }));
    if (result.status === 'quota-paused' || result.status === 'disabled') break;
    if (result.status === 'busy' || result.status === 'idle') await sleep(2000);
    if (result.status === 'error') throw new Error('Collector commit failed');
  }
}
main().catch(error => { console.error('Collector failed', error instanceof WarEraError ? `WarEra ${error.status ?? 'request'} failure` : 'request failure'); process.exitCode = 1; });
