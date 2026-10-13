import { expect, test } from '@playwright/test';

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
  await explorer.getByLabel('Periodo').selectOption('1y');
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
