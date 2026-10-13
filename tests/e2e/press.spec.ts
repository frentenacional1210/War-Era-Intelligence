import { expect, test } from '@playwright/test';

type Article = { id: string; title: string; publishedAt: string | null; language: string | null; sourceUrl: string; topics: string[]; related: { id: string }[] };
type Press = { items: Article[]; sampled: number; matched: number; limit: number; isSample: boolean };

test('press explorer shows captured titles and exact bounded sample, with filters', async ({ page, request }) => {
  const response = await request.get('/api/press?limit=50');
  expect(response.ok()).toBeTruthy();
  const sample = await response.json() as Press;
  expect(sample.isSample).toBe(true);
  await page.goto('/prensa');
  await expect(page.getByRole('heading', { name: 'Prensa capturada' })).toBeVisible();
  await expect(page.locator('.press-list>li')).toHaveCount(sample.items.length);
  await expect(page.locator('.press-sample').first()).toContainText(`${sample.matched.toLocaleString('es-ES')} fichas coinciden`);
  if (sample.items.length) {
    await expect(page.locator('.press-list>li').first()).toContainText(sample.items[0].title);
    await expect(page.locator('.press-list>li').first().getByRole('link', { name: sample.items[0].title })).toHaveAttribute('href', `/articulos/${encodeURIComponent(sample.items[0].id)}`);
    await expect(page.locator('.press-list>li').first()).toContainText('Capturado:');
    if (sample.items[0].sourceUrl) await expect(page.locator('.press-list>li').first().getByRole('link', { name: 'Fuente original' })).toHaveAttribute('href', sample.items[0].sourceUrl);
    if (sample.items[0].related.length) await expect(page.locator('.press-list>li').first().getByText('Otros títulos con un tema inferido en común', { exact: false })).toBeVisible();
  } else {
    await expect(page.getByText('Sin artículos para estos filtros')).toBeVisible();
  }
  await page.getByRole('combobox', { name: 'Mostrar' }).selectOption('25');
  await page.getByRole('button', { name: 'Aplicar filtros' }).click();
  const reduced = await (await request.get('/api/press?limit=25')).json() as Press;
  await expect(page.locator('.press-list>li')).toHaveCount(reduced.items.length);
  const language = sample.items.find(article => article.language && /^[A-Za-z-]{2,16}$/.test(article.language))?.language;
  if (language) {
    await page.getByLabel('Idioma (código)').fill(language);
    await page.getByRole('button', { name: 'Aplicar filtros' }).click();
    const filtered = await (await request.get(`/api/press?${new URLSearchParams({ limit: '25', language })}`)).json() as Press;
    await expect(page.locator('.press-list>li')).toHaveCount(filtered.items.length);
    if (filtered.items.length) await expect(page.locator('.press-list>li').first()).toContainText(filtered.items[0].title);
  }
  await page.getByLabel('Idioma (código)').fill('x');
  await expect(page.getByRole('button', { name: 'Aplicar filtros' })).toBeDisabled();
  await page.getByRole('button', { name: 'Restablecer' }).click();
  await expect(page.getByRole('combobox', { name: 'Mostrar' })).toHaveValue('50');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBeTruthy();
});

test('press sample is readable without horizontal overflow on mobile', async ({ page, request, isMobile }) => {
  test.skip(!isMobile, 'Validación móvil');
  const sample = await (await request.get('/api/press?limit=50')).json() as Press;
  await page.goto('/prensa');
  await expect(page.getByRole('heading', { name: 'Prensa capturada' })).toBeVisible();
  await expect(page.locator('.press-list>li')).toHaveCount(sample.items.length);
  await expect(page.getByText('No lee el contenido de los artículos', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBeTruthy();
});
