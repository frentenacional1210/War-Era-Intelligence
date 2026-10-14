export const HISTORY_RESOURCES = ['players', 'parties', 'military-units', 'countries', 'regions', 'battles', 'markets', 'companies', 'elections', 'governments'] as const;
export type HistoryResource = typeof HISTORY_RESOURCES[number];
export const HISTORY_PERIODS = ['7d', '30d', '90d', '1y', '2y'] as const;
export type HistoryPeriod = typeof HISTORY_PERIODS[number];
export type HistoryGrain = 'raw' | 'day' | 'week' | 'month' | 'baseline';
export type HistoryMetric = number | string | boolean | null;
export type HistoryMetrics = Record<string, HistoryMetric>;
export type HistoryPoint = {
  observed_at: string;
  first_observed_at: string;
  bucket_start: string;
  grain: HistoryGrain;
  metrics: HistoryMetrics;
  observations: number;
  method: 'observed-change' | 'bucket-last' | 'earliest-available';
  source: 'raw' | 'rollup' | 'mixed' | 'baseline';
};
export type HistoryGap = { from: string; to: string; reason: 'no-observation' | 'before-first-capture' | 'archive-pending' | 'raw-retention' | 'resolution-retention' };
export type HistorySeries = {
  resource: HistoryResource;
  id: string;
  entityName: string | null;
  sourceUrl: string | null;
  sourceMeaning: 'current-entity-source' | null;
  period: HistoryPeriod;
  grain: Exclude<HistoryGrain, 'baseline'>;
  from: string;
  to: string;
  points: HistoryPoint[];
  gaps: HistoryGap[];
  baseline: HistoryPoint | null;
  truncated: boolean;
  archive_pending: boolean;
  boundaryLimited: boolean;
  methodology: string;
  methodologyVersion: '2';
  retention: { rawDays: 30; dayDays: 90; weekDays: 366; monthMonths: 24; baseline: 'lifetime' };
  nextCursor: string | null;
  nextUrl: string | null;
};

export const HISTORY_FIELDS: Record<HistoryResource, readonly string[]> = {
  players: ['level', 'experience', 'damages_count', 'is_active', 'last_connection_at', 'country_id', 'party_id', 'military_unit_id'],
  parties: ['member_count', 'leader_id', 'country_id'],
  'military-units': ['level', 'member_count', 'leader_id', 'country_id', 'monthly_damages'],
  countries: ['population', 'development', 'money', 'ruling_party_id'],
  regions: ['country_id', 'initial_country_id', 'is_capital'],
  battles: ['active', 'round', 'attacker_damages', 'defender_damages', 'attacker_country_id', 'defender_country_id', 'region_id', 'ended_at', 'won_by'],
  markets: ['price'],
  companies: ['production', 'worker_count', 'estimated_value', 'concrete_invested', 'is_full', 'owner_id', 'region_id', 'item_code', 'storage_upgrade', 'automated_engine_upgrade', 'break_room_upgrade'],
  elections: ['status', 'is_active', 'votes_count', 'elected_count', 'country_id', 'election_type', 'votes_start_at', 'votes_end_at'],
  governments: ['president_id', 'vice_president_id', 'minister_defense_id', 'minister_economy_id', 'minister_foreign_affairs_id', 'congress_count', 'country_id'],
};

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const numeric = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const identifier = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null;
const shortText = (value: unknown, maximum = 100): string | null => typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : null;
const truth = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;
const time = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

