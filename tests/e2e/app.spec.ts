import {test,expect} from '@playwright/test';
test('dashboard, real directories and read only API',async({page,request})=>{
  await page.goto('/');await expect(page.getByRole('heading',{name:'¿Qué quieres saber hoy?',exact:true})).toBeVisible();
  await page.goto('/panel');await expect(page.getByRole('heading',{name:'Centro de mando',exact:true})).toBeVisible();
  const countries=await request.get('/api/countries?limit=1');expect(countries.ok()).toBeTruthy();
  const data=await countries.json();expect(Array.isArray(data.items)).toBeTruthy();
  await page.goto('/jugadores');await expect(page.getByRole('heading',{name:'Jugadores',exact:true,level:1})).toBeVisible();
  await page.goto('/articulos');await expect(page.getByRole('heading',{name:'Artículos',exact:true,level:1})).toBeVisible();
  await page.goto('/mercados');await expect(page.getByRole('heading',{name:'Economía y mercados',exact:true})).toBeVisible();
  await page.goto('/admin');await expect(page.getByRole('heading',{name:'Administración',exact:true})).toBeVisible();
  expect((await request.get('/api/admin/status')).status()).toBe(401);
  expect((await request.post('/api/players',{data:{}})).status()).toBe(405);
});
test('search real player and open provenance',async({page,request})=>{
  const players=await (await request.get('/api/players?limit=1')).json();
  test.skip(!players.items.length,'La recopilación inicial de jugadores aún no ha terminado.');
  const player=players.items[0];await page.goto('/jugadores');
  const q=Array.from(String(player.name)).slice(0,6).join('');
  await page.getByPlaceholder('Buscar jugadores…').fill(q);
  await expect(page).toHaveURL(/q=/);
  await expect(page.getByRole('link',{name:player.name,exact:true})).toBeVisible();
  await page.getByRole('link',{name:player.name,exact:true}).click();
  await expect(page.getByRole('heading',{name:player.name,exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'Abrir fuente original',exact:false})).toBeVisible();
  const articles=await (await request.get('/api/articles?limit=1')).json();
  expect(articles.items.length).toBeGreaterThan(0);
  const article=articles.items[0];await page.goto(`/articulos/${encodeURIComponent(article.id)}`);
  await expect(page.getByRole('heading',{name:article.title,exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'Abrir fuente original',exact:false})).toBeVisible();
});
test('mobile and desktop fit viewport and simulator responds',async({page})=>{
  await page.goto('/simulador');await expect(page.getByRole('heading',{name:'Empresas e industria',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+2)).toBeTruthy();
  const numeric=page.getByRole('spinbutton',{name:/Precio de venta por unidad/});await expect(numeric).toBeVisible();await numeric.fill('4');
  await expect(numeric).toHaveValue('4');
  await expect(page.getByText('Fórmula reproducible',{exact:true})).toBeVisible();
});
