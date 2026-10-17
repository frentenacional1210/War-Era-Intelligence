import type { GameConfig } from './game-config';

/**
 * "¿Qué producir?" Official recipes (productionPoints, productionNeeds) times
 * the latest observed global prices. Returns value per production point,
 * the best use of a bar of points, and the buy-vs-make choice for inputs.
 * Prices are WINT's latest observation of global prices, not local markets.
 */
export type Prices = Record<string, number>;
export type ProductionRow = {
  code: string; type: 'raw' | 'product'; productionPoints: number; price: number | null;
  needs: { code: string; quantity: number; price: number | null }[];
  inputCost: number | null; marginPerUnit: number | null; valuePerPoint: number | null;
  /** Value per point if every input is also produced by you (whole chain). */
  chainValuePerPoint: number | null; chainPoints: number | null;
};

export function productionTable(config: GameConfig, prices: Prices): ProductionRow[] {
  const byCode = new Map(config.items.map(item => [item.code, item]));
  const price = (code: string) => Number.isFinite(prices[code]) && prices[code] > 0 ? prices[code] : null;
  return config.items.filter(item => (item.type === 'raw' || item.type === 'product') && (item.productionPoints ?? 0) > 0).map(item => {
    const points = item.productionPoints!;
    const needs = Object.entries(item.productionNeeds).map(([code, quantity]) => ({ code, quantity, price: price(code) }));
    const inputCost = needs.every(need => need.price !== null) ? needs.reduce((sum, need) => sum + need.quantity * need.price!, 0) : null;
    const own = price(item.code);
    const marginPerUnit = own !== null && inputCost !== null ? own - inputCost : null;
    const chainPoints = needs.every(need => (byCode.get(need.code)?.productionPoints ?? 0) > 0)
      ? points + needs.reduce((sum, need) => sum + need.quantity * byCode.get(need.code)!.productionPoints!, 0) : null;
    return { code: item.code, type: item.type as 'raw' | 'product', productionPoints: points, price: own, needs, inputCost, marginPerUnit,
      valuePerPoint: marginPerUnit !== null ? marginPerUnit / points : null,
      chainValuePerPoint: own !== null && chainPoints ? own / chainPoints : null, chainPoints };
  }).sort((a, b) => (b.valuePerPoint ?? -Infinity) - (a.valuePerPoint ?? -Infinity));
}

/** Units, revenue and profit for a number of production points spent on one item. */
export function productionPlan(row: ProductionRow, points: number, options: { produceInputs?: boolean; wagePerPoint?: number } = {}) {
  const usePoints = Math.max(0, points);
  const perUnitPoints = options.produceInputs && row.chainPoints ? row.chainPoints : row.productionPoints;
  const units = usePoints / perUnitPoints;
  const revenue = row.price !== null ? units * row.price : null;
  const inputs = options.produceInputs ? 0 : row.inputCost !== null ? units * row.inputCost : null;
  const wages = usePoints * Math.max(0, options.wagePerPoint ?? 0);
  return { units, revenue, inputs, wages, profit: revenue !== null && inputs !== null ? revenue - inputs - wages : null };
}
