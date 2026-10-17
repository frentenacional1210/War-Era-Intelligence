import { skillValue, type GameConfig } from './game-config';
import type { Prices } from './production';

/**
 * Combat estimate from official parameters. WarEra publishes skill tables,
 * item stat ranges, bonuses and costs, but not the exact hit formula, so the
 * combination below is WINT's documented model:
 *   attack     = attack skill + weapon attack (+4 per precision point over 100)
 *   hit chance = precision % (capped at 100)
 *   crit       = crit chance % (capped at 100; +4 crit damage per point over)
 *   per hit    = attack × (1 + ammo %) × (1 + Σ bonuses %) × hit chance
 *                × (1 + crit chance × crit damage %) × (1 − enemy armor %) × (1 − enemy dodge %)
 * Health costs `battle.healthCost` per hit; food restores its official % of max health.
 */
export type Build = {
  skills: { attack: number; precision: number; criticalChance: number; criticalDamages: number; health: number };
  weapon: string | null; weaponAttack?: number; weaponCrit?: number;
  ammo: string | null; food: string | null;
  helmetCritDamages: number; glovesPrecision: number;
  bonuses: string[];
  enemyArmor: number; enemyDodge: number;
};
export const BONUSES: Record<string, { label: string; key: string }> = {
  countryOrder: { label: 'Orden del país', key: 'countryOrderBonusPercent' },
  muOrder: { label: 'Orden de la unidad', key: 'muOrderBonusPercent' },
  alliance: { label: 'Daño de alianza', key: 'allianceDamagesBonusPercent' },
  enemy: { label: 'País enemigo declarado', key: 'enemyDamagesBonusPercent' },
  patriotic: { label: 'Bonificación patriótica', key: 'patrioticBonusPercent' },
  notLinked: { label: 'Región sin conexión con la capital', key: 'regionNotLinkedToCapitalMalusPercent' },
  lostAttacking: { label: 'Región atacante perdida', key: 'lostAttackingRegionMalusPercent' },
  occupying: { label: 'Ocupan tus regiones', key: 'occupyingYourRegionsMalusPercent' },
};
const mid = (range?: [number, number]) => range ? (range[0] + range[1]) / 2 : 0;
const cap = (value: number, max = 100) => Math.max(0, Math.min(max, value));

export function combatEstimate(config: GameConfig, build: Build, prices: Prices = {}) {
  const item = (code: string | null) => code ? config.items.find(entry => entry.code === code) : undefined;
  const weapon = item(build.weapon), ammo = item(build.ammo), food = item(build.food);
  const precisionRaw = skillValue(config, 'precision', build.skills.precision) + build.glovesPrecision;
  const precisionOverflow = Math.max(0, precisionRaw - 100) * (config.skills.precision?.overflowValue ?? 0);
  const critRaw = skillValue(config, 'criticalChance', build.skills.criticalChance) + (build.weaponCrit ?? mid(weapon?.dynamicStats.criticalChance));
  const critOverflow = Math.max(0, critRaw - 100) * (config.skills.criticalChance?.overflowValue ?? 0);
  const attack = skillValue(config, 'attack', build.skills.attack) + (build.weaponAttack ?? mid(weapon?.dynamicStats.attack)) + precisionOverflow;
  const critDamages = skillValue(config, 'criticalDamages', build.skills.criticalDamages) + build.helmetCritDamages + critOverflow;
  const hitChance = cap(precisionRaw) / 100, critChance = cap(critRaw) / 100;
  const ammoPercent = ammo?.flatStats.percentAttack ?? 0;
  const bonusPercent = build.bonuses.reduce((sum, key) => sum + (BONUSES[key] ? config.battle[BONUSES[key].key] ?? 0 : 0), 0);
  const armorCap = config.skills.armor?.softCap ?? 100, dodgeCap = config.skills.dodge?.softCap ?? 100;
  const enemyFactor = (1 - cap(build.enemyArmor, armorCap) / 100) * (1 - cap(build.enemyDodge, dodgeCap) / 100);
  const baseHit = attack * (1 + ammoPercent / 100) * Math.max(0, 1 + bonusPercent / 100);
  const expectedHit = baseHit * hitChance * (1 + critChance * critDamages / 100) * enemyFactor;
  const health = skillValue(config, 'health', build.skills.health), healthCost = config.user.healthCost ?? 10;
  const hitsPerBar = Math.floor(health / healthCost);
  const hitsPerFood = food?.flatStats.healthRegenPercent ? (health * food.flatStats.healthRegenPercent / 100) / healthCost : null;
  const ammoPrice = build.ammo ? prices[build.ammo] ?? null : 0;
  const foodPrice = build.food ? prices[build.food] ?? null : null;
  const costPerHit = ammoPrice === null ? null : ammoPrice + (hitsPerFood && foodPrice !== null ? foodPrice / hitsPerFood : 0);
  return {
    attack, hitChance, critChance, critDamages, ammoPercent, bonusPercent, baseHit, expectedHit, enemyFactor,
    hitsPerBar, damagePerBar: expectedHit * hitsPerBar, hitsPerFood, damagePerFood: hitsPerFood ? expectedHit * hitsPerFood : null,
    costPerHit, costPer1kDamage: costPerHit !== null && expectedHit > 0 ? costPerHit / expectedHit * 1000 : null,
    skillPoints: (['attack', 'precision', 'criticalChance', 'criticalDamages', 'health'] as const)
      .reduce((sum, skill) => sum + (config.skills[skill]?.levels[Math.max(0, Math.min(10, build.skills[skill]))]?.totalCost ?? 0), 0),
  };
}
