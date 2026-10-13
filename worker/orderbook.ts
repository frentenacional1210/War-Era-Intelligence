import { z } from 'zod';
import type { Env } from './types';
import { WarEraClient } from './warera';
import {
  itemCodeSchema, ORDERBOOK_COVERAGE, ORDERBOOK_LIMIT, ORDERBOOK_PROCEDURE,
  projectTopOrders, topOrdersSchema,
} from '../shared/orderbook';

export const orderbookSourceTables = { orderbooks: 'orderbook_snapshots' } as const;
export type OrderbookCursor = { lastItemId?: string };
export type OrderbookBatch = { records: unknown[]; next: OrderbookCursor | null; delay?: number; sourceUrl?: string };
type CatalogItem = { id: string; name: string };

const storedOrder = z.object({ price: z.number().finite().nonnegative(), quantity: z.number().finite().positive(), offeredAt: z.string().datetime() });
const storedBook = z.object({
  itemCode: itemCodeSchema,
  buyOrders: z.array(storedOrder).max(ORDERBOOK_LIMIT),
  sellOrders: z.array(storedOrder).max(ORDERBOOK_LIMIT),
  coverage: z.literal(ORDERBOOK_COVERAGE),
});
const entitySchema = storedBook.extend({ _id: itemCodeSchema });

/** Fetch exactly one catalog code; the cursor stops at the end of each daily sweep. */
export async function fetchOrderbookBatch(env: Env, client: WarEraClient, cursor: OrderbookCursor = {}): Promise<OrderbookBatch> {
  if (cursor.lastItemId !== undefined) itemCodeSchema.parse(cursor.lastItemId);
  const item = await env.DB.prepare('SELECT id,name FROM market_items WHERE id>? ORDER BY id LIMIT 1')
    .bind(cursor.lastItemId ?? '').first<CatalogItem>();
  if (!item) return { records: [], next: null, delay: 86400 };
  itemCodeSchema.parse(item.id);
  const sourceUrl = client.url(ORDERBOOK_PROCEDURE, { itemCode: item.id, limit: ORDERBOOK_LIMIT });
  const upstream = await client.get(ORDERBOOK_PROCEDURE, { itemCode: item.id, limit: ORDERBOOK_LIMIT }, topOrdersSchema);
  const projected = projectTopOrders(item.id, upstream);
  return { records: [{ _id: item.id, ...projected }], next: { lastItemId: item.id }, sourceUrl };
}

export type NormalizedOrderbook = {
  table: 'orderbook_snapshots'; id: string; name: string; country_id: null;
  source_url: string; updated_at: string; data_json: string; extra: Record<string, never>;
};

/** Common entity shape for source mapping, with only the safe public projection. */
export function normalizeOrderbookEntity(input: unknown, client: WarEraClient, now: string): NormalizedOrderbook {
  const row = entitySchema.parse(input);
  if (row._id !== row.itemCode) throw new Error('Orderbook record ID mismatch');
  if (!Number.isFinite(Date.parse(now))) throw new Error('Invalid orderbook observation time');
  const book = storedBook.parse(row);
  return { table: 'orderbook_snapshots', id: row._id, name: row._id, country_id: null,
    source_url: client.url(ORDERBOOK_PROCEDURE, { itemCode: row._id, limit: ORDERBOOK_LIMIT }),
    updated_at: new Date(now).toISOString(), data_json: JSON.stringify(book), extra: {} };
}

/** One latest row per catalog item, without inferred trades or entity history. */
export async function saveOrderbookBatch(env: Env, records: unknown[], client: WarEraClient, now: string): Promise<{ changed: number; results: D1Result[] }> {
  if (records.length > 1) throw new Error('Orderbook capture exceeds one catalog item');
  if (!records.length) return { changed: 0, results: [] };
  const row = normalizeOrderbookEntity(records[0], client, now);
  const known = await env.DB.prepare('SELECT id FROM market_items WHERE id=? LIMIT 1').bind(row.id).first<{ id: string }>();
  if (!known) throw new Error('Orderbook item is absent from the observed catalog');
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(row.data_json));
  const hash = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const result = await env.DB.prepare(`INSERT INTO orderbook_snapshots(id,name,country_id,source_url,updated_at,first_seen,hash,data_json)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    name=excluded.name,country_id=excluded.country_id,source_url=excluded.source_url,
    updated_at=excluded.updated_at,hash=excluded.hash,data_json=excluded.data_json`)
    .bind(row.id,row.name,row.country_id,row.source_url,row.updated_at,row.updated_at,hash,row.data_json).run();
  return { changed: result.meta.changes ? 1 : 0, results: [result] };
}

const headers = { 'Cache-Control': 'public, max-age=90, s-maxage=120', 'X-Content-Type-Options': 'nosniff' };
const unavailable = { status: 'pending', coverage: ORDERBOOK_COVERAGE, observedAt: null, buyOrders: [], sellOrders: [] };

/** Public GET reads D1 only. It cannot turn an arbitrary item code into an upstream request. */
export async function orderbookRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/markets/orderbook') return null;
  if (request.method !== 'GET') return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'GET', 'Cache-Control': 'no-store' } });
  const params = url.searchParams.getAll('item');
  const parsed = params.length === 1 ? itemCodeSchema.safeParse(params[0]) : { success: false };
  if (!parsed.success) return Response.json({ error: 'Invalid catalog item' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  const itemCode = params[0];
  const row = await env.DB.prepare(`SELECT i.id,i.name,o.source_url,o.updated_at,o.data_json FROM market_items i
    LEFT JOIN orderbook_snapshots o ON o.id=i.id WHERE i.id=? LIMIT 1`).bind(itemCode)
    .first<{ id: string; name: string; source_url: string | null; updated_at: string | null; data_json: string | null }>();
  if (!row) return Response.json({ error: 'Unknown catalog item' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  if (!row.data_json) return Response.json({ item: { id: row.id, name: row.name }, ...unavailable }, { headers });
  let book: z.infer<typeof storedBook>;
  try { book = storedBook.parse(JSON.parse(row.data_json)); }
  catch { return Response.json({ error: 'Stored orderbook is invalid' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
  if (book.itemCode !== row.id) return Response.json({ error: 'Stored orderbook item mismatch' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  return Response.json({ item: { id: row.id, name: row.name }, status: 'ok', ...book,
    observedAt: row.updated_at, sourceUrl: row.source_url }, { headers });
}
