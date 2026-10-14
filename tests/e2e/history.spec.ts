import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('player detail shows real historical periods, first capture and methodology', async ({ page, request }) => {
  const players = await (await request.get('/api/players?limit=1')).json() as { items: { id: string }[] };
  test.skip(!players.items.length, 'Aún no hay jugadores capturados');
  const id = String(players.items[0].id);
  const response = await request.get(`/api/history?${new URLSearchParams({ resource: 'players', id, period: '30d' })}`);
  expect(response.ok()).toBeTruthy();
  const history = await response.json() as { points: unknown[]; gaps: unknown[]; baseline: unknown; methodology: string };
  expect(Array.isArray(history.points)).toBeTruthy();
  expect(Array.isArray(history.gaps)).toBeTruthy();
  expect(typeof history.methodology).toBe('string');

  await page.goto(`/jugadores/${encodeURIComponent(id)}`);
  const explorer = page.locator('.history-explorer');
  await expect(explorer).toBeVisible();
  await expect(explorer).toContainText('Primera captura disponible:');
  await expect(explorer.locator('.history-methodology')).toBeVisible();
  await explorer.getByLabel('Periodo', { exact: true }).selectOption('1y');
  await expect(explorer.locator('.history-summary')).toContainText('Resumen semanal');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBeTruthy();
});

test('comparison can show two real player histories without filling missing periods', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Comparación de escritorio');
  const players = await (await request.get('/api/players?limit=2')).json() as { items: { id: string; name: string }[] };
  test.skip(players.items.length < 2, 'Se necesitan dos jugadores capturados');
  await page.goto('/analisis');
  const options = page.locator('.analysis-option');
  await expect(options.first()).toBeVisible();
  await options.nth(0).click();
  await options.nth(1).click();
  await page.getByRole('button', { name: 'Comparar registros' }).click();
  const explorer = page.locator('.history-explorer');
  await expect(explorer).toBeVisible();
  await expect(explorer.locator('.history-entity-note')).toHaveCount(2);
  await expect(explorer).toContainText('sin calcular medias ni rellenar periodos vacíos');
});

test('extended public record shows only its saved historical fields', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Una verificación de ficha ampliada');
  const candidates = [
    { resource: 'companies', route: 'empresas', field: 'production', label: 'Producción indicada' },
    { resource: 'elections', route: 'elecciones', field: 'votes_count', label: 'Votos registrados' },
    { resource: 'governments', route: 'gobiernos', field: 'congress_count', label: 'Congresistas registrados' },
  ];
  let found: { resource: string; route: string; field: string; label: string; id: string } | null = null;
  for (const candidate of candidates) {
    const response = await request.get(`/api/${candidate.resource}?limit=1`);
    if (!response.ok()) continue;
    const listing = await response.json() as { items: { id: string }[] };
    if (listing.items.length) { found = { ...candidate, id: String(listing.items[0].id) }; break; }
  }
  test.skip(!found, 'Aún no hay empresas, elecciones ni gobiernos capturados');
  const item = found!;
  const response = await request.get(`/api/history?${new URLSearchParams({ resource: item.resource, id: item.id, period: '30d' })}`);
  expect(response.ok()).toBeTruthy();
  await page.goto(`/${item.route}/${encodeURIComponent(item.id)}`);
  const explorer = page.locator('.history-explorer');
  await expect(explorer).toBeVisible();
  await explorer.getByLabel('Medida observada').selectOption(item.field);
  await expect(explorer.getByLabel('Medida observada')).toHaveValue(item.field);
  await expect(explorer).toContainText(item.label);
  await expect(explorer.locator('.history-methodology')).toBeVisible();
});

