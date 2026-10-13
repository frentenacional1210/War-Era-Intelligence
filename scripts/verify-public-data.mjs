import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const origin = new URL(process.env.WINT_URL ?? 'https://warera-intelligence.warera-intelligence.workers.dev').origin;
if (!origin.startsWith('https://')) throw Error('Use the public HTTPS deployment.');
const resources = ['countries', 'regions', 'players', 'parties', 'military-units', 'battles', 'articles', 'companies', 'elections', 'governments', 'events', 'alerts', 'markets', 'orderbooks'];
let requests = 0;
async function request(path, init = {}, status = 200) {
  const url = new URL(path, origin);
  assert.equal(url.origin, origin, 'Pagination must stay on the verified origin');
  assert.ok(++requests <= 100, 'Bound verification below the public per-minute request limit');
  const response = await fetch(url, { ...init, headers: { Origin: 'https://consumer.example', ...init.headers }, signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, status, `${url.pathname}${url.search}`);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  return response;
}

const response = await request('/api/data');
assert.match(response.headers.get('content-type'), /application\/json/);
const catalog = await response.json();
assert.equal(catalog.schemaVersion, '1.0');
assert.equal(catalog.mode, 'catalog');
assert.deepEqual(Object.keys(catalog.datasets), resources);
const counts = {};
for (const resource of resources) {
  const dataset = catalog.datasets[resource];
  counts[resource] = dataset.totalCaptured;
  assert.ok(dataset.items.length <= 5);
  assert.equal(dataset.pagination.returned, dataset.items.length);
  const page = await (await request(dataset.url)).json();
  assert.equal(page.resource, resource);
  assert.equal(page.mode, 'dataset');
  assert.equal(page.coverage, null);
  assert.deepEqual(Object.keys(page.datasets), [resource]);
  assert.ok(page.datasets[resource].items.length <= 50);
}

// Prove the catalog's small preview leads to every captured player, without offsets or duplicates.
const ids = new Set();
let pages = 1;
let current = catalog.datasets.players;
while (true) {
  for (const item of current.items) {
    assert.ok(!ids.has(item.id), 'No duplicate player between pages');
    ids.add(item.id);
  }
  if (!current.pagination.hasMore) {
    assert.equal(current.pagination.nextUrl, null);
    break;
  }
  assert.ok(current.pagination.nextUrl);
  current = (await (await request(current.pagination.nextUrl)).json()).datasets.players;
  pages++;
}
assert.equal(ids.size, counts.players, 'All players counted in the paused captured dataset are reachable');

const head = await request('/api/data?limit=3', { method: 'HEAD' });
assert.equal(await head.text(), '');
assert.equal((await (await request('/api/data?limit=3')).json()).schemaVersion, '1.0');
await request('/api/data', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'GET' } }, 204);
await request('/api/data', { method: 'POST' }, 405);
await request('/api/data?resource=admin', {}, 400);
await request('/api/data?limit=51', {}, 400);
const specResponse = await fetch(`${origin}/openapi.json`, { signal: AbortSignal.timeout(20000) });
assert.equal(specResponse.status, 200);
assert.ok((await specResponse.json()).paths['/api/data'].get);

const evidence = {
  verifiedAt: new Date().toISOString(), origin, workerVersion: process.env.WINT_WORKER_VERSION ?? null,
  passed: true, authenticated: false, schemaVersion: catalog.schemaVersion,
  resources, counts, coverage: catalog.coverage, cors: '*',
  playerTraversal: { pages, uniqueRecords: ids.size, duplicates: 0, completeAgainstCapturedCount: true },
  checks: ['JSON catalog', 'all resource pages', 'player traversal from catalog preview', 'HEAD then GET', 'OPTIONS', 'read-only POST', 'invalid resource', 'invalid limit', 'published OpenAPI'],
  publicApiRequests: requests,
  limitations: ['Captured counts are not game-wide totals.', 'Traversal completeness was checked against this captured player count; live pages are not an atomic export.'],
};
await mkdir('artifacts/validation', { recursive: true });
await writeFile('artifacts/validation/public-data.json', JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
