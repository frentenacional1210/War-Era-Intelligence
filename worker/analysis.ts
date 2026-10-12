import type { Env } from './types';
import { ANALYSIS_METRICS, ANALYSIS_RESOURCES, metricChange, metricsFor, type AnalysisResource, type Observation } from '../shared/analysis';

const TABLES: Record<AnalysisResource, string> = { players: 'players', parties: 'parties', 'military-units': 'military_units' };
const reply = (value: unknown, status = 200) => Response.json(value, { status });
const invalid = (message: string) => reply({ error: message }, 400);
const validId = (value: string | null): value is string => value !== null && value.length > 0 && value.length <= 100 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const parseData = (value: unknown): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(String(value ?? '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
};
const publicRow = (raw: Record<string, unknown>, resource: AnalysisResource) => {
  const metrics = metricsFor(resource, { ...raw, data: parseData(raw.data_json) });
  const { id, name, country_id, source_url, updated_at, first_seen } = raw;
  return { id, name, country_id, source_url, updated_at, first_seen, metrics };
};

export async function analysisRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/analysis/compare' && url.pathname !== '/api/analysis/history') return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return reply({ error: 'La API pública es de solo lectura.' }, 405);
  const resource = url.searchParams.get('resource');
  if (!ANALYSIS_RESOURCES.some(value => value === resource)) return invalid('Tipo de registro no válido.');
  const kind = resource as AnalysisResource;
  if (url.pathname === '/api/analysis/compare') {
    const rawIds = url.searchParams.get('ids');
    const ids = rawIds?.split(',') ?? [];
    if (ids.length < 2 || ids.length > 4 || ids.some(value => !validId(value)) || new Set(ids).size !== ids.length) return invalid('Selecciona entre dos y cuatro identificadores distintos y válidos.');
    const placeholders = ids.map(() => '?').join(',');
    const rows = (await env.DB.prepare(`SELECT * FROM ${TABLES[kind]} WHERE id IN (${placeholders})`).bind(...ids).all()).results as Record<string, unknown>[];
    const byId = new Map(rows.map(raw => [String(raw.id), publicRow(raw, kind)]));
    const missing = ids.filter(id => !byId.has(id));
    if (missing.length) return reply({ error: 'Uno o más registros no están disponibles.' }, 404);
    const source = await env.DB.prepare('SELECT id,status,last_success,last_attempt,last_error,interval_seconds,enabled FROM source_registry WHERE id=?').bind(kind).first();
    return reply({ resource: kind, metrics: ANALYSIS_METRICS[kind], items: ids.map(id => byId.get(id)!), source });
  }
  const id = url.searchParams.get('id');
  if (!validId(id)) return invalid('Identificador no válido.');
  const entity = await env.DB.prepare(`SELECT id,name,source_url,updated_at,first_seen FROM ${TABLES[kind]} WHERE id=?`).bind(id).first<Record<string, unknown>>();
  if (!entity) return reply({ error: 'Registro no encontrado.' }, 404);
  const rows = (await env.DB.prepare('SELECT captured_at,data_json FROM entity_snapshots WHERE entity_type=? AND entity_id=? ORDER BY captured_at DESC,id DESC LIMIT 90').bind(kind, id).all()).results as Record<string, unknown>[];
  const observations: Observation[] = rows.reverse().map(row => ({ captured_at: String(row.captured_at), metrics: metricsFor(kind, { data: parseData(row.data_json) }) }));
  const changes = Object.fromEntries(ANALYSIS_METRICS[kind].map(metric => [metric.key, metricChange(observations, metric.key)]));
  const source = await env.DB.prepare('SELECT id,status,last_success,last_attempt,last_error,interval_seconds,enabled FROM source_registry WHERE id=?').bind(kind).first();
  return reply({ resource: kind, item: entity, observations, observation_count: observations.length, changes, metrics: ANALYSIS_METRICS[kind], source });
}
