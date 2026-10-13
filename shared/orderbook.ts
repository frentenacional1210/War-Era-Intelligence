import { z } from 'zod';

export const ORDERBOOK_LIMIT = 5;
export const ORDERBOOK_PROCEDURE = 'tradingOrder.getTopOrders';
export const ORDERBOOK_COVERAGE = 'observed-top-five-per-side' as const;
export const itemCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);

const orderSchema = z.object({
  itemCode: itemCodeSchema,
  price: z.number().finite().nonnegative(),
  quantity: z.number().finite().positive(),
  offerAt: z.string().min(1).max(80).refine(value => Number.isFinite(Date.parse(value))),
});
const topOrdersSchema = z.object({
  buyOrders: z.array(orderSchema).max(ORDERBOOK_LIMIT),
  sellOrders: z.array(orderSchema).max(ORDERBOOK_LIMIT),
});

export type PublicOrder = { price: number; quantity: number; offeredAt: string };
export type PublicOrderbook = {
  itemCode: string;
  buyOrders: PublicOrder[];
  sellOrders: PublicOrder[];
  coverage: typeof ORDERBOOK_COVERAGE;
};

/** Never retain order IDs, owners, or unrelated upstream fields. */
export function projectTopOrders(itemCode: string, input: unknown): PublicOrderbook {
  itemCodeSchema.parse(itemCode);
  const page = topOrdersSchema.parse(input);
  const project = (rows: z.infer<typeof orderSchema>[]): PublicOrder[] => rows.map(row => {
    if (row.itemCode !== itemCode) throw new Error('Orderbook item code mismatch');
    return { price: row.price, quantity: row.quantity, offeredAt: new Date(row.offerAt).toISOString() };
  });
  return { itemCode, buyOrders: project(page.buyOrders), sellOrders: project(page.sellOrders), coverage: ORDERBOOK_COVERAGE };
}

export { topOrdersSchema };
