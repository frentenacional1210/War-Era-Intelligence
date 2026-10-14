import { useEffect, useState } from 'react';
import { Empty, ErrorState, Loading, Panel, SectionTitle } from './components';
import { getCollection } from './api';
import { HistoryExplorer, type HistoryEntity } from './history';
import { displayName, safeUrl, text } from './utils';
import { HISTORY_RESOURCES, type HistoryResource } from '../shared/history';
import './history.css';

const resourceLabels: Record<HistoryResource, string> = {
  players: 'Jugadores', parties: 'Partidos', 'military-units': 'Unidades militares', countries: 'Países',
  regions: 'Regiones', battles: 'Batallas', markets: 'Mercados', companies: 'Empresas',
  elections: 'Elecciones', governments: 'Gobiernos',
};

export default function HistoriesPage() {
  const [resource, setResource] = useState<HistoryResource>('countries');
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<HistoryEntity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [listing, setListing] = useState<Awaited<ReturnType<typeof getCollection>> | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(draft.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [draft]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setListing(null);
    setError(null);
    const query = new URLSearchParams({ page: String(page), limit: '20', sort: resource === 'markets' ? 'price' : 'name', order: resource === 'markets' ? 'desc' : 'asc' });
    if (search) query.set('q', search);
    // getCollection uses the same public listing API as the directories.
    getCollection(resource === 'markets' ? '/api/markets/prices' : `/api/${resource}`, query)
      .then(data => { if (!controller.signal.aborted) { setListing(data); setLoading(false); } })
      .catch(cause => { if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : 'No se pudo buscar.'); setLoading(false); } });
    return () => controller.abort();
  }, [resource, search, page, retry]);

  const chooseResource = (next: HistoryResource) => { setResource(next); setSelected([]); setDraft(''); setSearch(''); setPage(1); };
  const toggle = (entity: HistoryEntity) => setSelected(current => current.some(item => item.id === entity.id) ? current.filter(item => item.id !== entity.id) : current.length < 4 ? [...current, entity] : current);
  const rows = (listing?.items ?? []).map(row => ({ id: text(resource === 'markets' ? row.item_id ?? row.id : row.id, ''), name: displayName(row), sourceUrl: safeUrl(row.source_url) ?? undefined })).filter(row => row.id);
  const pageCount = Math.max(1, Math.ceil((listing?.total ?? 0) / 20));
  return <div className="histories-page">
    <SectionTitle eyebrow="SERIES OBSERVADAS" title="Históricos" description="Compara hasta cuatro registros capturados. Cada punto representa una observación conservada; los periodos vacíos permanecen visibles." />
    <div className="histories-layout"><Panel title="Seleccionar registros">
      <div className="histories-picker"><label className="form-field"><span>Tipo de registro</span><select value={resource} onChange={event => chooseResource(event.target.value as HistoryResource)}>{HISTORY_RESOURCES.map(value => <option value={value} key={value}>{resourceLabels[value]}</option>)}</select></label><label className="form-field"><span>Buscar registro</span><input type="search" value={draft} onChange={event => setDraft(event.target.value)} placeholder={`Buscar ${resourceLabels[resource].toLowerCase()}…`} /></label></div>
      <p className="histories-picker-count" aria-live="polite">{selected.length} de 4 registros seleccionados</p>
      {selected.length > 0 && <div className="histories-chips">{selected.map(item => <button className="histories-chip" key={item.id} onClick={() => toggle(item)} aria-label={`Quitar ${item.name}`}>{item.name} <span aria-hidden="true">×</span></button>)}</div>}
      {error ? <ErrorState error={error} onRetry={() => setRetry(value => value + 1)} /> : loading ? <Loading label="Buscando registros capturados…" /> : rows.length ? <div className="histories-options" role="group" aria-label="Registros capturados">{rows.map(item => { const active = selected.some(value => value.id === item.id); return <button key={item.id} className={active ? 'active' : ''} onClick={() => toggle(item)} disabled={!active && selected.length >= 4} aria-pressed={active}><span><strong>{item.name}</strong><small>ID {item.id}</small></span><span aria-hidden="true">{active ? '✓' : '+'}</span></button>; })}</div> : <Empty title="Sin registros coincidentes" detail="Prueba otra búsqueda o categoría." />}
      {listing && pageCount > 1 && <div className="histories-pagination"><button className="btn small" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Anterior</button><span>Página {page} de {pageCount}</span><button className="btn small" disabled={page >= pageCount} onClick={() => setPage(value => value + 1)}>Siguiente</button></div>}
    </Panel><div className="histories-results"><HistoryExplorer key={resource} resource={resource} entities={selected} title="Comparación histórica" advanced /></div></div>
  </div>;
}
