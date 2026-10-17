import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Empty, ErrorState, Loading, Panel, SectionTitle } from './components';
import { request } from './api';
import { useRemote } from './hooks';
import { date, safeUrl } from './utils';

type SearchResource = 'players' | 'parties' | 'military-units' | 'countries' | 'articles' | 'battles' | 'regions';
type SearchItem = { resource: SearchResource; id: string; name: string; source_url?: string | null; updated_at?: string | null };
type SearchResponse = { items: SearchItem[]; timestamp: string; query?: string };
const resources: Record<SearchResource, { label: string; base: string; detail: boolean }> = {
  players: { label: 'Jugador', base: '/jugadores', detail: true },
  parties: { label: 'Partido', base: '/partidos', detail: true },
  'military-units': { label: 'Unidad militar', base: '/unidades', detail: true },
  countries: { label: 'País', base: '/paises', detail: true },
  articles: { label: 'Artículo', base: '/articulos', detail: true },
  battles: { label: 'Batalla', base: '/batallas', detail: true },
  regions: { label: 'Región', base: '/mundo', detail: false },
};
const bytes = (value: string) => new TextEncoder().encode(value).length;
const pattern = (value: string) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
const limited = (value: string) => Array.from(value).reduce((result, character) => {
  const candidate = result + character;
  return bytes(candidate) <= 40 && bytes(pattern(candidate)) <= 48 ? candidate : result;
}, '');

export function GlobalSearchPage() {
  // A search started elsewhere (e.g. the home page) arrives as ?q=.
  const initial = (new URLSearchParams(window.location.search).get('q') ?? '').slice(0, 40);
  const [input, setInput] = useState(initial);
  const [query, setQuery] = useState(initial);
  useEffect(() => { const timer = window.setTimeout(() => setQuery(input.trim()), 300); return () => window.clearTimeout(timer); }, [input]);
  const ready = query.length >= 2;
  const result = useRemote(() => ready ? request<SearchResponse>(`/api/search?${new URLSearchParams({ q: query, limit: '30' })}`).then(data => ({ ...data, query })) : Promise.resolve({ items: [], timestamp: '', query: '' }), `global-search:${ready ? query : ''}`, 0);
  const pending = input.trim() !== query;
  const current = result.data?.query === query;
  return <><SectionTitle eyebrow="EXPLORAR" title="Búsqueda global" description="Busca entre jugadores, partidos, unidades, países, artículos, batallas y regiones capturadas." />
    <Panel title="Buscar registros"><div className="global-search-controls"><label htmlFor="global-search-input">Nombre o término</label><input id="global-search-input" type="search" autoComplete="off" value={input} onChange={event => setInput(limited(event.target.value))} placeholder="Escribe para buscar…" /><small>Se muestran hasta 30 coincidencias públicas. Las fichas conservan su fecha y fuente original.</small></div>
      {!ready && !pending ? <Empty title="Escribe una búsqueda" detail="Introduce más texto para ver coincidencias." /> : pending || result.loading ? <Loading label="Buscando registros…" /> : result.error ? <ErrorState error={result.error} onRetry={result.reload} /> : !current ? <Loading label="Buscando registros…" /> : result.data?.items.length ? <><ul className="global-search-results">{result.data.items.map(item => { const config = resources[item.resource]; if (!config) return null; const href = config.detail ? `${config.base}/${encodeURIComponent(item.id)}` : config.base; const external = safeUrl(item.source_url); return <li key={`${item.resource}:${item.id}`}><Link to={href} className="global-search-result-main"><span className="global-search-kind">{config.label}</span><strong>{item.name}</strong><small>{config.detail ? `ID ${item.id}` : 'Abrir vista de mundo'}</small></Link><div className="global-search-provenance"><time dateTime={item.updated_at ?? undefined}>{date(item.updated_at)}</time>{external && <a href={external} target="_blank" rel="noopener noreferrer">Fuente original ↗</a>}</div></li>; })}</ul><p className="global-search-note">Resultados consultados: {date(result.data.timestamp)}. Se muestran como máximo 30 coincidencias.</p></> : <Empty title="Sin coincidencias" detail="Prueba otro nombre o una palabra más corta." />}
    </Panel>
  </>;
}
