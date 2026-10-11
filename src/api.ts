import type { Collection, Detail, Row, Source, Status, Summary } from './types';

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = 'ApiError'; }
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init, headers: { Accept: 'application/json', ...init.headers } });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body ? String(body.error) : `Error HTTP ${response.status}`;
    throw new ApiError(message, response.status);
  }
  return body as T;
}

export function adminRequest<T>(path: string, method: string, body?: unknown): Promise<T> {
  return request<T>(path, { method, headers: { 'Content-Type': 'application/json', 'X-WINT-CSRF': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
}

export function getCollection(path: string, params: URLSearchParams): Promise<Collection> {
  return request<Collection>(`${path}?${params.toString()}`);
}
export function getDetail(path: string, id: string): Promise<Detail> {
  return request<Detail>(`${path}/${encodeURIComponent(id)}`);
}
export function getStatus(): Promise<Status> { return request<Status>('/api/status'); }
export function getSummary(): Promise<Summary> { return request<Summary>('/api/dashboard/summary'); }
export function getMarketHistory(id: string): Promise<{ items: Row[]; source: Source | null }> {
  return request(`/api/markets/history?item=${encodeURIComponent(id)}`);
}