test('public historical explorer compares two countries and exports displayed observations', async ({ page }) => {
  await page.route('**/api/countries?**', route => route.fulfill({ json: { items: [{ id: 'a', name: 'Alfa' }, { id: 'b', name: 'Beta' }], total: 2, page: 1, limit: 20, source: null } }));
  await page.route('**/api/history?**', route => {
    const query = new URL(route.request().url()).searchParams;
    const id = query.get('id')!;
    const grain = query.get('grain') ?? 'day';
    const observed_at = id === 'a' ? '2026-01-02T10:00:00.000Z' : '2026-01-03T11:00:00.000Z';
    const point = { observed_at, first_observed_at: observed_at, bucket_start: observed_at, grain, metrics: { money: id === 'a' ? 10 : 20, population: 100 }, observations: 1, method: 'bucket-last', source: 'raw' };
    return route.fulfill({ json: { resource: 'countries', id, period: query.get('period'), grain, from: '2025-10-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z', points: [point], gaps: [], baseline: point, truncated: false, archive_pending: false, methodology: 'Change-only observations. No empty periods filled.', methodologyVersion: '2', retention: { rawDays: 30, dayDays: 90, weekDays: 366, monthMonths: 24, baseline: 'lifetime' }, nextCursor: null, nextUrl: null } });
  });
  await page.goto('/historicos');
  await expect(page.getByRole('heading', { name: 'Históricos' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Históricos', exact: true })).toHaveAttribute('aria-current', 'page');
  const picker = page.getByRole('group', { name: 'Registros capturados' });
  await expect(picker.getByRole('button')).toHaveCount(2);
  await picker.getByRole('button').nth(0).click();
  await picker.getByRole('button').nth(1).click();
  const explorer = page.locator('.history-explorer');
  await expect(explorer.locator('.history-entity-note')).toHaveCount(2);
  await explorer.getByLabel('Periodo', { exact: true }).selectOption('1y');
  await explorer.getByLabel('Resolución temporal').selectOption('week');
  await expect(explorer.locator('.history-summary')).toContainText('Resumen semanal');
  await explorer.getByLabel('Medida observada').selectOption('money');
  const downloadPromise = page.waitForEvent('download');
  await explorer.getByRole('button', { name: 'Exportar JSON' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/wint-historicos-countries-money-1y\.json$/);
  const exported = JSON.parse(await readFile(await download.path(), 'utf8')) as { records: { id: string; value: number }[]; complete: boolean };
  expect(exported.records.map(record => [record.id, record.value])).toEqual([['a', 10], ['b', 20]]);
  expect(exported.complete).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBeTruthy();
});

test('categorical region history shows observed labels and date-range validation', async ({ page }) => {
  await page.route('**/api/regions?**', route => route.fulfill({ json: { items: [{ id: 'r1', name: 'Región norte' }], total: 1, page: 1, limit: 20, source: null } }));
  await page.route('**/api/history?**', route => {
    const query = new URL(route.request().url()).searchParams;
    const point = { observed_at: '2026-09-20T12:00:00.000Z', first_observed_at: '2026-09-20T12:00:00.000Z', bucket_start: '2026-09-20T00:00:00.000Z', grain: 'day', metrics: { country_id: 'c1', initial_country_id: 'c2', is_capital: false }, observations: 1, method: 'bucket-last', source: 'rollup' };
    return route.fulfill({ json: { resource: 'regions', id: query.get('id'), period: query.get('period'), grain: 'day', from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z', points: [point], gaps: [], baseline: point, truncated: false, archive_pending: false, methodology: 'Change-only observations. No empty periods filled.', methodologyVersion: '2', retention: { rawDays: 30, dayDays: 90, weekDays: 366, monthMonths: 24, baseline: 'lifetime' }, nextCursor: null, nextUrl: null } });
  });
  await page.goto('/historicos');
  await page.getByLabel('Tipo de registro').selectOption('regions');
  await page.getByRole('group', { name: 'Registros capturados' }).getByRole('button').first().click();
  const explorer = page.locator('.history-explorer');
  await expect(explorer.locator('.history-categorical')).toBeVisible();
  await expect(explorer.locator('.history-categorical')).toContainText('c1');
  await expect(explorer.locator('.history-categorical')).toContainText('Resumen conservado');
  await explorer.getByLabel('Desde').fill('2026-10-10');
  await explorer.getByLabel('Hasta').fill('2026-10-01');
  await expect(explorer.getByRole('alert')).toContainText('fecha inicial');
});

test('history loads the next bounded page and exports all displayed points', async ({ page }) => {
  await page.route('**/api/countries?**', route => route.fulfill({ json: { items: [{ id: 'a', name: 'Alfa' }], total: 1, page: 1, limit: 20, source: null } }));
  await page.route('**/api/history?**', route => {
    const url = new URL(route.request().url());
    const second = url.searchParams.has('cursor');
    const observed_at = second ? '2026-10-02T10:00:00.000Z' : '2026-10-01T10:00:00.000Z';
    const point = { observed_at, first_observed_at: observed_at, bucket_start: observed_at, grain: 'day', metrics: { population: second ? 12 : 10 }, observations: 1, method: 'bucket-last', source: 'raw' };
    return route.fulfill({ json: { resource: 'countries', id: 'a', entityName: 'Alfa', sourceUrl: null, sourceMeaning: null, period: '30d', grain: 'day', from: '2026-09-01T00:00:00.000Z', to: '2026-10-14T00:00:00.000Z', points: [point], gaps: [], baseline: point, truncated: !second, archive_pending: false, boundaryLimited: false, methodology: 'Change-only observations. No empty periods filled.', methodologyVersion: '2', retention: { rawDays: 30, dayDays: 90, weekDays: 366, monthMonths: 24, baseline: 'lifetime' }, nextCursor: second ? null : 'page2', nextUrl: second ? null : '/api/history?resource=countries&id=a&period=30d&cursor=page2' } });
  });
  await page.goto('/historicos');
  await page.getByRole('group', { name: 'Registros capturados' }).getByRole('button').first().click();
  const explorer = page.locator('.history-explorer');
  await expect(explorer.locator('.history-summary')).toContainText('1 puntos observados');
  await explorer.getByRole('button', { name: 'Cargar más capturas' }).click();
  await expect(explorer.locator('.history-summary')).toContainText('2 puntos observados');
  await expect(explorer.getByRole('button', { name: 'Cargar más capturas' })).toHaveCount(0);
  const downloadPromise = page.waitForEvent('download');
  await explorer.getByRole('button', { name: 'Exportar JSON' }).click();
  const exported = JSON.parse(await readFile(await (await downloadPromise).path(), 'utf8')) as { records: unknown[]; complete: boolean };
  expect(exported.records).toHaveLength(2);
  expect(exported.complete).toBe(true);
});
