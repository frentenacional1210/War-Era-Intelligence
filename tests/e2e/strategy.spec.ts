import { expect, test } from '@playwright/test';

type Country = { id: string; name: string };
type Strategy = { country: Country; coverage: { registeredPlayers: number | null }; missing: string[] };

test('country strategy report uses captured values, sources, gaps and history', async ({ page, request }) => {
  test.setTimeout(60_000);
  const countries = await (await request.get('/api/countries?limit=1')).json() as { items: Country[] };
  test.skip(!countries.items.length, 'Aún no hay países capturados');
  const country = countries.items[0];
  const response = await request.get(`/api/strategy?${new URLSearchParams({ country: country.id })}`);
  expect(response.ok()).toBeTruthy();
  const report = await response.json() as Strategy;
  await page.goto(`/estrategia?country=${encodeURIComponent(country.id)}`);
  await expect(page.getByRole('heading', { name: 'Situación por país' })).toBeVisible();
  await expect(page.getByRole('heading', { name: report.country.name })).toBeVisible();
  const coverage = page.locator('.strategy-groups .panel').first();
  await expect(coverage).toContainText('Perfiles de jugadores registrados');
  if (report.coverage.registeredPlayers !== null) {
    await expect(coverage).toContainText(new Intl.NumberFormat('es-ES').format(report.coverage.registeredPlayers));
  }
  await expect(page.getByRole('heading', { name: 'Fuentes y lagunas' })).toBeVisible();
  if (report.missing.length) await expect(page.locator('.strategy-missing li')).toHaveCount(report.missing.length);
  await expect(page.getByRole('heading', { name: 'Historial observado de países' })).toBeVisible();
  await expect(page.getByText('Los huecos permanecen sin rellenar', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBeTruthy();
});

test('two-country comparison keeps observations separate and does not rank countries', async ({ page, request }) => {
  test.setTimeout(60_000);
  const countries = await (await request.get('/api/countries?limit=2')).json() as { items: Country[] };
  test.skip(countries.items.length < 2, 'Se necesitan dos países capturados');
  const [first, second] = countries.items;
  await page.goto(`/estrategia?${new URLSearchParams({ country: first.id, compare: second.id })}`);
  await expect(page.getByRole('heading', { name: 'Comparación de registros observados' })).toBeVisible();
  const table = page.locator('.strategy-compare');
  await expect(table).toContainText(first.name);
  await expect(table).toContainText(second.name);
  await expect(page.getByText('Las diferencias pueden reflejar cobertura o fechas distintas', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Historial observado de países' })).toBeVisible();
  await page.getByRole('button', { name: 'Quitar comparación' }).click();
  await expect(page.getByRole('heading', { name: 'Comparación de registros observados' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBeTruthy();
});
