import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// Main public pages. Serious and critical WCAG 2.1 A/AA violations fail the run;
// moderate findings are attached to the report for follow-up.
const PAGES = ['/', '/hoy', '/herramientas/produccion', '/herramientas/combate', '/herramientas/elecciones', '/paises', '/jugadores', '/alertas', '/historicos', '/cobertura', '/mercados', '/ia', '/seguimiento', '/estado'];

for (const path of PAGES) {
  test(`accesibilidad sin infracciones graves en ${path}`, async ({ page }, testInfo) => {
    await page.goto(path);
    await page.locator('main h1').first().waitFor();
    await page.waitForLoadState('networkidle');
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    const summary = results.violations.map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.length, example: item.nodes[0]?.target.join(' ') }));
    await testInfo.attach('axe-violations.json', { body: JSON.stringify(summary, null, 2), contentType: 'application/json' });
    expect(summary.filter(item => item.impact === 'serious' || item.impact === 'critical')).toEqual([]);
  });
}
