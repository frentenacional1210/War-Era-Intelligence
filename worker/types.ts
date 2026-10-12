export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  WARERA_BASE_URL?: string;
  WARERA_API_KEY?: string;
  ADMIN_PASSWORD_HASH?: string;
  SESSION_SECRET?: string;
  COLLECTOR_SECRET?:string;
  SYNC_ENABLED?: string;
  AI_ENABLED?: string;
  AI_DAILY_BUDGET?: string;
  RETENTION_DAYS?: string;
  PUBLIC_RATE_LIMITER?: { limit(options:{key:string}):Promise<{success:boolean}> };
}
export const resourceTables = {'countries':'countries','regions':'regions','players':'players','parties':'parties','military-units':'military_units','battles':'battles','articles':'articles','companies':'companies','events':'events','alerts':'alerts'} as const;
