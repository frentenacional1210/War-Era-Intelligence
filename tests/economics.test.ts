import { describe, expect, it } from 'vitest';
import { calculateEconomics, compareInvestment, compareProductionChain, priceSensitivity } from '../shared/economics';

const base = { unitsPerDay: 10, salePricePerUnit: 20, materialsCostPerUnit: 5, wagesPerDay: 20, fixedCostPerDay: 10, taxRate: 0.1, investment: 100 };

describe('simulador de escenarios editables', () => {
  it('expone costes, beneficio y amortización reproducibles', () => {
    expect(calculateEconomics(base)).toMatchObject({ revenuePerDay: 200, materialsCostPerDay: 50, taxesPerDay: 20,
      totalCostPerDay: 100, unitCost: 10, netProfitPerDay: 100, roiPerDay: 1, paybackDays: 1 });
  });

  it('no afirma amortización cuando no hay beneficio ni divide entre cero', () => {
    expect(calculateEconomics({ ...base, unitsPerDay: 0 })).toMatchObject({ unitCost: null, paybackDays: null });
    expect(() => calculateEconomics({ ...base, taxRate: 1.1 })).toThrow(RangeError);
  });

  it('compara ampliación, sensibilidad y transformación con entradas explícitas', () => {
    expect(compareInvestment(base, { ...base, unitsPerDay: 20, investment: 200 }).marginalPaybackDays).toBeCloseTo(100 / 130);
    expect(priceSensitivity(base, [-0.1, 0.1]).map(x => x.profitPerDay)).toEqual([82, 118]);
    expect(compareProductionChain({ rawUnits: 10, rawSalePrice: 5, outputUnitsPerRawUnit: 2,
      outputSalePrice: 4, processingCostPerRawUnit: 1, extraFixedCost: 5, taxRate: 0 }).transformationAdvantage).toBe(15);
  });
});
