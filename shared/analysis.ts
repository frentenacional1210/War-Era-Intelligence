export const ANALYSIS_RESOURCES = ['players', 'parties', 'military-units'] as const;
export type AnalysisResource = typeof ANALYSIS_RESOURCES[number];
export type MetricKey = 'level' | 'experience' | 'member_count' | 'damages_count';
export type MetricValues = Partial<Record<MetricKey, number | null>>;
export type Observation = { captured_at: string; metrics: MetricValues };

export const ANALYSIS_METRICS: Record<AnalysisResource, { key: MetricKey; label: string }[]> = {
  players: [{ key: 'level', label: 'Nivel' }, { key: 'experience', label: 'Experiencia' }, { key: 'damages_count', label: 'Daño acumulado' }],
  parties: [{ key: 'member_count', label: 'Miembros' }],
  'military-units': [{ key: 'level', label: 'Nivel' }, { key: 'member_count', label: 'Miembros' }],
};

export function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const result = Number(value);
    return Number.isFinite(result) ? result : null;
  }
  return null;
}

export function metricsFor(resource: AnalysisResource, row: Record<string, unknown>): MetricValues {
  const data = row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data as Record<string, unknown> : {};
  const value = (column: string, field: string) => finiteNumber(row[column]) ?? finiteNumber(data[field]);
  if (resource === 'players') return { level: value('level', 'level'), experience: value('experience', 'experience'), damages_count: value('damages_count', 'damagesCount') };
  if (resource === 'parties') return { member_count: value('member_count', 'memberCount') };
  return { level: value('level', 'level'), member_count: value('member_count', 'memberCount') };
}

export type MetricChange = { observations: number; first: number | null; latest: number | null; delta: number | null; percent: number | null };
export function metricChange(points: Observation[], metric: MetricKey): MetricChange {
  const values = points.map(point => finiteNumber(point.metrics[metric])).filter((value): value is number => value !== null);
  if (values.length < 2) return { observations: values.length, first: values[0] ?? null, latest: values[0] ?? null, delta: null, percent: null };
  const first = values[0], latest = values[values.length - 1];
  return { observations: values.length, first, latest, delta: latest - first, percent: first === 0 ? null : (latest - first) / Math.abs(first) * 100 };
}
