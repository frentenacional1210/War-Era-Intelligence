import { expect, test } from '@playwright/test';

test('coverage displays observed counts and country progress on desktop and mobile', async ({ page, request }) => {
  const response = await request.get('/api/coverage?page=1&limit=30');
  expect(response.ok()).toBeTruthy();
  const coverage = await response.json() as { summary: { players_registered: number; player_total: number | null; active_player_total: number | null }; countries: { id: string; name: string }[]; total: number };
  await page.goto('/cobertura');
  await expect(page.getByRole('heading', { name: 'Cobertura de datos' })).toBeVisible();
  await expect(page.getByTestId('coverage-players')).toContainText(new Intl.NumberFormat('es-ES').format(coverage.summary.players_registered));
  await expect(page.getByText('El número de perfiles corresponde a registros capturados', { exact: false })).toBeVisible();
  if (coverage.summary.player_total === null) await expect(page.getByText('Población total de jugadores:', { exact: false })).toContainText('Desconocida');
  if (coverage.countries.length) await expect(page.locator('.coverage-table tbody tr').first()).toContainText(coverage.countries[0].name);
  if (coverage.total > 30) {
    await page.getByRole('button', { name: 'Página siguiente' }).click();
    await expect(page.locator('.pagination')).toContainText('Página 2');
    await expect(page.locator('.coverage-table tbody tr').first()).toBeVisible();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBeTruthy();
});

test('global search finds a captured player and links to the existing profile', async ({ page, request }) => {
  const players = await (await request.get('/api/players?limit=1')).json() as { items: { id: string; name: string }[] };
  test.skip(!players.items.length, 'Aún no hay jugadores capturados');
  const player = players.items[0];
  await page.goto('/buscar');
  await expect(page.getByRole('heading', { name: 'Búsqueda global' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Nombre o término' }).fill(player.name);
  await expect(page.locator('.global-search-results')).toBeVisible();
  await expect(page.locator('.global-search-results a[href="/jugadores/' + encodeURIComponent(player.id) + '"]')).toBeVisible();
});
