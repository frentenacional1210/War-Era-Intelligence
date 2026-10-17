import type { ResourceKey, Row } from './types';
import { normalizedData } from './utils';

/** A record the visitor follows in this browser, with the values seen on their last visit. */
export type Primitive = string | number | boolean | null;
export type Follow = { resource: ResourceKey; id: string; name: string; seenAt: string; seen: Record<string, Primitive> };
export type FieldChange = { key: string; before: Primitive | undefined; after: Primitive | undefined };

export const FOLLOW_KEY = 'wint:follows:v1';
export const MAX_FOLLOWS = 20;
export const FOLLOWABLE: ResourceKey[] = ['countries', 'players', 'parties', 'military-units', 'battles', 'companies', 'elections', 'governments', 'regions'];
// Bookkeeping and fields that change on almost every capture would bury real changes.
const IGNORED = new Set(['id', 'hash', 'source_url', 'first_seen', 'updated_at', 'captured_at', 'data', 'data_json', 'methodology',
  'last_active_at', 'lastConnectionAt']);

export function trackedFields(row: Row): Record<string, Primitive> {
  const merged: Record<string, unknown> = { ...normalizedData(row), ...row };
  const out: Record<string, Primitive> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (IGNORED.has(key)) continue;
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return out;
}

export function diffFields(before: Record<string, Primitive>, after: Record<string, Primitive>): FieldChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.filter(key => (before[key] ?? null) !== (after[key] ?? null)).map(key => ({ key, before: before[key], after: after[key] }));
}

const valid = (value: unknown): value is Follow => {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.resource === 'string' && FOLLOWABLE.includes(row.resource as ResourceKey) && typeof row.id === 'string' && row.id.length <= 100
    && typeof row.name === 'string' && typeof row.seenAt === 'string' && !!row.seen && typeof row.seen === 'object';
};

export function readFollows(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): Follow[] {
  try {
    const data: unknown = JSON.parse(storage?.getItem(FOLLOW_KEY) ?? '[]');
    return Array.isArray(data) ? data.filter(valid).slice(0, MAX_FOLLOWS) : [];
  } catch { return []; }
}

export function saveFollows(list: Follow[], storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): boolean {
  try { storage?.setItem(FOLLOW_KEY, JSON.stringify(list.slice(0, MAX_FOLLOWS))); return true; } catch { return false; }
}

export const isFollowed = (list: Follow[], resource: ResourceKey, id: string) => list.some(item => item.resource === resource && item.id === id);

/** Adds with the current values as "seen", or removes; refuses to exceed the bound. */
export function toggleFollow(list: Follow[], resource: ResourceKey, row: Row, name: string, now = new Date()): Follow[] {
  const id = String(row.id ?? '');
  if (isFollowed(list, resource, id)) return list.filter(item => !(item.resource === resource && item.id === id));
  if (!id || list.length >= MAX_FOLLOWS) return list;
  return [...list, { resource, id, name, seenAt: now.toISOString(), seen: trackedFields(row) }];
}

export function markSeen(list: Follow[], resource: ResourceKey, row: Row, now = new Date()): Follow[] {
  const id = String(row.id ?? '');
  return list.map(item => item.resource === resource && item.id === id ? { ...item, seenAt: now.toISOString(), seen: trackedFields(row) } : item);
}
