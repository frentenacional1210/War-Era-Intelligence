import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { HistoryPeriod, HistorySeries } from '../shared/history';
import { request } from './api';
import { Badge, Empty, ErrorState, Loading, Pagination, Panel, SectionTitle } from './components';
import { useRemote } from './hooks';
import type { Collection, Row } from './types';
import { date, displayName, normalizedData, number, safeUrl } from './utils';

type Politics = {
  government: unknown | null;
  elections: unknown[];
  parties: unknown[];
  completeness: { elections: string; parties: string };
};
type Layer = 'territory' | 'politics' | 'military';
const periods: { value: HistoryPeriod; label: string }[] = [
  { value: '7d', label: '7 días' }, { value: '30d', label: '30 días' },
  { value: '90d', label: '90 días' }, { value: '1y', label: '1 año' },
  { value: '2y', label: '2 años' },
];
const idOf = (row: Row) => String(row.id ?? '');
const observation = (value: unknown) => typeof value === 'string' && value ? value : null;

async function loadCountries(): Promise<{ items: Row[]; total: number; limited: boolean }> {
  const first = await request<Collection>('/api/countries?limit=50&page=1&sort=name');
  const rest = await Promise.all(Array.from({ length: 3 }, (_, index) =>
    request<Collection>(`/api/countries?limit=50&page=${index + 2}&sort=name`)));
  return { items: [first, ...rest].flatMap(page => page.items), total: first.total, limited: first.total > 200 };
}

function OriginalSource({ url, updated }: { url?: unknown; updated?: unknown }) {
  const safe = safeUrl(url);
  return <span className="world-source">Captura: {date(updated)}{safe && <> · <a href={safe} target="_blank" rel="noopener noreferrer">Fuente original ↗</a></>}</span>;
}

