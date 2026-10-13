import { expect, test } from '@playwright/test';

type PriceRow = { id: string; name: string };
type Orderbook = { item: PriceRow; status: 'pending' | 'ok'; buyOrders: unknown[]; sellOrders: unknown[]; observedAt: string | null };

test('orderbook uses a real catalog product and distinguishes pending from captured orders', async ({ page, request }) => {
  const catalogResponse = await request.get('/api/markets/prices?limit=1');
  expect(catalogResponse.ok()).toBeTruthy();
  const catalog = await catalogResponse.json() as { items: PriceRow[] };
  test.skip(!catalog.items.length, 'Aún no hay productos con cotización capturada');
  const item = catalog.items[0];
  const response = await request.get(`/api/markets/orderbook?${new URLSearchParams({ item: item.id })}`);
  expect(response.ok()).toBeTruthy();
  const book = await response.json() as Orderbook;
  await page.goto(`/mercados/ordenes?item=${encodeURIComponent(item.id)}`);
  await expect(page.getByRole('heading', { name: 'Libro de órdenes', exact: true })).toBeVisible();
  await expect(page.getByText('Las órdenes no son transacciones', { exact: false })).toBeVisible();
  if (book.status === 'pending') {
    await expect(page.getByText('Captura pendiente')).toBeVisible();
    await expect(page.locator('.orderbook-table tbody tr')).toHaveCount(0);
  } else {
    await expect(page.locator('.orderbook-provenance')).toContainText(book.item.name);
    await expect(page.locator('.orderbook-side').first().locator('tbody tr')).toHaveCount(book.buyOrders.length);
    await expect(page.locator('.orderbook-side').nth(1).locator('tbody tr')).toHaveCount(book.sellOrders.length);
    await expect(page.getByText('No representa todo el mercado', { exact: false })).toBeVisible();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBeTruthy();
});
