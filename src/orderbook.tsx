import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { PublicOrder } from '../shared/orderbook';
import { request } from './api';
import { Badge, Empty, ErrorState, Loading, Pagination, Panel, SectionTitle } from './components';
import { useRemote } from './hooks';
import { date, number, safeUrl } from './utils';
import type { Collection } from './types';

type Item = { id: string; name: string };
type Book = { item: Item; status: 'pending' | 'ok'; coverage: string; observedAt: string | null; sourceUrl?: string | null; buyOrders: PublicOrder[]; sellOrders: PublicOrder[] };
const bytes40 = (value: string) => Array.from(value).reduce((text, character) => {
  const next = text + character, encoder = new TextEncoder();
  return encoder.encode(next).length <= 40 ? next : text;
}, '');

function OrderRows({ rows, side }: { rows: PublicOrder[]; side: 'buy' | 'sell' }) {
  return <section className="orderbook-side"><h3>{side === 'buy' ? 'Órdenes de compra' : 'Órdenes de venta'} <small>({number(rows.length)} observadas)</small></h3>{rows.length ? <div className="orderbook-table-wrap"><table className="orderbook-table"><thead><tr><th scope="col">Precio indicado</th><th scope="col">Cantidad indicada</th><th scope="col">Oferta fechada</th></tr></thead><tbody>{rows.map((row, index) => <tr key={`${row.price}:${row.quantity}:${row.offeredAt}:${index}`}><td>{number(row.price, 4)}</td><td>{number(row.quantity, 2)}</td><td>{date(row.offeredAt)}</td></tr>)}</tbody></table></div> : <Empty title="Sin órdenes en esta muestra" detail="La fuente no devolvió órdenes entre las primeras posiciones capturadas de este lado." />}</section>;
}

export function OrderbookPanel({ itemId }: { itemId?: string }) {
  const remote = useRemote(() => itemId ? request<Book>(`/api/markets/orderbook?${new URLSearchParams({ item: itemId })}`) : Promise.resolve(null), `orderbook:${itemId ?? ''}`, 90_000);
  const book = remote.data?.item.id === itemId ? remote.data : null;
  return <Panel title="Libro de órdenes observado" action={book?.status === 'ok' ? <Badge tone="good">Muestra disponible</Badge> : <Badge tone="muted">Sin captura aún</Badge>}>
    {!itemId ? <Empty title="Elige un producto" detail="Selecciona un producto del catálogo para consultar sus órdenes observadas." /> : !book && !remote.error ? <Loading label="Consultando órdenes…" /> : remote.error ? <ErrorState error={remote.error} onRetry={remote.reload} /> : book?.status === 'pending' ? <Empty title="Captura pendiente" detail="Este producto está en el catálogo, pero aún no se ha guardado una muestra de sus órdenes." /> : book ? <><div className="orderbook-provenance"><strong>{book.item.name}</strong><span>Captura del libro: {date(book.observedAt)}</span>{safeUrl(book.sourceUrl) && <a href={safeUrl(book.sourceUrl)!} target="_blank" rel="noopener noreferrer">Fuente original ↗</a>}</div><p className="orderbook-caveat">Se muestran {book.coverage === 'observed-top-five-per-side' ? 'como máximo cinco órdenes por lado' : 'solo las órdenes de la muestra disponible'} según la respuesta de la fuente en esta captura. No representa todo el mercado, liquidez total, ventas realizadas ni disponibilidad futura. Las cantidades y precios son ofertas observadas.</p><div className="orderbook-sides"><OrderRows rows={book.buyOrders} side="buy" /><OrderRows rows={book.sellOrders} side="sell" /></div></> : null}
  </Panel>;
}

export function OrderbookPage() {
  const [params, setParams] = useSearchParams();
  const itemId = params.get('item') ?? '';
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => { const timer = window.setTimeout(() => { setQuery(draft.trim()); setPage(1); }, 300); return () => window.clearTimeout(timer); }, [draft]);
  const catalog = useRemote(() => request<Collection>(`/api/markets/prices?${new URLSearchParams({ q: query, page: String(page), limit: '20', sort: 'name', order: 'asc' })}`).then(result => ({ ...result, query, requestedPage: page })), `orderbook:catalog:${query}:${page}`, 0);
  const current = catalog.data?.query === query && catalog.data.requestedPage === page ? catalog.data : null;
  return <><SectionTitle eyebrow="MERCADOS" title="Libro de órdenes" description="Muestras públicas de las primeras órdenes de compra y venta por producto." action={<Link className="btn" to="/mercados">Ver precios globales</Link>} />
    <p className="orderbook-page-caveat">Las órdenes no son transacciones. La ausencia de una muestra indica que WINT aún no ha capturado ese producto; no significa que no haya mercado.</p>
    <Panel title="Elegir producto"><div className="orderbook-finder"><label className="form-field"><span>Buscar producto</span><input type="search" value={draft} onChange={event => setDraft(bytes40(event.target.value))} placeholder="Nombre del producto…" /></label><p>{itemId ? `Producto seleccionado: ID ${itemId}` : 'Selecciona un producto con cotización capturada.'}</p>{draft.trim() !== query || !current && !catalog.error ? <Loading label="Buscando productos…" /> : catalog.error ? <ErrorState error={catalog.error} onRetry={catalog.reload} /> : current?.items.length ? <><div className="orderbook-choices">{current.items.map(row => { const id = String(row.id ?? ''); return <button type="button" key={id} className={itemId === id ? 'active' : ''} onClick={() => setParams({ item: id })}><strong>{String(row.name ?? id)}</strong><small>Precio global observado: {number(row.price, 4)} · ID {id}</small></button>; })}</div>{current.total > 20 && <Pagination page={page} total={current.total} limit={20} onPage={setPage} />}</> : <Empty title="Sin productos coincidentes" detail="Prueba otro nombre o consulta el catálogo más adelante." />}</div></Panel>
    <div className="section-gap"><OrderbookPanel itemId={itemId} /></div>
  </>;
}