/** Only fields already present in persisted, public WarEra observations are projected. */
export function historyMetrics(resource: string, value: unknown): HistoryMetrics {
  const data = object(value);
  if (resource === 'players') return {
    level: numeric(data.level), experience: numeric(data.experience), damages_count: numeric(data.damagesCount),
    is_active: truth(data.isActive), last_connection_at: time(data.lastConnectionAt) ?? time(data.last_active_at),
    country_id: identifier(data.countryId), party_id: identifier(data.party_id) ?? identifier(data.partyId),
    military_unit_id: identifier(data.military_unit_id) ?? identifier(data.mu),
  };
  if (resource === 'parties') return { member_count: numeric(data.memberCount), leader_id: identifier(data.leader), country_id: identifier(data.country) };
  if (resource === 'military-units') return { level: numeric(data.level), member_count: numeric(data.memberCount), leader_id: identifier(data.owner), country_id: identifier(data.country), monthly_damages: numeric(data.monthlyDamages) };
  if (resource === 'countries') return {
    population: numeric(data.currentPopulation), development: numeric(data.currentDevelopment),
    money: numeric(data.money), ruling_party_id: identifier(data.rulingParty),
  };
  if (resource === 'regions') return { country_id: identifier(data.country), initial_country_id: identifier(data.initialCountry), is_capital: truth(data.isCapital) };
  if (resource === 'battles') return {
    active: truth(data.isActive), round: numeric(data.currentRound), attacker_damages: numeric(data.attackerDamages),
    defender_damages: numeric(data.defenderDamages), attacker_country_id: identifier(data.attackerCountry),
    defender_country_id: identifier(data.defenderCountry), region_id: identifier(data.region),
    ended_at: time(data.endedAt), won_by: shortText(data.wonBy),
  };
  if (resource === 'markets') return { price: numeric(data.price) };
  if (resource === 'companies') {
    const upgrades = object(data.upgrades);
    return { production: numeric(data.production), worker_count: numeric(data.workerCount),
      estimated_value: numeric(data.estimatedValue), concrete_invested: numeric(data.concreteInvested),
      is_full: truth(data.isFull), owner_id: identifier(data.owner), region_id: identifier(data.region),
      item_code: shortText(data.itemCode), storage_upgrade: numeric(upgrades.storage),
      automated_engine_upgrade: numeric(upgrades.automatedEngine), break_room_upgrade: numeric(upgrades.breakRoom) };
  }
  if (resource === 'elections') return { status: shortText(data.status, 60), is_active: truth(data.isActive),
    votes_count: numeric(data.votesCount), elected_count: numeric(data.electedCount),
    country_id: identifier(data.country), election_type: shortText(data.type, 40),
    votes_start_at: time(data.votesStartAt), votes_end_at: time(data.votesEndAt) };
  if (resource === 'governments') {
    const members = Array.isArray(data.congressMembers) ? data.congressMembers : null;
    return { president_id: identifier(data.president), vice_president_id: identifier(data.vicePresident),
      minister_defense_id: identifier(data.minOfDefense), minister_economy_id: identifier(data.minOfEconomy),
      minister_foreign_affairs_id: identifier(data.minOfForeignAffairs),
      congress_count: members && members.length > 0 && data.congressTruncated !== true ? members.length : null,
      country_id: identifier(data.country) };
  }
  return {};
}

export const validHistoryId = (value: string | null): value is string =>
  value !== null && value.length > 0 && value.length <= 100 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
export const isHistoryResource = (value: string | null): value is HistoryResource => HISTORY_RESOURCES.some(resource => resource === value);
export const isHistoryPeriod = (value: string | null): value is HistoryPeriod => HISTORY_PERIODS.some(period => period === value);

export function historyWindow(period: HistoryPeriod, now: Date): { from: string; to: string; grain: 'raw' | 'day' | 'week' | 'month' } {
  const to = now.toISOString();
  const from = new Date(now);
  if (period === '7d') from.setUTCDate(from.getUTCDate() - 7);
  if (period === '30d') from.setUTCDate(from.getUTCDate() - 30);
  if (period === '90d') from.setUTCDate(from.getUTCDate() - 90);
  if (period === '1y') from.setUTCFullYear(from.getUTCFullYear() - 1);
  if (period === '2y') from.setUTCFullYear(from.getUTCFullYear() - 2);
  return { from: from.toISOString(), to, grain: period === '7d' ? 'raw' : period === '30d' || period === '90d' ? 'day' : period === '1y' ? 'week' : 'month' };
}

export function bucketStart(when: string, grain: 'day' | 'week' | 'month'): string {
  const date = new Date(when);
  if (!Number.isFinite(date.valueOf())) throw new Error('Invalid historical capture time');
  date.setUTCHours(0, 0, 0, 0);
  if (grain === 'week') date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  if (grain === 'month') date.setUTCDate(1);
  return date.toISOString();
}

export function advanceBucket(start: string, grain: 'day' | 'week' | 'month'): string {
  const date = new Date(start);
  if (grain === 'day') date.setUTCDate(date.getUTCDate() + 1);
  if (grain === 'week') date.setUTCDate(date.getUTCDate() + 7);
  if (grain === 'month') date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString();
}
