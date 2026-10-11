export type Row = Record<string, unknown> & {
  id?: string | number;
  name?: string;
  title?: string;
  country_id?: string | number;
  source_url?: string;
  updated_at?: string;
  first_seen?: string;
  published_at?: string;
  captured_at?: string;
  level?: number;
  experience?: number;
  price?: number;
  item_id?: string;
  author_id?: string | number;
  data?: Record<string, unknown> | string | null;
};

export type Source = {
  id: string;
  endpoint?: string;
  status?: string;
  last_success?: string | null;
  last_attempt?: string | null;
  last_error?: string | null;
  interval_seconds?: number;
  enabled?: boolean | number;
  record_count?: number;
};

export type Collection = { items: Row[]; total: number; page: number; limit: number; source: Source | null };
export type Detail = { item: Row; history: Row[]; source: Source | null };
export type Status = {
  sources: Source[];
  ai: { enabled: boolean; status: string };
  totals: Record<string, number>;
  timestamp: string;
};
export type Summary = Status & {
  recentEvents: Row[];
  recentArticles: Row[];
  marketPrices: Row[];
  activeBattles: Row[];
};

export const RESOURCES = {
  countries: { endpoint: '/api/countries', title: 'Países', singular: 'País', icon: 'Globe2', description: 'Censo territorial documentado por las fuentes activas.' },
  players: { endpoint: '/api/players', title: 'Jugadores', singular: 'Jugador', icon: 'UsersRound', description: 'Perfiles públicos capturados y normalizados.' },
  parties: { endpoint: '/api/parties', title: 'Partidos', singular: 'Partido', icon: 'Landmark', description: 'Directorio político basado en registros comprobables.' },
  'military-units': { endpoint: '/api/military-units', title: 'Unidades militares', singular: 'Unidad militar', icon: 'Shield', description: 'Unidades conocidas y procedencia de cada registro.' },
  battles: { endpoint: '/api/battles', title: 'Batallas', singular: 'Batalla', icon: 'Crosshair', description: 'Conflictos capturados por las fuentes verificadas.' },
  companies: { endpoint: '/api/companies', title: 'Empresas', singular: 'Empresa', icon: 'Factory', description: 'Empresas públicas capturadas.' },
  articles: { endpoint: '/api/articles', title: 'Artículos', singular: 'Artículo', icon: 'Newspaper', description: 'Hemeroteca pública con atribución a la fuente original.' },
  events: { endpoint: '/api/events', title: 'Acontecimientos', singular: 'Acontecimiento', icon: 'Activity', description: 'Cambios detectados sobre datos capturados.' },
  alerts: { endpoint: '/api/alerts', title: 'Alertas', singular: 'Alerta', icon: 'Bell', description: 'Señales calculadas a partir de registros observados.' },
  regions: { endpoint: '/api/regions', title: 'Regiones', singular: 'Región', icon: 'MapPinned', description: 'Regiones disponibles en el registro territorial.' },
} as const;
export type ResourceKey = keyof typeof RESOURCES;
