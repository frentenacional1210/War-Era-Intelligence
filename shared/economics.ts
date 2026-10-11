/** Scenario arithmetic only. Every value is supplied by the user; no game formula is assumed. */
export interface EconomicScenario {
  unitsPerDay: number;
  salePricePerUnit: number;
  materialsCostPerUnit: number;
  wagesPerDay: number;
  fixedCostPerDay: number;
  taxRate: number; // fraction of revenue, e.g. 0.1 = 10%; editable assumption
  investment: number;
  opportunityCostPerDay?: number;
}

export interface EconomicResult {
  revenuePerDay: number;
  materialsCostPerDay: number;
  taxesPerDay: number;
  totalCostPerDay: number;
  unitCost: number | null;
  grossMarginPerUnit: number;
  netProfitPerDay: number;
  netProfitPerUnit: number | null;
  roiPerDay: number | null;
  paybackDays: number | null;
  breakEvenUnitsPerDay: number | null;
}

function valid(value: number, name: string, min = 0, max = Number.POSITIVE_INFINITY): void {
  if (!Number.isFinite(value) || value < min || value > max) throw new RangeError(`${name} debe ser un número finito entre ${min} y ${max}.`);
}

export function calculateEconomics(input: EconomicScenario): EconomicResult {
  valid(input.unitsPerDay, 'unitsPerDay');
  valid(input.salePricePerUnit, 'salePricePerUnit');
  valid(input.materialsCostPerUnit, 'materialsCostPerUnit');
  valid(input.wagesPerDay, 'wagesPerDay');
  valid(input.fixedCostPerDay, 'fixedCostPerDay');
  valid(input.taxRate, 'taxRate', 0, 1);
  valid(input.investment, 'investment');
  valid(input.opportunityCostPerDay ?? 0, 'opportunityCostPerDay');
  const revenuePerDay = input.unitsPerDay * input.salePricePerUnit;
  const materialsCostPerDay = input.unitsPerDay * input.materialsCostPerUnit;
  const taxesPerDay = revenuePerDay * input.taxRate;
  const fixed = input.wagesPerDay + input.fixedCostPerDay + (input.opportunityCostPerDay ?? 0);
  const totalCostPerDay = materialsCostPerDay + taxesPerDay + fixed;
  const netProfitPerDay = revenuePerDay - totalCostPerDay;
  const contribution = input.salePricePerUnit * (1 - input.taxRate) - input.materialsCostPerUnit;
  return {
    revenuePerDay, materialsCostPerDay, taxesPerDay, totalCostPerDay,
    unitCost: input.unitsPerDay > 0 ? totalCostPerDay / input.unitsPerDay : null,
    grossMarginPerUnit: input.salePricePerUnit - input.materialsCostPerUnit,
    netProfitPerDay,
    netProfitPerUnit: input.unitsPerDay > 0 ? netProfitPerDay / input.unitsPerDay : null,
    roiPerDay: input.investment > 0 ? netProfitPerDay / input.investment : null,
    paybackDays: input.investment > 0 && netProfitPerDay > 0 ? input.investment / netProfitPerDay : null,
    breakEvenUnitsPerDay: contribution > 0 ? fixed / contribution : null,
  };
}

export interface InvestmentComparison {
  base: EconomicResult;
  upgrade: EconomicResult;
  marginalProfitPerDay: number;
  additionalInvestment: number;
  marginalPaybackDays: number | null;
}

export function compareInvestment(base: EconomicScenario, upgrade: EconomicScenario): InvestmentComparison {
  const first = calculateEconomics(base);
  const second = calculateEconomics(upgrade);
  const additionalInvestment = upgrade.investment - base.investment;
  const marginalProfitPerDay = second.netProfitPerDay - first.netProfitPerDay;
  return { base: first, upgrade: second, additionalInvestment, marginalProfitPerDay,
    marginalPaybackDays: additionalInvestment > 0 && marginalProfitPerDay > 0 ? additionalInvestment / marginalProfitPerDay : null };
}

export function priceSensitivity(input: EconomicScenario, changes: number[]): { change: number; price: number; profitPerDay: number }[] {
  return changes.map(change => {
    if (!Number.isFinite(change) || change < -1) throw new RangeError('El cambio de precio debe ser finito y al menos -1.');
    const price = input.salePricePerUnit * (1 + change);
    return { change, price, profitPerDay: calculateEconomics({ ...input, salePricePerUnit: price }).netProfitPerDay };
  });
}

/** Compare sale of a raw input with transforming it, using an explicitly supplied yield and cost. */
export function compareProductionChain(input: {
  rawUnits: number;
  rawSalePrice: number;
  outputUnitsPerRawUnit: number;
  outputSalePrice: number;
  processingCostPerRawUnit: number;
  extraFixedCost: number;
  taxRate: number;
}): { sellRawProfit: number; transformProfit: number; transformationAdvantage: number } {
  for (const [key, value] of Object.entries(input)) valid(value, key, 0, key === 'taxRate' ? 1 : Number.POSITIVE_INFINITY);
  const sellRawProfit = input.rawUnits * input.rawSalePrice * (1 - input.taxRate);
  const transformProfit = input.rawUnits * input.outputUnitsPerRawUnit * input.outputSalePrice * (1 - input.taxRate)
    - input.rawUnits * input.processingCostPerRawUnit - input.extraFixedCost;
  return { sellRawProfit, transformProfit, transformationAdvantage: transformProfit - sellRawProfit };
}
