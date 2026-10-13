export type ExtendedSource = 'companies' | 'elections' | 'governments';
export type RelationResource = 'players' | 'parties' | 'military-units' | 'companies' | 'countries' | 'elections' | 'governments';
export type RelationRef = { type: RelationResource; id: string; relation: string };

export const asObject = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const safeId = (value: unknown): string | null => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : null;
export const safeText = (value: unknown, max = 300): string => typeof value === 'string' ? value.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
export const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
export const dateString = (value: unknown): string | null => typeof value === 'string' && value.length <= 80 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

export type PublicGroupProjection = {
  memberCount: number | null;
  roleIds: { councilMembers: string[]; managers: string[]; commanders: string[] };
  roleCounts: { councilMembers: number | null; managers: number | null; commanders: number | null };
  rolesTruncated: boolean;
  monthlyDamages: number | null;
};

/** Public party/unit role IDs are bounded; full member arrays are never copied. */
export function projectPublicGroupRelations(kind: 'parties' | 'military-units', value: unknown): PublicGroupProjection {
  const raw = asObject(value), roles = asObject(raw.roles), leveling = asObject(raw.leveling);
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return { ids: [], count: null, truncated: false };
    const ids = [...new Set(value.slice(0, 64).map(safeId).filter((id): id is string => id !== null))];
    return { ids, count: value.length, truncated: value.length > 64 };
  };
  const council = collect(kind === 'parties' ? raw.councilMembers : null);
  const managers = collect(kind === 'military-units' ? roles.managers : null);
  const commanders = collect(kind === 'military-units' ? roles.commanders : null);
  const monthly = finite(leveling.monthlyDamages);
  return { memberCount: Array.isArray(raw.members) ? raw.members.length : null,
    roleIds: { councilMembers: council.ids, managers: managers.ids, commanders: commanders.ids },
    roleCounts: { councilMembers: council.count, managers: managers.count, commanders: commanders.count },
    rolesTruncated: council.truncated || managers.truncated || commanders.truncated,
    monthlyDamages: kind === 'military-units' && monthly !== null && monthly >= 0 ? monthly : null };
}

/** IDs are taken only from observed API fields retained in WINT snapshots. */
export function relationRefs(resource: RelationResource, value: unknown): RelationRef[] {
  const data = asObject(value);
  const refs: RelationRef[] = [];
  const add = (type: RelationResource, candidate: unknown, relation: string) => {
    const id = safeId(candidate);
    if (id) refs.push({ type, id, relation });
  };
  const many = (type: RelationResource, values: unknown, relation: string) => {
    if (Array.isArray(values)) for (const value of values.slice(0, 100)) add(type, value, relation);
  };
  if (resource === 'players') {
    add('military-units', data.mu, 'military-unit-member');
    add('military-units', data.military_unit_id, 'military-unit-member');
    add('parties', data.party, 'party-member');
    add('parties', data.party_id, 'party-member');
    add('countries', data.country, 'country');
    add('countries', data.countryId ?? data.country_id, 'country');
  } else if (resource === 'parties') {
    add('players', data.leader, 'party-leader');
    add('countries', data.country, 'country');
    many('players', data.councilMembers ?? asObject(data.roleIds).councilMembers, 'party-council');
  } else if (resource === 'military-units') {
    add('players', data.owner, 'unit-owner');
    add('countries', data.country, 'country');
    const roles = asObject(data.roles), roleIds = asObject(data.roleIds);
    many('players', roles.managers ?? roleIds.managers, 'unit-manager');
    many('players', roles.commanders ?? roleIds.commanders, 'unit-commander');
  } else if (resource === 'companies') {
    add('players', data.owner, 'company-owner');
    add('countries', data.country, 'country');
  } else if (resource === 'elections') {
    add('countries', data.country, 'country');
    const candidates = Array.isArray(data.candidates) ? data.candidates.slice(0, 100) : [];
    for (const candidate of candidates) {
      const row = asObject(candidate);
      add('players', row.user, 'election-candidate');
      add('parties', row.party, 'candidate-party');
    }
  } else if (resource === 'governments') {
    add('countries', data.country, 'country');
    add('players', data.president, 'president');
    add('players', data.vicePresident, 'vice-president');
    add('players', data.minOfDefense, 'minister-defense');
    add('players', data.minOfEconomy, 'minister-economy');
    add('players', data.minOfForeignAffairs, 'minister-foreign-affairs');
    many('players', data.congressMembers, 'congress-member');
  }
  return [...new Map(refs.map(ref => [`${ref.type}:${ref.id}:${ref.relation}`, ref])).values()];
}

export type ElectionResultState = 'official-results' | 'candidates-only' | 'results-unavailable';
export function electionResultState(value: unknown): ElectionResultState {
  const election = asObject(value);
  const candidates = Array.isArray(election.candidates) ? election.candidates : [];
  const elected = Array.isArray(election.electedCandidates) ? election.electedCandidates.some(id => safeId(id)) : false;
  const candidateElected = candidates.some(item => asObject(item).isElected === true);
  const finished = typeof election.status === 'string' && ['finished', 'completed', 'ended', 'closed', 'concluded'].includes(election.status.toLowerCase());
  if (election.isActive === false && (elected || candidateElected || (finished && finite(election.electedCount) !== null && Number(election.electedCount) > 0))) return 'official-results';
  return candidates.length ? 'candidates-only' : 'results-unavailable';
}
