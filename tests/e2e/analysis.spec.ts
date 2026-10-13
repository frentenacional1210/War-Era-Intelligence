import { expect, test } from '@playwright/test';

test('desktop compares two real players and opens their captured history', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'Vista de escritorio');
  const response = await request.get('/api/players?limit=2');
  expect(response.ok()).toBeTruthy();
  const players = await response.json() as { items: { id: string; name: string }[] };
  test.skip(players.items.length < 2, 'Se necesitan dos jugadores capturados');

  await page.goto('/analisis');
  await expect(page.getByRole('heading', { name: 'Comparar e historial' })).toBeVisible();
  const options = page.locator('.analysis-option');
  await expect(options.first()).toBeVisible();
  await options.nth(0).click();
  await options.nth(1).click();
  await expect(page.getByText('Seleccionados (2/4)')).toBeVisible();
  await page.getByRole('button', { name: 'Comparar registros' }).click();
  await expect(page.getByRole('heading', { name: 'Comparación de jugadores' })).toBeVisible();
  await expect(page.locator('.analysis-table thead th').nth(1)).toContainText(players.items[0].name);
  await expect(page.locator('.analysis-table thead th').nth(2)).toContainText(players.items[1].name);
  await expect(page.getByRole('heading', { name: 'Evolución observada' })).toBeVisible();
  const explorer=page.locator('.history-explorer');
  await expect(explorer.locator('.history-entity-note')).toHaveCount(2);
  await explorer.getByLabel('Periodo').selectOption('1y');
  await expect(explorer.locator('.history-summary')).toContainText('Resumen semanal');
});

test('mobile can select and compare two real players without horizontal page overflow', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'Vista móvil');
  const response = await request.get('/api/players?limit=2');
  expect(response.ok()).toBeTruthy();
  const players = await response.json() as { items: { id: string }[] };
  test.skip(players.items.length < 2, 'Se necesitan dos jugadores capturados');

  await page.goto('/analisis');
  const options = page.locator('.analysis-option');
  await expect(options.first()).toBeVisible();
  await options.nth(0).click();
  await options.nth(1).click();
  await page.getByRole('button', { name: 'Comparar registros' }).click();
  await expect(page.getByRole('heading', { name: 'Comparación de jugadores' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBeTruthy();
});
