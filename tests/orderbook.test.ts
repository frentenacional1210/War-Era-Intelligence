import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDB } from './sqlite-d1';
import { projectTopOrders } from '../shared/orderbook';
import { fetchOrderbookBatch, normalizeOrderbookEntity, orderbookRoute, saveOrderbookBatch } from '../worker/orderbook';
import { WarEraClient } from '../worker/warera';
import type { Env } from '../worker/types';

afterEach(() => vi.unstubAllGlobals());
const at = '2026-10-12T12:00:00.000Z';
const order = (itemCode: string, price: number) => ({ _id: 'internal-order', user: 'private-owner', itemCode,
  price, quantity: 12, offerAt: at, type: 'buy', __v: 1, contact: 'discard' });
const upstream = (itemCode: string, price = 6) => ({ buyOrders: [order(itemCode, price)], sellOrders: [order(itemCode, price + 2)] });
const setup = () => {
  const store = createTestDB();
  store.sqlite.exec(`INSERT INTO market_items(id,name,source_url,updated_at,first_seen,hash,data_json) VALUES
    ('iron','Iron','https://example.test','2026-01-01','2026-01-01','a','{}'),
    ('steel','Steel','https://example.test','2026-01-01','2026-01-01','b','{}')`);
  return { ...store, env: { DB: store.db } as Env };
};

describe('bounded public top of book', () => {
  it('projects only price, quantity, and offer time, and rejects wrong items or excessive pages', () => {
    const book = projectTopOrders('steel', upstream('steel'));
    expect(book.buyOrders).toEqual([{ price: 6, quantity: 12, offeredAt: at }]);
    expect(JSON.stringify(book)).not.toMatch(/private-owner|internal-order|contact|__v/);
    expect(() => projectTopOrders('steel', upstream('iron'))).toThrow(/mismatch/);
    expect(() => projectTopOrders('steel', { buyOrders: Array.from({ length: 6 }, () => order('steel', 2)), sellOrders: [] })).toThrow();
    expect(() => projectTopOrders('steel', { buyOrders: [{ ...order('steel', 2), quantity: -1 }], sellOrders: [] })).toThrow();
  });

  it('collects one catalog item per tick with fixed limit five, then ends the sweep', async () => {
    const store = setup();
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toContain('tradingOrder.getTopOrders');
      const params = JSON.parse(url.searchParams.get('input')!) as { itemCode: string; limit: number };
      expect(params.limit).toBe(5);
      calls.push(params.itemCode);
      return Response.json({ result: { data: upstream(params.itemCode) } });
    }) as typeof fetch;
    const client = new WarEraClient(undefined, undefined, fetcher);
    try {
      const first = await fetchOrderbookBatch(store.env, client);
      const second = await fetchOrderbookBatch(store.env, client, first.next!);
      const done = await fetchOrderbookBatch(store.env, client, second.next!);
      expect(calls).toEqual(['iron', 'steel']);
      expect(first).toMatchObject({ next: { lastItemId: 'iron' }, records: [{ _id: 'iron' }] });
      expect(second).toMatchObject({ next: { lastItemId: 'steel' }, records: [{ _id: 'steel' }] });
      expect(done).toMatchObject({ records: [], next: null, delay: 86400 });
      expect(JSON.stringify(first.records)).not.toContain('private-owner');
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { store.sqlite.close(); }
  });

  it('stores only the latest capture and serves catalog-validated D1 results without upstream requests', async () => {
    const store = setup();
    const client = new WarEraClient();
    const noNetwork = vi.fn(() => { throw new Error('Public route must not fetch WarEra'); });
    vi.stubGlobal('fetch', noNetwork);
    const page = { _id: 'steel', ...projectTopOrders('steel', upstream('steel')) };
    try {
      expect(store.sqlite.prepare("SELECT enabled FROM source_registry WHERE id='orderbooks'").get()?.enabled).toBe(1);
      const pending = await orderbookRoute(new Request('https://wint.test/api/markets/orderbook?item=steel'), store.env);
      expect(await pending!.json()).toMatchObject({ status: 'pending', observedAt: null, buyOrders: [] });
      expect(await saveOrderbookBatch(store.env, [page], client, at)).toMatchObject({ changed: 1 });
      expect(await saveOrderbookBatch(store.env, [{ _id: 'steel', ...projectTopOrders('steel', upstream('steel', 7)) }], client, '2026-10-13T12:00:00.000Z')).toMatchObject({ changed: 1 });
      const response = await orderbookRoute(new Request('https://wint.test/api/markets/orderbook?item=steel'), store.env);
      expect(response?.status).toBe(200);
      expect(response?.headers.get('Cache-Control')).toContain('s-maxage=120');
      const body = await response!.json();
      expect(body).toMatchObject({ item: { id: 'steel', name: 'Steel' }, status: 'ok', observedAt: '2026-10-13T12:00:00.000Z',
        buyOrders: [{ price: 7, quantity: 12 }] });
      expect(JSON.stringify(body)).not.toMatch(/private-owner|internal-order|contact|__v/);
      expect(store.sqlite.prepare("SELECT COUNT(*) count FROM orderbook_snapshots").get()?.count).toBe(1);
      expect(store.sqlite.prepare("SELECT COUNT(*) count FROM entity_snapshots WHERE entity_type='orderbooks'").get()?.count).toBe(0);
      expect(store.sqlite.prepare("SELECT record_count FROM source_registry WHERE id='orderbooks'").get()?.record_count).toBe(1);
      expect(noNetwork).not.toHaveBeenCalled();
    } finally { store.sqlite.close(); }
  });

  it('rejects arbitrary or unknown codes and refuses a mismatched capture before writing', async () => {
    const store = setup();
    const client = new WarEraClient();
    try {
      const malformed = await orderbookRoute(new Request('https://wint.test/api/markets/orderbook?item=../steel'), store.env);
      const unknown = await orderbookRoute(new Request('https://wint.test/api/markets/orderbook?item=unknown'), store.env);
      expect(malformed?.status).toBe(400);
      expect(unknown?.status).toBe(404);
      expect(() => normalizeOrderbookEntity({ _id: 'iron', ...projectTopOrders('steel', upstream('steel')) }, client, at)).toThrow(/mismatch/);
      await expect(saveOrderbookBatch(store.env, [{ _id: 'unknown', ...projectTopOrders('unknown', upstream('unknown')) }], client, at)).rejects.toThrow(/catalog/);
      expect(store.sqlite.prepare('SELECT COUNT(*) count FROM orderbook_snapshots').get()?.count).toBe(0);
    } finally { store.sqlite.close(); }
  });
});
