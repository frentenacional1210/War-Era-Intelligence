export const INGESTION_DAILY_BUDGET = 80_000;
export const PAGE_ROWS = 10;
export const PLAYER_ROWS = 4;
export const COLLECTOR_PLAYER_ROWS = 8;
export const DETAIL_ROWS = 3;
// Half the scheduled slots grow the player census; two grow the archive.
// Remaining slots rotate through every other due source. Idle slots are shared.
export const INGESTION_SLOTS = ['players', 'articles', 'players', null, 'players', 'articles', 'players', null, 'players', null] as const;
