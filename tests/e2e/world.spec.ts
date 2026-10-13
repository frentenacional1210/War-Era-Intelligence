import { expect, test } from '@playwright/test';

type Entry = { id: string; name: string };
type Listing = { items: Entry[]; total: number };

test('schematic world uses captured countries, a real region, and its own history', async ({ page, request }) => {
  const countriesResponse = await request.get('/api/countries?limit=1');
  expect(countriesResponse.ok()).toBeTruthy();
  const countries = await countriesResponse.json() as Listing;
  test.skip(!countries.items.length, 'Aún no hay países capturados');
  const country = countries.items[0];
  const regionsResponse = await request.get(`/api/regions?${new URLSearchParams({ country: country.id, limit: '50', page: '1' })}`);
  expect(regionsResponse.ok()).toBeTruthy();
  const regions = await regionsResponse.json() as Listing;

  await page.goto('/mundo');
  await expect(page.getByRole('heading', { name: 'Mundo WarEra' })).toBeVisible();
  await expect(page.getByText('La posición y el orden de las tarjetas no representan coordenadas', { exact: false })).toBeVisible();
  await page.getByRole('combobox', { name: 'País', exact: true }).selectOption(country.id);
  await expect(page.getByText(`País observado: ID ${country.id}`)).toBeVisible();
  await expect(page.getByText(`${regions.total.toLocaleString('es-ES')} regiones capturadas`, { exact: false })).toBeVisible();

  await page.getByRole('button', { name: 'Política' }).click();
  await expect(page.getByRole('link', { name: 'Ver cargos, candidaturas y fuentes' })).toBeVisible();
  await page.getByRole('button', { name: 'Unidades' }).click();
  await expect(page.getByRole('link', { name: 'Explorar y comparar unidades' })).toBeVisible();
  await page.getByRole('button', { name: 'Territorio' }).click();

  if (regions.items.length) {
    const region = regions.items[0];
    await page.locator('.world-region-tile').first().getByRole('button').click();
    await expect(page.getByRole('heading', { name: 'Control observado de la región' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ficha de la región' }).first()).toHaveAttribute('href', `/regiones/${encodeURIComponent(region.id)}`);
    await page.getByRole('combobox', { name: 'Periodo de esta región' }).selectOption('1y');
    await expect(page.getByText('Cada fila procede de una captura de esta región', { exact: false })).toBeVisible();
  } else {
    await expect(page.getByText('Sin regiones capturadas')).toBeVisible();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBeTruthy();
});

test('country grid and region paging remain usable on mobile', async ({ page, request, isMobile }) => {
  test.skip(!isMobile, 'Validación de diseño móvil');
  const response = await request.get('/api/countries?limit=1');
  const countries = await response.json() as Listing;
  test.skip(!countries.items.length, 'Aún no hay países capturados');
  const country = countries.items[0];
  await page.goto('/mundo');
  await page.getByRole('combobox', { name: 'País', exact: true }).selectOption(country.id);
  await expect(page.locator('.world-country-grid')).toBeVisible();
  await expect(page.getByText(`País observado: ID ${country.id}`)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBeTruthy();
});
