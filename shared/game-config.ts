/**
 * The parts of WarEra's public `gameConfig.getGameConfig` that WINT's
 * calculators use, projected and validated. Values are official parameters;
 * how the game combines them in a hit is not published (see combat.ts).
 */
export type SkillLevel = { value: number; totalCost: number; unlockAtLevel: number };
export type SkillTable = { levels: SkillLevel[]; softCap?: number; overflowTo?: string; overflowValue?: number };
export type GameItem = { code: string; type: string; rarity: string | null; usage: string | null; productionPoints: number | null;
  productionNeeds: Record<string, number>; flatStats: Record<string, number>; dynamicStats: Record<string, [number, number]>; isConsumable: boolean };
export type GameConfig = {
  skills: Record<string, SkillTable>;
  battle: Record<string, number>;
  battleTickPoints: { from: number; points: number }[];
  user: { maxEnergy: number | null; maxHunger: number | null; energyCostPerAction: number | null; healthCost: number | null; regenDividedBy: number | null };
  election: Record<string, number>;
  items: GameItem[];
  source: 'live' | 'snapshot'; fetchedAt: string;
};

const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const numbers = (value: unknown): Record<string, number> => Object.fromEntries(Object.entries(obj(value)).filter(([key, item]) => /^[A-Za-z0-9_]+$/.test(key) && num(item) !== null) as [string, number][]);

export function projectGameConfig(raw: unknown, source: GameConfig['source'], fetchedAt: string): GameConfig {
  const data = obj(raw);
  const skills: Record<string, SkillTable> = {};
  for (const [name, table] of Object.entries(obj(data.skills))) {
    const t = obj(table), levels = obj(t.levels);
    const list = Object.keys(levels).map(Number).filter(Number.isInteger).sort((a, b) => a - b).map(key => {
      const level = obj(levels[String(key)]);
      return { value: num(level.value) ?? 0, totalCost: num(level.totalCost) ?? 0, unlockAtLevel: num(level.unlockAtLevel) ?? 1 };
    });
    if (list.length) skills[name] = { levels: list, ...(num(t.softCap) !== null ? { softCap: num(t.softCap)! } : {}),
      ...(typeof t.skillOverflow === 'string' ? { overflowTo: t.skillOverflow, overflowValue: num(t.skillOverflowValue) ?? 0 } : {}) };
  }
  const battle = obj(data.battle), user = obj(data.user);
  const items: GameItem[] = Object.entries(obj(data.items)).map(([code, value]) => {
    const item = obj(value);
    const dynamic = Object.fromEntries(Object.entries(obj(item.dynamicStats)).filter(([, range]) => Array.isArray(range) && range.length === 2 && range.every(n => num(n) !== null)) as [string, [number, number]][]);
    return { code, type: String(item.type ?? 'unknown'), rarity: typeof item.rarity === 'string' ? item.rarity : null, usage: typeof item.usage === 'string' ? item.usage : null,
      productionPoints: num(item.productionPoints), productionNeeds: numbers(item.productionNeeds), flatStats: numbers(item.flatStats), dynamicStats: dynamic, isConsumable: item.isConsumable === true };
  }).filter(item => /^[A-Za-z0-9_]{1,40}$/.test(item.code));
  return {
    skills, battle: numbers(battle),
    battleTickPoints: Object.entries(numbers(battle.tickPoints)).map(([from, points]) => ({ from: Number(from), points })).sort((a, b) => a.from - b.from),
    user: { maxEnergy: num(user.maxEnergy), maxHunger: num(user.maxHunger), energyCostPerAction: num(user.energyCostPerAction), healthCost: num(battle.healthCost), regenDividedBy: num(user.regenDividedBy) },
    election: numbers(data.election), items, source, fetchedAt,
  };
}

export const skillValue = (config: GameConfig, skill: string, level: number): number => {
  const levels = config.skills[skill]?.levels ?? [];
  return levels[Math.max(0, Math.min(levels.length - 1, Math.floor(level)))]?.value ?? 0;
};
export const skillCost = (config: GameConfig, skill: string, level: number): number => {
  const levels = config.skills[skill]?.levels ?? [];
  return levels[Math.max(0, Math.min(levels.length - 1, Math.floor(level)))]?.totalCost ?? 0;
};
