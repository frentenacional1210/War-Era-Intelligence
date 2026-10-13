import { expect, test } from '@playwright/test';

test('political view shows a real country with sourced or explicit empty records', async ({ page, request }) => {
  const countries = await (await request.get('/api/countries?limit=1')).json() as { items: { id: string; name: string }[] };
  test.skip(!countries.items.length, 'Aún no hay países capturados');
  const country = countries.items[0];
  const response = await request.get(`/api/politics?${new URLSearchParams({ country: country.id })}`);
  expect(response.ok()).toBeTruthy();
  await page.goto(`/politica?country=${encodeURIComponent(country.id)}`);
  await expect(page.getByRole('heading', { name: 'Gobierno y elecciones' })).toBeVisible();
  await expect(page.getByRole('heading', { name: country.name })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Gobierno observado' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Elecciones observadas' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBeTruthy();
});

test('military scenario uses editable assumptions and a captured unit', async ({ page, request }) => {
  const units = await (await request.get('/api/military-units?limit=1')).json() as { items: { id: string; name: string }[] };
  test.skip(!units.items.length, 'Aún no hay unidades capturadas');
  const unit = units.items[0];
  await page.goto(`/militar?unit=${encodeURIComponent(unit.id)}`);
  await expect(page.getByRole('heading', { name: 'Unidades y escenario' })).toBeVisible();
  await expect(page.getByRole('heading', { name: unit.name })).toBeVisible();
  await page.getByRole('spinbutton', { name: 'Combatientes propios' }).fill('3');
  await page.getByRole('spinbutton', { name: 'Daño supuesto por combatiente propio y ronda' }).fill('4');
  await page.getByRole('spinbutton', { name: 'Rondas supuestas' }).fill('2');
  await expect(page.getByTestId('military-own-damage')).toHaveText('24');
  await expect(page.getByText('no se aplican modificadores ni reglas oficiales', { exact: false })).toBeVisible();
});

test('industrial comparison uses observed prices, editable costs and local favorites', async ({ page, request }) => {
  const response = await request.get('/api/markets/prices?limit=2&sort=name&order=asc');
  expect(response.ok()).toBeTruthy();
  const quotes = await response.json() as { items: { price: number }[] };
  test.skip(quotes.items.length < 2, 'Se necesitan dos cotizaciones capturadas');
  await page.goto('/industria');
  await expect(page.getByRole('heading', { name: 'Comparador industrial' })).toBeVisible();
  const pickers = page.locator('.industrial-picker');
  await expect(pickers.first().locator('.industrial-choices button').first()).toBeVisible();
  await pickers.nth(0).locator('.industrial-choices button').first().click();
  await pickers.nth(1).locator('.industrial-choices button').nth(1).click();
  await page.getByRole('spinbutton', { name: 'Materia prima usada al día' }).fill('2');
  await page.getByRole('spinbutton', { name: 'Producto obtenido por unidad de materia prima' }).fill('3');
  await page.getByRole('spinbutton', { name: 'Coste de transformación por unidad de materia prima' }).fill('1');
  const format = (value: number) => new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 }).format(value);
  await expect(page.getByTestId('industrial-produce-cost')).toHaveText(format(2 * (quotes.items[0].price + 1)));
  await expect(page.getByTestId('industrial-buy-cost')).toHaveText(format(6 * quotes.items[1].price));
  await page.getByRole('textbox', { name: 'Nombre del escenario' }).fill('Prueba guardada');
  await page.getByRole('button', { name: 'Guardar escenario' }).click();
  await page.reload();
  await page.locator('.industrial-favorites li button:first-child').filter({ hasText: 'Prueba guardada' }).click();
  await expect(page.getByText('Has recuperado cotizaciones guardadas', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBeTruthy();
});

test('industrial assumptions can be carried to AI without submitting a query', async ({ page, request }) => {
  const response = await request.get('/api/markets/prices?limit=2&sort=name&order=asc');
  const quotes = await response.json() as { items: { price: number }[] };
  test.skip(quotes.items.length < 2, 'Se necesitan dos cotizaciones capturadas');
  await page.goto('/industria');
  const pickers = page.locator('.industrial-picker');
  await expect(pickers.first().locator('.industrial-choices button').first()).toBeVisible();
  await pickers.first().locator('.industrial-choices button').first().click();
  await pickers.nth(1).locator('.industrial-choices button').nth(1).click();
  await page.getByRole('spinbutton', { name: 'Materia prima usada al día' }).fill('2');
  await page.getByRole('spinbutton', { name: 'Producto obtenido por unidad de materia prima' }).fill('3');
  await page.getByRole('link', { name: 'Llevar este escenario a IA' }).click();
  await expect(page).toHaveURL(/\/ia$/);
  await expect(page.getByText('Escenario industrial adjunto')).toBeVisible();
  await expect(page.locator('.ai-scenario-attached')).toContainText('6 unidades/día');
  await expect(page.getByRole('textbox', { name: 'Pregunta sobre datos observados' })).toBeVisible();
  await page.getByRole('button', { name: 'Quitar escenario' }).click();
  await expect(page.locator('.ai-scenario-attached')).toHaveCount(0);
});

test('relation view distinguishes latest and earlier observed links', async ({ page, request }) => {
  const players = await (await request.get('/api/players?limit=1')).json() as { items: { id: string }[] };
  test.skip(!players.items.length, 'Aún no hay jugadores capturados');
  const player = players.items[0];
  const response = await request.get(`/api/relations?${new URLSearchParams({ resource: 'players', id: player.id })}`);
  expect(response.ok()).toBeTruthy();
  await page.goto(`/jugadores/${encodeURIComponent(player.id)}`);
  const explorer = page.locator('.relations-explorer');
  await expect(explorer).toBeVisible();
  await expect(explorer).toContainText('La fecha observada no demuestra');
  await explorer.getByRole('button', { name: 'Capturas anteriores' }).click();
  await expect(explorer.getByRole('button', { name: 'Capturas anteriores' })).toHaveClass(/active/);
});
