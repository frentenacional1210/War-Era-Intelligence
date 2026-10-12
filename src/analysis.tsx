import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { request } from './api';
import { Empty, ErrorState, Loading, Panel, SectionTitle, SourceMeta } from './components';
import { useRemote } from './hooks';
import { date, number, safeUrl } from './utils';
import type { Collection, Source } from './types';
import { ANALYSIS_METRICS, type AnalysisResource, type MetricChange, type MetricKey, type MetricValues, type Observation } from '../shared/analysis';

type Compared = { id: string; name: string; country_id?: string | null; source_url?: string; updated_at?: string; metrics: MetricValues };
type Comparison = { resource: AnalysisResource; items: Compared[]; source: Source | null };
type History = { item: { id: string; name: string; source_url?: string; updated_at?: string }; observations: Observation[]; observation_count: number; changes: Partial<Record<MetricKey, MetricChange>>; source: Source | null };
const labels: Record<AnalysisResource, string> = { players: 'Jugadores', parties: 'Partidos', 'military-units': 'Unidades militares' };
const paths: Record<AnalysisResource, string> = { players: '/jugadores', parties: '/partidos', 'military-units': '/unidades' };

export function AnalysisPage() {
  const [resource, setResource] = useState<AnalysisResource>('players');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => { const timer = window.setTimeout(() => setQuery(search), 300); return () => window.clearTimeout(timer); }, [search]);
  const [selected, setSelected] = useState<{ id: string; name: string }[]>([]);
  const [submitted, setSubmitted] = useState<{ resource: AnalysisResource; ids: string[] } | null>(null);
  const [historyId, setHistoryId] = useState('');
  const [metric, setMetric] = useState<MetricKey>('level');
  const candidates = useRemote(() => request<Collection>(`/api/${resource}?${new URLSearchParams({ q: query, limit: '20', page: String(page), sort: 'name' })}`), `analysis-candidates:${resource}:${query}:${page}`, 0);
  const comparison = useRemote(() => submitted ? request<Comparison>(`/api/analysis/compare?${new URLSearchParams({ resource: submitted.resource, ids: submitted.ids.join(',') })}`) : Promise.resolve(null), `analysis-compare:${JSON.stringify(submitted)}`, 0);
  const history = useRemote(() => submitted && historyId ? request<History>(`/api/analysis/history?${new URLSearchParams({ resource: submitted.resource, id: historyId })}`) : Promise.resolve(null), `analysis-history:${submitted?.resource}:${historyId}`, 0);
  const selectedMetric = ANALYSIS_METRICS[submitted?.resource ?? resource].some(item => item.key === metric) ? metric : ANALYSIS_METRICS[submitted?.resource ?? resource][0].key;
  const switchResource = (next: AnalysisResource) => { setResource(next); setSearch(''); setQuery(''); setPage(1); setSelected([]); setSubmitted(null); setHistoryId(''); setMetric(ANALYSIS_METRICS[next][0].key); };
  const submit = (event: FormEvent) => { event.preventDefault(); if (selected.length < 2) return; const next = { resource, ids: selected.map(item => item.id) }; setSubmitted(next); setHistoryId(next.ids[0]); };
  const items = candidates.data?.items ?? [];
  const chart = history.data?.observations.map(point => ({ at: point.captured_at, value: point.metrics[selectedMetric] ?? null })) ?? [];
  const change = history.data?.changes[selectedMetric];
  const sourceLink = (url?: string) => { const safe = safeUrl(url); return safe ? <a href={safe} target="_blank" rel="noopener noreferrer">Fuente original ↗</a> : null; };
  return <>
    <SectionTitle eyebrow="ANÁLISIS" title="Comparar e historial" description="Compara registros públicos capturados y consulta cómo han cambiado con el tiempo." />
    <Panel title="Elegir registros">
      <form onSubmit={submit} className="analysis-form">
        <label className="form-field"><span>Tipo de registro</span><select value={resource} onChange={event => switchResource(event.target.value as AnalysisResource)}>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="form-field"><span>Buscar por nombre</span><input value={search} onChange={event => { setSearch(Array.from(event.target.value).reduce((text, char) => new TextEncoder().encode(text + char).length <= 40 ? text + char : text, '')); setPage(1); }} placeholder={`Buscar ${labels[resource].toLowerCase()}…`} /></label>
        <div className="analysis-options" aria-label="Resultados de búsqueda">
          {search !== query || candidates.loading ? <Loading label="Buscando registros…" /> : candidates.error ? <ErrorState error={candidates.error} onRetry={candidates.reload} /> : items.length ? items.map(row => {
            const id = String(row.id ?? ''), active = selected.some(item => item.id === id);
            return <button type="button" key={id} className={`analysis-option ${active ? 'active' : ''}`} disabled={!active && selected.length >= 4} onClick={() => setSelected(current => active ? current.filter(item => item.id !== id) : [...current, { id, name: String(row.name ?? id) }])} aria-pressed={active}><span><strong>{String(row.name ?? id)}</strong><small>ID {id}</small></span><span>{active ? '✓ Seleccionado' : 'Añadir'}</span></button>;
          }) : <Empty title="Sin resultados" detail="Prueba otra búsqueda o consulta más adelante." />}
        </div>
        {search === query && candidates.data && candidates.data.total > 20 && <div className="analysis-pagination"><span>Página {page} de {Math.ceil(candidates.data.total / 20)}</span><button type="button" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Anterior</button><button type="button" disabled={page >= Math.ceil(candidates.data.total / 20)} onClick={() => setPage(value => value + 1)}>Siguiente</button></div>}
        <div className="analysis-selected"><span>Seleccionados ({selected.length}/4)</span><div>{selected.map(item => <button type="button" key={item.id} onClick={() => setSelected(current => current.filter(value => value.id !== item.id))} aria-label={`Quitar ${item.name}`}>{item.name} ×</button>)}</div></div>
        <button className="btn primary" disabled={selected.length < 2 || selected.length > 4}>Comparar registros</button>
      </form>
    </Panel>
    {submitted && <div className="section-gap"><Panel title={`Comparación de ${labels[submitted.resource].toLowerCase()}`} action={<SourceMeta source={comparison.data?.source} />}>{comparison.loading && !comparison.data ? <Loading /> : comparison.error ? <ErrorState error={comparison.error} onRetry={comparison.reload} /> : comparison.data ? <><div className="analysis-table-wrap"><table className="analysis-table"><thead><tr><th scope="col">Medida</th>{comparison.data.items.map(item => <th scope="col" key={item.id}><Link to={`${paths[submitted.resource]}/${encodeURIComponent(item.id)}`}>{item.name}</Link><small>ID {item.id}</small></th>)}</tr></thead><tbody>{ANALYSIS_METRICS[submitted.resource].map(field => <tr key={field.key}><th scope="row">{field.label}</th>{comparison.data!.items.map(item => <td key={item.id}>{number(item.metrics[field.key])}</td>)}</tr>)}<tr><th scope="row">Última actualización</th>{comparison.data.items.map(item => <td key={item.id}>{date(item.updated_at)}</td>)}</tr><tr><th scope="row">Procedencia</th>{comparison.data.items.map(item => <td key={item.id}>{sourceLink(item.source_url) ?? 'Sin enlace'}</td>)}</tr></tbody></table></div><p className="analysis-note">Las cifras corresponden a la última captura disponible de cada registro. Una raya indica que no se observó ese dato.</p></> : null}</Panel>
      {comparison.data && <Panel title="Evolución observada" className="section-gap"><div className="analysis-history-controls"><label className="form-field"><span>Registro</span><select value={historyId} onChange={event => setHistoryId(event.target.value)}>{comparison.data.items.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label className="form-field"><span>Medida</span><select value={selectedMetric} onChange={event => setMetric(event.target.value as MetricKey)}>{ANALYSIS_METRICS[submitted.resource].map(field => <option value={field.key} key={field.key}>{field.label}</option>)}</select></label></div>{history.loading && !history.data ? <Loading /> : history.error ? <ErrorState error={history.error} onRetry={history.reload} /> : history.data ? <><div className="analysis-history-summary"><strong>{number(history.data.observation_count)} capturas registradas</strong><span>{change && change.observations >= 2 ? `Cambio observado: ${change.delta! >= 0 ? '+' : ''}${number(change.delta)}${change.percent === null ? '' : ` (${change.percent >= 0 ? '+' : ''}${number(change.percent, 1)} %)`}` : 'Se necesitan dos capturas con esta medida para calcular el cambio.'}</span></div>{chart.length ? <><div className="analysis-chart" role="img" aria-label={`Evolución de ${selectedMetric} en ${history.data.item.name}`}><ResponsiveContainer width="100%" height="100%"><LineChart data={chart} margin={{ top: 12, right: 22, bottom: 12, left: 0 }}><CartesianGrid stroke="#263a43" strokeDasharray="3 3" /><XAxis dataKey="at" tickFormatter={value => date(value).split(',')[0]} tick={{ fill: '#91a6b0', fontSize: 10 }} minTickGap={24} /><YAxis tick={{ fill: '#91a6b0', fontSize: 10 }} width={52} domain={['auto', 'auto']} /><Tooltip labelFormatter={value => date(value)} formatter={value => [number(value), ANALYSIS_METRICS[submitted.resource].find(field => field.key === selectedMetric)?.label ?? selectedMetric]} contentStyle={{ background: '#13232d', border: '1px solid #34515a', color: '#e8f2f3' }} /><Line type="linear" dataKey="value" stroke="#55d2bf" strokeWidth={2} connectNulls={false} dot={{ r: 3 }} activeDot={{ r: 5 }} /></LineChart></ResponsiveContainer></div><div className="analysis-observations"><strong>Capturas disponibles</strong><ol>{history.data.observations.map((point, index) => <li key={`${point.captured_at}-${index}`}><time dateTime={point.captured_at}>{date(point.captured_at)}</time><span>{number(point.metrics[selectedMetric])}</span></li>)}</ol></div></> : <Empty title="Sin capturas históricas" detail="Este registro aún no tiene observaciones guardadas." />}<div className="analysis-provenance"><SourceMeta source={history.data.source} updatedAt={history.data.item.updated_at} sourceUrl={history.data.item.source_url} /></div></> : null}</Panel>}
    </div>}
  </>;
}
