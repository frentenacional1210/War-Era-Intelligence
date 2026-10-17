import { describe, expect, it } from 'vitest';
import snapshot from '../shared/game-config.snapshot.json';
import type { GameConfig } from '../shared/game-config';
import { productionPlan, productionTable } from '../shared/production';
import { combatEstimate, type Build } from '../shared/combat';

const config = snapshot as unknown as GameConfig;
const prices = { iron: 0.1, steel: 2, grain: 0.08, bread: 2, lead: 0.1, ammo: 0.8, heavyAmmo: 3.3, lightAmmo: 0.2, livestock: 1.6, steak: 4 };

describe('production calculator on official recipes', () => {
  it('values steel from its official recipe (10 iron, 10 points) and real prices', () => {
    const steel = productionTable(config, prices).find(row => row.code === 'steel')!;
    expect(steel.productionPoints).toBe(10);
    expect(steel.needs).toEqual([{ code: 'iron', quantity: 10, price: 0.1 }]);
    expect(steel.inputCost).toBeCloseTo(1);
    expect(steel.marginPerUnit).toBeCloseTo(1);
    expect(steel.valuePerPoint).toBeCloseTo(0.1);
    expect(steel.chainPoints).toBe(10 + 10 * 1);
    expect(steel.chainValuePerPoint).toBeCloseTo(0.1);
    const plan = productionPlan(steel, 40, { wagePerPoint: 0.01 });
    expect(plan.units).toBeCloseTo(4);
    expect(plan.profit).toBeCloseTo(4 * 2 - 4 * 1 - 0.4);
  });
  it('ranks by value per point and leaves items without prices unranked', () => {
    const table = productionTable(config, prices);
    const ranked = table.filter(row => row.valuePerPoint !== null);
    expect(ranked.map(row => row.valuePerPoint)).toEqual([...ranked.map(row => row.valuePerPoint)].sort((a, b) => b! - a!));
    expect(table.find(row => row.code === 'concrete')?.valuePerPoint).toBeNull();
  });
});

describe('combat calculator on official parameters', () => {
  const base: Build = { skills: { attack: 0, precision: 0, criticalChance: 0, criticalDamages: 0, health: 0 }, weapon: null, ammo: null, food: null,
    helmetCritDamages: 0, glovesPrecision: 0, bonuses: [], enemyArmor: 0, enemyDodge: 0 };
  it('computes a level-0 unarmed hit from the official skill tables', () => {
    const result = combatEstimate(config, base);
    // attack 100, precision 50 %, crit 10 % × 100 % damage.
    expect(result.attack).toBe(100);
    expect(result.expectedHit).toBeCloseTo(100 * 0.5 * (1 + 0.1 * 1));
    expect(result.hitsPerBar).toBe(10);
    expect(result.skillPoints).toBe(0);
  });
  it('applies weapon, ammo, bonuses, enemy armor cap, precision overflow and costs', () => {
    const result = combatEstimate(config, { ...base, skills: { attack: 10, precision: 10, criticalChance: 0, criticalDamages: 0, health: 10 },
      weapon: 'rifle', ammo: 'ammo', food: 'bread', glovesPrecision: 20, bonuses: ['countryOrder', 'patriotic'], enemyArmor: 90 }, prices);
    expect(result.attack).toBe(350 + 80.5 + 20 * 4); // rifle midpoint (71+90)/2; precision 120 -> 20 over, ×4 attack
    expect(result.hitChance).toBe(1);
    expect(result.bonusPercent).toBe(30);
    expect(result.enemyFactor).toBeCloseTo(0.6); // armor capped at the official soft cap of 40
    expect(result.hitsPerBar).toBe(20);
    expect(result.hitsPerFood).toBeCloseTo(2);
    expect(result.costPerHit).toBeCloseTo(0.8 + 2 / 2);
    expect(result.costPer1kDamage).toBeCloseTo(result.costPerHit! / result.expectedHit * 1000);
    expect(result.skillPoints).toBe(55 * 3);
  });
});
