export const INGESTION_DAILY_BUDGET = 80_000;
export const INGESTION_DAILY_READ_BUDGET = 3_000_000;
export const INGESTION_READ_RESERVATION = 10_000;
export const PAGE_ROWS = 10;
export const PLAYER_ROWS = 4;
export const COLLECTOR_PLAYER_ROWS = 8;
export const DETAIL_ROWS = 3;
// While the GitHub collector committed a players/articles page this recently,
// scheduled ticks leave that source to it: compact pages cost fewer writes per
// record and a parallel tick would make the collector's prepared page stale.
export const COLLECTOR_HANDOFF_SECONDS = 1800;
export const PLAYER_COLLECTION_POLICY = { mode: 'active-only', activeField: 'isActive', activeValue: true,
  unknownActivity: 'skip', rediscovery: 'country-sweeps', existingRecords: 'preserved' } as const;
// Half the scheduled slots grow the player census; two grow the archive.
// Remaining slots rotate through every other due source. Idle slots are shared.
export const INGESTION_SLOTS = ['players', 'articles', 'players', null, 'players', 'articles', 'players', null, 'players', null] as const;