function RegionHistory({ id }: { id: string }) {
  const [period, setPeriod] = useState<HistoryPeriod>('30d');
  const remote = useRemote(() => request<HistorySeries>(`/api/history?${new URLSearchParams({ resource: 'regions', id, period })}`), `world-history:${id}:${period}`, 0);
  const series = remote.data;
  return <Panel title="Control observado de la región" className="section-gap">
    <div className="world-history-controls"><label className="form-field"><span>Periodo de esta región</span><select value={period} onChange={event => setPeriod(event.target.value as HistoryPeriod)}>{periods.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><Link to={`/regiones/${encodeURIComponent(id)}`}>Abrir ficha de la región</Link></div>
    <p className="world-explanation">Cada fila procede de una captura de esta región. Los periodos sin observaciones son desconocidos; esta serie no reconstruye el control de otros territorios ni un mapa mundial anterior.</p>
    {remote.loading && !series ? <Loading label="Consultando capturas…" /> : remote.error ? <ErrorState error={remote.error} onRetry={remote.reload} /> : series ? <>
      <div className="world-history-meta"><span>{number(series.points.length)} observaciones agrupadas · {number(series.gaps.length)} huecos · Primera captura: {series.baseline ? date(series.baseline.observed_at) : 'sin dato'}</span>{series.archive_pending && <Badge tone="warn">Archivo histórico pendiente</Badge>}{series.truncated && <Badge tone="warn">Serie limitada</Badge>}</div>
      {series.points.length ? <div className="world-history-table-wrap"><table className="world-history-table"><thead><tr><th scope="col">Captura</th><th scope="col">País observado</th><th scope="col">País inicial registrado</th><th scope="col">Capital</th><th scope="col">Capturas en el intervalo</th></tr></thead><tbody>{series.points.map((point, index) => <tr key={`${point.observed_at}:${index}`}><th scope="row">{date(point.observed_at)}</th><td>{observation(point.metrics.country_id) ? <Link to={`/paises/${encodeURIComponent(String(point.metrics.country_id))}`}>ID {String(point.metrics.country_id)}</Link> : 'Sin dato'}</td><td>{observation(point.metrics.initial_country_id) ? <Link to={`/paises/${encodeURIComponent(String(point.metrics.initial_country_id))}`}>ID {String(point.metrics.initial_country_id)}</Link> : 'Sin dato'}</td><td>{point.metrics.is_capital === true ? 'Sí' : point.metrics.is_capital === false ? 'No' : 'Sin dato'}</td><td>{number(point.observations)}</td></tr>)}</tbody></table></div> : <Empty title="Sin capturas en este periodo" detail="No se puede deducir el control de la región durante el intervalo seleccionado." />}
      {series.gaps.length > 0 && <details className="world-history-gaps"><summary>Ver intervalos sin observaciones ({series.gaps.length})</summary><ul>{series.gaps.map((gap, index) => <li key={`${gap.from}:${index}`}>{date(gap.from)} → {date(gap.to)} · {gap.reason === 'before-first-capture' ? 'Antes de la primera captura' : gap.reason === 'archive-pending' ? 'Archivo pendiente' : 'Sin observación'}</li>)}</ul></details>}
      <p className="world-explanation">En periodos largos se muestra la última observación disponible por intervalo, sin interpolar los huecos. Una fecha observada no demuestra cuándo comenzó o terminó el control.</p>
    </> : null}
  </Panel>;
}

export function WorldExplorerPage() {
  const [params, setParams] = useSearchParams();
  const countryId = params.get('country') ?? '';
  const regionId = params.get('region') ?? '';
  const [countrySearch, setCountrySearch] = useState('');
  const [page, setPage] = useState(1);
  const [layer, setLayer] = useState<Layer>('territory');
  const countries = useRemote(loadCountries, 'world:countries:v1', 0);
  const regions = useRemote(() => countryId ? request<Collection>(`/api/regions?${new URLSearchParams({ country: countryId, limit: '50', page: String(page), sort: 'name' })}`) : Promise.resolve(null), `world:regions:${countryId}:${page}`, 0);
  const politics = useRemote(() => countryId && layer === 'politics' ? request<Politics>(`/api/politics?${new URLSearchParams({ country: countryId })}`) : Promise.resolve(null), `world:politics:${countryId}:${layer}`, 0);
  const units = useRemote(() => countryId && layer === 'military' ? request<Collection>(`/api/military-units?${new URLSearchParams({ country: countryId, limit: '5', page: '1' })}`) : Promise.resolve(null), `world:military:${countryId}:${layer}`, 0);
  const selectedCountry = countries.data?.items.find(row => idOf(row) === countryId);
  const selectedRegion = regions.data?.items.find(row => idOf(row) === regionId);
  const visibleCountries = useMemo(() => (countries.data?.items ?? []).filter(row =>
    `${displayName(row)} ${idOf(row)}`.toLocaleLowerCase().includes(countrySearch.trim().toLocaleLowerCase())), [countries.data, countrySearch]);
  const selectCountry = (id: string) => { setPage(1); setLayer('territory'); setParams(id ? { country: id } : {}); };
  const selectRegion = (id: string) => setParams(current => { const next = new URLSearchParams(current); next.set('region', id); return next; });
  return <>
    <SectionTitle eyebrow="MUNDO OBSERVADO" title="Mundo WarEra" description="Explora países, regiones y relaciones públicas a partir de registros capturados." />
    <p className="world-caveat"><strong>Vista esquemática.</strong> La posición y el orden de las tarjetas no representan coordenadas, fronteras, distancias ni extensión territorial. Solo mostramos países y regiones identificados por la fuente.</p>
    <Panel title="Países registrados">
      {countries.loading && !countries.data ? <Loading label="Cargando países…" /> : countries.error ? <ErrorState error={countries.error} onRetry={countries.reload} /> : countries.data?.items.length ? <>
        <div className="world-country-controls"><label className="form-field"><span>País</span><select value={countryId} onChange={event => selectCountry(event.target.value)}><option value="">Elige un país</option>{countries.data.items.map(row => <option key={idOf(row)} value={idOf(row)}>{displayName(row)}</option>)}</select></label><label className="form-field"><span>Filtrar países de la cuadrícula</span><input type="search" value={countrySearch} onChange={event => setCountrySearch(event.target.value)} placeholder="Nombre o ID" /></label></div>
        <p className="world-count">{number(countries.data.items.length)} países cargados de {number(countries.data.total)} registros capturados. {countries.data.limited && 'La lista está limitada a 200; usa el directorio para los demás.'} <Link to="/paises">Abrir directorio de países</Link></p>
        <div className="world-country-grid" aria-label="Cuadrícula esquemática de países">{visibleCountries.map(row => <button type="button" key={idOf(row)} className={countryId === idOf(row) ? 'world-country-tile active' : 'world-country-tile'} onClick={() => selectCountry(idOf(row))}><strong>{displayName(row)}</strong><small>ID {idOf(row)}{typeof normalizedData(row).code === 'string' ? ` · ${normalizedData(row).code}` : ''}</small></button>)}</div>
        {!visibleCountries.length && <Empty title="Sin países coincidentes" detail="Prueba otra búsqueda dentro de los países capturados." />}
      </> : <Empty title="Sin países capturados" detail="La vista aparecerá cuando se registren países de la fuente pública." />}
    </Panel>
    {countryId && <div className="section-gap"><Panel title={selectedCountry ? displayName(selectedCountry) : `País ${countryId}`} action={<Link to={`/paises/${encodeURIComponent(countryId)}`}>Ficha del país ↗</Link>}>
      <div className="world-country-meta"><span>País observado: ID {countryId}</span>{selectedCountry && <OriginalSource url={selectedCountry.source_url} updated={selectedCountry.updated_at} />}</div>
      <div className="world-layer-controls" role="group" aria-label="Capas de información"><button type="button" className={layer === 'territory' ? 'active' : ''} aria-pressed={layer === 'territory'} onClick={() => setLayer('territory')}>Territorio</button><button type="button" className={layer === 'politics' ? 'active' : ''} aria-pressed={layer === 'politics'} onClick={() => setLayer('politics')}>Política</button><button type="button" className={layer === 'military' ? 'active' : ''} aria-pressed={layer === 'military'} onClick={() => setLayer('military')}>Unidades</button></div>
      {layer === 'territory' && <><p className="world-explanation">Regiones cuya última ficha capturada indica este país. La lista está paginada; no presupone que cubra todas las regiones del juego.</p>{regions.loading && !regions.data ? <Loading label="Cargando regiones…" /> : regions.error ? <ErrorState error={regions.error} onRetry={regions.reload} /> : regions.data ? <><p className="world-count">{number(regions.data.total)} regiones capturadas con este país en su ficha actual · página {number(page)}.</p>{regions.data.items.length ? <div className="world-region-grid" aria-label="Cuadrícula esquemática de regiones">{regions.data.items.map(row => { const data = normalizedData(row), id = idOf(row); return <article key={id} className={regionId === id ? 'world-region-tile active' : 'world-region-tile'}><button type="button" onClick={() => selectRegion(id)} aria-pressed={regionId === id}><strong>{displayName(row)}</strong><small>ID {id}{data.isCapital === true ? ' · Capital registrada' : ''}</small></button><div><span>País actual: {row.country_id ? `ID ${row.country_id}` : 'Sin dato'}</span>{typeof data.initialCountry === 'string' && data.initialCountry && <span>País inicial: ID {data.initialCountry}</span>}<OriginalSource url={row.source_url} updated={row.updated_at} /><Link to={`/regiones/${encodeURIComponent(id)}`}>Ficha de la región ↗</Link></div></article>; })}</div> : <Empty title="Sin regiones capturadas" detail="Todavía no hay fichas de regiones asignadas a este país." />}{regions.data.total > 50 && <Pagination page={page} total={regions.data.total} limit={50} onPage={next => { setPage(next); setParams({ country: countryId }); }} />}</> : null}</>}
      {layer === 'politics' && <>{politics.loading && !politics.data ? <Loading label="Consultando registros políticos…" /> : politics.error ? <ErrorState error={politics.error} onRetry={politics.reload} /> : politics.data ? <div className="world-layer-summary"><div><strong>{politics.data.government ? 'Gobierno observado' : 'Sin gobierno capturado'}</strong><span>{politics.data.government ? 'Existe una ficha de gobierno en la última consulta.' : 'La ausencia de ficha no demuestra que no exista gobierno.'}</span></div><div><strong>{number(politics.data.elections.length)} elecciones observadas</strong><span>{politics.data.completeness.elections === 'limited-to-40' ? 'Lista limitada a 40 capturas.' : 'Solo registros capturados.'}</span></div><div><strong>{number(politics.data.parties.length)} partidos observados</strong><span>{politics.data.completeness.parties === 'limited-to-40' ? 'Lista limitada a 40 registros.' : 'Solo registros capturados.'}</span></div><Link to={`/politica?country=${encodeURIComponent(countryId)}`}>Ver cargos, candidaturas y fuentes ↗</Link></div> : null}</>}
      {layer === 'military' && <>{units.loading && !units.data ? <Loading label="Consultando unidades…" /> : units.error ? <ErrorState error={units.error} onRetry={units.reload} /> : units.data ? <div className="world-layer-summary"><div><strong>{number(units.data.total)} unidades capturadas</strong><span>Fichas cuya relación de país indica ID {countryId}. No equivale a efectivos ni capacidad de combate.</span></div>{units.data.items.map(row => <div key={idOf(row)}><Link to={`/unidades/${encodeURIComponent(idOf(row))}`}>{displayName(row)}</Link><OriginalSource url={row.source_url} updated={row.updated_at} /></div>)}<Link to="/militar">Explorar y comparar unidades ↗</Link></div> : null}</>}
    </Panel>{regionId && <div className="world-selected-region"><p>Región seleccionada: <strong>{selectedRegion ? displayName(selectedRegion) : `ID ${regionId}`}</strong>. Su historial corresponde solo a esta región.</p><RegionHistory key={regionId} id={regionId} /></div>}</div>}
  </>;
}
