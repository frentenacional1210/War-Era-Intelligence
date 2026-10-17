import { RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { request } from './api';
import { Empty, ErrorState, Loading, Metric, Panel, SectionTitle } from './components';
import { useRemote } from './hooks';
import { age, date, localizedTitle, number, safeUrl } from './utils';
import type { TodayDigest, TodayItem } from '../worker/today';

const SECTION_TITLES: Record<string, { title: string; empty: string }> = {
  military: { title: 'Frente militar', empty: 'No se observaron batallas nuevas ni finalizadas.' },
  politics: { title: 'Política', empty: 'No se observaron elecciones finalizadas ni cambios de gobierno.' },
  territory: { title: 'Territorio', empty: 'No se observaron cambios de control de regiones.' },
  markets: { title: 'Mercados', empty: 'Ningún precio global cambió más de un 20 %.' },
  people: { title: 'Jugadores y grupos', empty: 'No se observaron cambios de país, partido o unidad ni crecimientos de grupos.' },
  press: { title: 'Temas vigilados en prensa', empty: 'Ningún titular coincidió con un tema vigilado.' },
};
const ENTITY_PATHS: Record<string, string> = { battles: '/batallas', players: '/jugadores', regions: '/regiones', elections: '/elecciones',
  governments: '/gobiernos', parties: '/partidos', 'military-units': '/unidades', articles: '/articulos', companies: '/empresas' };

function Item({ item }: { item: TodayItem }) {
  const entity = item.entityType && item.entityId && ENTITY_PATHS[item.entityType] ? `${ENTITY_PATHS[item.entityType]}/${encodeURIComponent(item.entityId)}` : null;
  const source = safeUrl(item.sourceUrl);
  return <li className="today-item">
    <div><strong>{entity ? <Link to={entity}>{localizedTitle(item.title)}</Link> : localizedTitle(item.title)}</strong>
      <small>{item.countryId ? <Link className="text-link" to={`/paises/${encodeURIComponent(item.countryId)}`}>{item.countryName ?? 'País'}</Link> : 'Sin país asignado'} · observado {age(item.observedAt)}</small></div>
    {source && <a className="source-link" href={source} target="_blank" rel="noopener noreferrer">Fuente</a>}
  </li>;
}

export function TodayPage() {
  const remote = useRemote(() => request<TodayDigest>('/api/today'), 'today', 300_000);
  const data = remote.data, c = data?.counts ?? {};
  return <>
    <SectionTitle eyebrow="RESUMEN DIARIO" title="Hoy en WarEra" description="Lo que WINT observó en las últimas 24 horas, sin IA y con enlace a cada registro."
      action={<button className="btn" onClick={remote.reload} disabled={remote.refreshing}><RefreshCw size={15} className={remote.refreshing ? 'spin' : ''} /> Actualizar</button>} />
    {remote.error && <ErrorState error={remote.error} onRetry={remote.reload} hasData={!!data} />}
    {remote.loading && !data ? <Loading label="Preparando el resumen…" /> : data && <>
      <div className="metric-grid">
        <Metric label="Batallas nuevas" value={number(c['battle-observed'] ?? 0)} hint={`${number(c['battle-inactive'] ?? 0)} confirmadas inactivas`} />
        <Metric label="Elecciones finalizadas" value={number(c['election-finished'] ?? 0)} hint={`${number(c['government-leader'] ?? 0)} cambios de gobierno`} />
        <Metric label="Movimientos de precio" value={number(c['price-move'] ?? 0)} hint="Cambios globales superiores al 20 %" />
        <Metric label="Jugadores activos nuevos" value={number(data.players.newActive)} hint={`${number(data.players.updated)} perfiles actualizados`} />
      </div>
      <div className="dashboard-grid">{Object.entries(SECTION_TITLES).map(([key, section]) => {
        const items = data.sections[key] ?? [];
        return <Panel key={key} title={`${section.title}${items.length ? ` · ${number(items.length)}` : ''}`}>
          {items.length ? <ul className="today-list">{items.map(item => <Item key={item.id} item={item} />)}</ul> : <Empty detail={section.empty} />}
        </Panel>;
      })}
        <Panel title={`Artículos publicados${data.articles.length ? ` · ${number(data.articles.length)}` : ''}`}>
          {data.articles.length ? <ul className="today-list">{data.articles.map(article => <li key={article.id} className="today-item"><div><strong><Link to={`/articulos/${encodeURIComponent(article.id)}`}>{article.title}</Link></strong><small>{date(article.publishedAt)}</small></div></li>)}</ul>
            : <Empty detail="No se capturaron artículos publicados en las últimas 24 horas." />}
        </Panel>
      </div>
      <ul className="footnote today-notes">{data.notes.map(note => <li key={note}>{note}</li>)}<li>Ventana: {date(data.window.from)} – {date(data.window.to)}.</li></ul>
    </>}
  </>;
}
