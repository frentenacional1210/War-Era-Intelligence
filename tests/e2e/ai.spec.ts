import { expect, test } from '@playwright/test';

type Catalog = { tools: string[]; status: { enabled: boolean; requestCountToday: number; maxCallsPerDay: number } };

test('AI page documents the server tools and actual availability on desktop and mobile', async ({ page, request }) => {
  const response = await request.get('/api/ai/tools');
  expect(response.ok()).toBeTruthy();
  const catalog = await response.json() as Catalog;
  await page.goto('/ia');
  await expect(page.getByRole('heading', { name: 'Informes de IA' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Herramientas de consulta' })).toBeVisible();
  await expect(page.locator('.ai-tool-grid article')).toHaveCount(catalog.tools.length);
  await expect(page.getByText(catalog.status.enabled ? 'IA disponible' : 'IA no disponible')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Pregunta sobre datos observados' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBeTruthy();
});

test('an enabled AI report separates facts and interpretation', async ({ page, request, isMobile }) => {
  test.setTimeout(60_000);
  test.skip(isMobile, 'Una sola inferencia por ejecución de la suite');
  const catalog = await (await request.get('/api/ai/tools')).json() as Catalog;
  test.skip(!catalog.status.enabled || catalog.status.requestCountToday >= catalog.status.maxCallsPerDay, 'El servicio de IA está desactivado o sin presupuesto');
  await page.goto('/ia');
  await page.getByRole('textbox', { name: 'Pregunta sobre datos observados' }).fill('censo');
  await page.getByRole('button', { name: 'Consultar', exact: true }).click();
  const report = page.getByRole('heading', { name: 'Informe consultado' });
  const exhausted = page.getByText('Se ha agotado el presupuesto diario de consultas de IA', { exact: false });
  await expect(report.or(exhausted)).toBeVisible({ timeout: 30_000 });
  if (await report.isVisible()) {
    await expect(page.getByRole('heading', { name: /Hechos observados/ })).toBeVisible();
    await expect(page.locator('.ai-facts li').first()).toBeVisible();
    await expect(page.locator('.ai-citations a').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Datos faltantes' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Interpretación automática' })).toBeVisible();
    await expect(page.getByText('Pregunta: censo')).toBeVisible();
    if (await page.getByText('Interpretación disponible').isVisible()) await expect(page.locator('.ai-interpretation')).not.toBeEmpty();
  }
});
