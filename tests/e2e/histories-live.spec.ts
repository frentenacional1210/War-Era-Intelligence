import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('two captured countries can be compared and exported with actual historical metadata', async ({ page, request }, testInfo) => {
  const response = await request.get('/api/countries?limit=2&sort=name&order=asc');
  expect(response.ok()).toBeTruthy();
  const listing = await response.json() as { items: { id: string; name: string }[] };
  test.skip(listing.items.length < 2, 'Two real captured countries required');
  await page.goto('/historicos');
  const choices = page.locator('.histories-options button');
  await expect(choices.first()).toBeVisible();
  await choices.nth(0).click();
  await choices.nth(1).click();
  const explorer = page.locator('.history-explorer');
  await expect(explorer.locator('.history-entity-note')).toHaveCount(2);
  for (const item of listing.items) await expect(explorer.locator('.history-entity-note')).toContainText([item.name]);
  await explorer.getByLabel('Periodo', { exact: true }).selectOption('2y');
  await expect(explorer.locator('.history-summary')).toContainText('Resumen mensual');
  await explorer.getByLabel('Resolución temporal').selectOption('raw');
  await expect(explorer.locator('.history-summary')).toContainText('Capturas individuales');
  await expect(explorer.getByRole('button', { name: 'Exportar JSON' })).toBeEnabled();
  const downloaded = page.waitForEvent('download');
  await explorer.getByRole('button', { name: 'Exportar JSON' }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toContain('countries');
  const path = await download.path();
  expect(path).toBeTruthy();
  const exported = JSON.parse(await readFile(path!, 'utf8'));
  expect(exported.resource).toBe('countries');
  expect(exported.records.length).toBeGreaterThan(0);
  expect(exported.series).toHaveLength(2);
  for (const series of exported.series) {
    expect(series.methodologyVersion).toBe('2');
    expect(series.retention.monthMonths).toBe(24);
    expect(series.sourceMeaning).toBe('current-entity-source');
    expect(Number.isFinite(Date.parse(series.actualWindow.from))).toBeTruthy();
    expect(Number.isFinite(Date.parse(series.actualWindow.to))).toBeTruthy();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBeTruthy();
  await page.screenshot({ path: `artifacts/validation/history-${testInfo.project.name}.png`, fullPage: true });
});

test('a foreign website can read captured historical JSON without credentials', async ({ page, request }) => {
  const countries = await (await request.get('/api/countries?limit=1')).json() as { items: { id: string }[] };
  test.skip(!countries.items.length, 'A real country is required');
  const url = new URL(`/api/history?resource=countries&id=${encodeURIComponent(countries.items[0].id)}&period=2y`, test.info().project.use.baseURL!);
  // Serve only the consumer document locally; the historical API request is real.
  await page.route('https://wint-consumer.example/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Independent history consumer</title>' }));
  await page.goto('https://wint-consumer.example');
  const result = await page.evaluate(async target => {
    const response = await fetch(target, { credentials: 'omit' });
    const data = await response.json() as { resource: string; methodologyVersion: string };
    return { status: response.status, type: response.type, resource: data.resource, version: data.methodologyVersion };
  }, url.toString());
  expect(result).toEqual({ status: 200, type: 'cors', resource: 'countries', version: '2' });
});
