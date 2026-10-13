export const DATA_RESOURCES = ['countries', 'regions', 'players', 'parties', 'military-units', 'battles', 'articles', 'companies', 'elections', 'governments', 'events', 'alerts', 'markets', 'orderbooks'] as const;
export type DataResource = typeof DATA_RESOURCES[number];
export const DATA_SCHEMA_VERSION = '1.0' as const;
export const DATA_LIMITS = { preview: 5, previewMax: 10, page: 50, pageMax: 50 } as const;

export type PublicDataRecord = {
  id: string; name: string; countryId: string | null; updatedAt: string | null; firstSeenAt: string | null;
  sourceUrl: string | null; detailUrl: string | null; historyUrl: string | null; data: Record<string, unknown>;
};
export type PublicDataset = {
  url: string; totalCaptured: number | null; lastSuccessfulCollectionAt: string | null; status: string;
  items: PublicDataRecord[];
  pagination: { limit: number; returned: number; hasMore: boolean; nextAfter: string | null; nextUrl: string | null };
};
export type PublicDataEnvelope = {
  schemaVersion: typeof DATA_SCHEMA_VERSION; generatedAt: string; scope: 'captured-public-data';
  mode: 'catalog' | 'dataset'; resource: DataResource | null;
  datasets: Partial<Record<DataResource, PublicDataset>>;
  coverage: { countriesTotal: number; countriesStarted: number; countriesCompleted: number; countriesPending: number;
    completedSweeps: number; worldPlayerTotal: null; activePlayerTotal: null } | null;
  links: { self: string; catalog: string; openapi: string; documentation: string; website: string; sourceCode: string;
    coverage: string; search: string; history: string; strategy: string; press: string; aiTools: string };
  limitations: string[];
};
