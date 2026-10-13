import { calculateEconomics, compareInvestment, type EconomicScenario } from './economics';

export const AI_MODEL = '@cf/meta/llama-3.2-3b-instruct';
export const AI_TOOLS = ['census', 'country-compare', 'entity-search', 'player-compare', 'unit-military', 'politics', 'events-24h', 'market-changes', 'history', 'strategy', 'press', 'economics'] as const;
export type AiTool = typeof AI_TOOLS[number];
export const AI_RESOURCES = ['countries', 'regions', 'players', 'parties', 'military-units', 'battles', 'articles', 'companies', 'events', 'elections', 'governments', 'markets'] as const;
export type AiResource = typeof AI_RESOURCES[number];
export const AI_LIMITS = { questionBytes: 1000, promptBytes: 7000, outputTokens: 512, maxCalls: 2, reservedNeurons: 120, neuronsPerDay: 5000, callsPerDay: 100, maxIds: 4, maxRows: 50 } as const;

export type AiPlan = { tool: AiTool; ids?: string[]; resource?: AiResource; query?: string; period?: '7d' | '30d' | '90d' | '1y' | '2y' };
export type AiFact = { label: string; value: unknown; observedAt: string | null; citation: string | null };
export type AiToolResult = { tool: AiTool; parameters: Record<string, unknown>; facts: AiFact[]; missing: string[]; assumptions: string[]; observedAt: string | null };
export type AiAnswer = { tool: AiTool; facts: AiFact[]; citations: string[]; observedAt: string | null; missing: string[]; assumptions: string[]; interpretation: string | null; ai: { available: boolean; model: string | null; reason?: string }; cached?: boolean };

export const byteLength = (text: string) => new TextEncoder().encode(text).length;
export const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 100 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function parseAiPlan(value: unknown): AiPlan | null {
  const obj = record(value);
  if (!obj || !AI_TOOLS.includes(obj.tool as AiTool)) return null;
  const tool = obj.tool as AiTool;
  // Many model JSON responses include null placeholders for optional fields.
  // Validate only fields consumed by the selected fixed tool; ignore unused ones.
  const usesIds = ['country-compare', 'player-compare', 'unit-military', 'politics', 'market-changes', 'history', 'strategy', 'press'].includes(tool);
  const usesResource = tool === 'entity-search' || tool === 'history';
  const ids = usesIds && obj.ids != null ? obj.ids : undefined;
  if (ids !== undefined && (!Array.isArray(ids) || ids.length > AI_LIMITS.maxIds || ids.some(id => !validId(id)) || new Set(ids).size !== ids.length)) return null;
  if (tool === 'strategy' && Array.isArray(ids) && ids.length > 2) return null;
  if (tool === 'press' && Array.isArray(ids) && ids.length > 1) return null;
  const resource = usesResource && obj.resource != null ? obj.resource : undefined;
  if (resource !== undefined && !AI_RESOURCES.includes(resource as AiResource)) return null;
  const query = tool === 'entity-search' && obj.query != null ? obj.query : undefined;
  if (query !== undefined && (typeof query !== 'string' || byteLength(query) > 80 || /[\u0000-\u001f\u007f]/.test(query))) return null;
  const period = tool === 'history' && obj.period != null ? obj.period : undefined;
  if (period !== undefined && !['7d', '30d', '90d', '1y', '2y'].includes(String(period))) return null;
  return { tool, ids: ids as string[] | undefined, resource: resource as AiResource | undefined, query: query as string | undefined, period: period as AiPlan['period'] };
}

export function parseModelJson(text: string): unknown {
  try { return JSON.parse(text); } catch { /* Some providers wrap JSON in a fence. */ }
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (match) { try { return JSON.parse(match[1]); } catch { /* invalid */ } }
  return null;
}

export function economicReport(input: unknown): { facts: AiFact[]; assumptions: string[] } | null {
  const obj = record(input);
  if (!obj || !record(obj.base)) return null;
  const fields = ['unitsPerDay', 'salePricePerUnit', 'materialsCostPerUnit', 'wagesPerDay', 'fixedCostPerDay', 'taxRate', 'investment'] as const;
  const scenario = (value: unknown): EconomicScenario | null => {
    const row = record(value);
    if (!row || fields.some(key => typeof row[key] !== 'number' || !Number.isFinite(row[key]) || Number(row[key]) < 0 || Number(row[key]) > 1_000_000_000)) return null;
    if (Number(row.taxRate) > 1) return null;
    if (row.opportunityCostPerDay !== undefined && (typeof row.opportunityCostPerDay !== 'number' || !Number.isFinite(row.opportunityCostPerDay) || row.opportunityCostPerDay < 0 || row.opportunityCostPerDay > 1_000_000_000)) return null;
    return row as unknown as EconomicScenario;
  };
  const base = scenario(obj.base), upgrade = obj.upgrade === undefined ? null : scenario(obj.upgrade);
  if (!base || (obj.upgrade !== undefined && !upgrade)) return null;
  try {
    const value = upgrade ? compareInvestment(base, upgrade) : calculateEconomics(base);
    return { facts: [{ label: upgrade ? 'comparison' : 'scenario', value, observedAt: null, citation: null }], assumptions: ['All input values are supplied by the requester; no WarEra production rule is assumed.'] };
  } catch { return null; }
}
