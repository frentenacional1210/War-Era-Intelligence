import type { Row, Source } from './types';

export function text(value: unknown, fallback = '—'): string {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}
export function date(value: unknown): string {
  if (!value || typeof value !== 'string') return 'Sin fecha';
  const d = new Date(value);
  return Number.isNaN(d.valueOf()) ? 'Sin fecha' : new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}
export function age(value: unknown): string {
  if (!value || typeof value !== 'string') return 'antigüedad desconocida';
  const diff = Date.now() - new Date(value).valueOf();
  if (!Number.isFinite(diff)) return 'antigüedad desconocida';
  if (diff < -60_000) return 'fecha futura';
  if (diff < 60_000) return 'hace menos de 1 min';
  if (diff < 3_600_000) return `hace ${Math.floor(diff / 60_000)} min`;
  if (diff < 86_400_000) return `hace ${Math.floor(diff / 3_600_000)} h`;
  return `hace ${Math.floor(diff / 86_400_000)} d`;
}
export function isStale(value: unknown, interval?: number): boolean {
  if (!value || typeof value !== 'string') return true;
  const delta = Date.now() - new Date(value).valueOf();
  return !Number.isFinite(delta) || delta > Math.max((interval ?? 3600) * 3_000, 3_600_000);
}
export function number(value: unknown, digits = 0): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? new Intl.NumberFormat('es-ES', { maximumFractionDigits: digits }).format(n) : '—';
}
export function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null; }
  catch { return null; }
}
export function displayName(row: Row): string { return text(row.name ?? row.title ?? row.item_id ?? row.id, 'Sin nombre'); }
export function normalizedData(row: Row): Record<string, unknown> {
  if (!row.data) return {};
  if (typeof row.data === 'object' && !Array.isArray(row.data)) return row.data;
  if (typeof row.data === 'string') {
    try { const value: unknown = JSON.parse(row.data); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
    catch { return {}; }
  }
  return {};
}
export function sourceState(source?: Source | null): { label: string; tone: 'good' | 'warn' | 'bad' | 'muted' } {
  if (!source) return { label: 'Fuente sin confirmar', tone: 'muted' };
  if (source.status === 'unavailable-unverified') return { label: 'Fuente no verificada', tone: 'warn' };
  if (source.status === 'quota-paused') return { label: 'Pausada por cuota diaria', tone: 'warn' };
  if (source.enabled === false || source.enabled === 0) return { label: 'Fuente pausada', tone: 'warn' };
  if (source.last_error || source.status === 'error' || source.status === 'failed') return { label: 'Error de sincronización', tone: 'bad' };
  if (source.last_success && isStale(source.last_success, source.interval_seconds)) return { label: 'Datos antiguos', tone: 'warn' };
  if (source.last_success) return { label: 'Sincronizado', tone: 'good' };
  return { label: 'Esperando primera captura', tone: 'muted' };
}

const FAV_KEY = 'wint:favorites:v1';
export function readFavorites(): string[] {
  try { const data: unknown = JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]'); return Array.isArray(data) ? data.filter((v): v is string => typeof v === 'string') : []; }
  catch { return []; }
}
export function saveFavorites(items: string[]): void { localStorage.setItem(FAV_KEY, JSON.stringify(items)); }
