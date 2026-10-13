import { expect, test } from '@playwright/test';

type Feed = { items: { id: string; title: string; sourceUrl: string }[]; limit: number };

test('alert feed displays only returned observations and keeps local filter preferences', async ({ page, request }) => {
  const response = await request.get('/api/alerts/feed?limit=50');
  expect(response.ok()).toBeTruthy();
  const feed = await response.json() as Feed;
  await page.goto('/alertas');
  await expect(page.getByRole('heading', { name: 'Alertas observadas' })).toBeVisible();
  await expect(page.locator('.alerts-feed>li')).toHaveCount(feed.items.length);
  if (feed.items.length) {
    await expect(page.locator('.alerts-feed>li').first()).toContainText(feed.items[0].title);
    await page.locator('.alerts-feed>li').first().getByText('Ver datos observados y criterio').click();
    await expect(page.locator('.alerts-feed>li').first().getByText('Antes', { exact: true })).toBeVisible();
  } else {
    await expect(page.getByText('Sin alertas para estos filtros')).toBeVisible();
  }
  await page.getByRole('combobox', { name: 'Tema' }).selectOption('military');
  const filteredResponse = await request.get('/api/alerts/feed?limit=50&theme=military');
  expect(filteredResponse.ok()).toBeTruthy();
  const filtered = await filteredResponse.json() as Feed;
  await expect(page.locator('.alerts-feed>li')).toHaveCount(filtered.items.length);
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Tema' })).toHaveValue('military');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBeTruthy();
});
