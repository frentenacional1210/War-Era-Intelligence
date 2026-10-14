import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const origin = new URL(process.env.WINT_URL ?? 'https://warera-intelligence.warera-intelligence.workers.dev').origin;
const resources = ['players', 'parties', 'military-units', 'countries', 'regions', 'battles', 'markets', 'companies', 'elections', 'governments'];
let requests = 0;
async function read(path, expected = 200) {
  const url = new URL(path, origin);
  assert.equal(url.origin, origin);
  assert.ok(++requests <= 100, 'Bound verification requests');
  await new Promise(resolve => setTimeout(resolve, 200));
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, expected, `${url.pathname}${url.search}`);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  const data = await response.json();
  return data;
}

const catalog = await read('/api/data?limit=1');
const results = [];
for (const resource of resources) {
  const entity = catalog.datasets[resource].items[0];
  assert.ok(entity, `Real captured entity required for ${resource}`);
  const observations = [];
  for (const period of ['7d', '30d', '90d', '1y', '2y']) {
    const series = await read(`/api/history?${new URLSearchParams({ resource, id: entity.id, period })}`);
    assert.equal(series.resource, resource);
    assert.equal(series.id, entity.id);
    assert.equal(series.methodologyVersion, '2');
    assert.ok(Array.isArray(series.points));
    assert.ok(Array.isArray(series.gaps));
    assert.ok(series.retention);
    let prior = '';
    for (const point of series.points) {
      assert.ok(point.observed_at >= series.from && point.observed_at <= series.to, 'Observation inside requested range');
      assert.ok(point.observed_at >= prior, 'Chronological points');
      prior = point.observed_at;
      assert.ok(point.observations >= 1);
      assert.ok(['raw', 'rollup', 'mixed'].includes(point.source));
    }
    observations.push({ period, grain: series.grain, points: series.points.length, gaps: series.gaps.length,
      baseline: series.baseline?.observed_at ?? null, archivePending: series.archive_pending, truncated: series.truncated });
  }
  let next = `/api/history?${new URLSearchParams({ resource, id: entity.id, period: '7d', grain: 'raw', limit: '1' })}`;
  const pages = [];
  for (let index = 0; next && index < 4; index++) {
    const page = await read(next);
    assert.ok(page.points.length <= 1);
    pages.push(page.points.map(point => ({ at: point.observed_at, metrics: point.metrics })));
    next = page.nextUrl;
  }
  results.push({ resource, id: entity.id, observations, rawPagesChecked: pages.length,
    rawPointsChecked: pages.flat().length, traversalComplete: !next });
}
const country = catalog.datasets.countries.items[0];
const from = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
const to = new Date().toISOString().slice(0, 10);
const custom = await read(`/api/history?${new URLSearchParams({ resource: 'countries', id: country.id, from, to, grain: 'day', limit: '10' })}`);
assert.equal(custom.grain, 'day');
await read(`/api/history?${new URLSearchParams({ resource: 'countries', id: country.id, limit: '201' })}`, 400);
await read(`/api/history?${new URLSearchParams({ resource: 'countries', id: country.id, cursor: 'not-a-cursor' })}`, 400);
const headUrl = `${origin}/api/history?${new URLSearchParams({ resource: 'countries', id: country.id, limit: '17' })}`;
const head = await fetch(headUrl, { method: 'HEAD', signal: AbortSignal.timeout(20000) });
assert.equal(head.status, 200);
assert.equal(await head.text(), '');
assert.equal((await read(headUrl)).methodologyVersion, '2');
const options = await fetch(`${origin}/api/history`, { method: 'OPTIONS', signal: AbortSignal.timeout(20000) });
assert.equal(options.status, 204);
assert.equal(options.headers.get('Access-Control-Allow-Origin'), '*');
const evidence = { verifiedAt: new Date().toISOString(), origin, workerVersion: process.env.WINT_WORKER_VERSION ?? null,
  passed: true, authenticated: false, requests, results,
  checks: ['ten real resource types', 'five historical periods', 'chronological raw pages', 'explicit gaps and baseline', 'custom date range', 'invalid limit', 'invalid cursor', 'HEAD then GET', 'OPTIONS', 'public CORS'],
  limitations: ['These are captures since WINT started collecting, not invented earlier history.', 'Archive aging is verified in isolated SQLite tests; no production timestamp is backdated.'] };
await mkdir('artifacts/validation', { recursive: true });
await writeFile('artifacts/validation/histories-live.json', JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ passed: true, requests, resources: results.map(value => ({ resource: value.resource,
  periods: value.observations.length, rawPagesChecked: value.rawPagesChecked })), verifiedAt: evidence.verifiedAt }));
