import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { alertSeverities, alertThemes, isAlertSeverity, isAlertTheme, validAlertId, type AlertFeedItem, type AlertSeverity, type AlertTheme } from '../shared/alerts';
import { request } from './api';
import { Badge, Empty, ErrorState, Loading, Panel, SectionTitle } from './components';
import { useRemote } from './hooks';
import type { Collection, Row } from './types';
import { date, displayName, localizedTitle, number, safeUrl } from './utils';

type Feed = { items: AlertFeedItem[]; limit: number; filters: Record<string, string | null>; methodology: string; query?: string };
type Filters = { country: string; theme: '' | AlertTheme; severity: '' | AlertSeverity; since: string; until: string };
const KEY = 'wint:alerts:filters:v1';
const emptyFilters: Filters = { country: '', theme: '', severity: '', since: '', until: '' };
const themeNames: Record<AlertTheme, string> = { military: 'Militar', territory: 'Territorial', politics: 'Política', economy: 'Economía', community: 'Comunidad', activity: 'Actividad', media: 'Prensa' };
const severityNames: Record<AlertSeverity, string> = { info: 'Informativa', notable: 'Destacada', high: 'Alta' };
const routes: Record<string, string> = { players: '/jugadores', parties: '/partidos', 'military-units': '/unidades', military_units: '/unidades', countries: '/paises', regions: '/regiones', battles: '/batallas', articles: '/articulos', companies: '/empresas', alerts: '/alertas' };
const dateInput = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) ? value : '';
function readFilters(): Filters {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyFilters;
    const row = raw as Record<string, unknown>;
    return { country: validAlertId(row.country) ? row.country : '', theme: isAlertTheme(row.theme) ? row.theme : '',
      severity: isAlertSeverity(row.severity) ? row.severity : '', since: dateInput(row.since), until: dateInput(row.until) };
  } catch { return emptyFilters; }
}
async function countryOptions(): Promise<Row[]> {
  const pages = await Promise.all([1, 2, 3, 4].map(page => request<Collection>(`/api/countries?limit=50&page=${page}&sort=name`)));
  return pages.flatMap(page => page.items);
}
const entityHref = (item: AlertFeedItem) => routes[item.entityType] && item.entityId
  ? `${routes[item.entityType]}/${encodeURIComponent(item.entityId)}` : null;
const evidence = (value: unknown) => value === null || value === undefined ? 'Sin dato observado' :
  typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);

export function AlertFeedPage() {
  const [filters, setFilters] = useState<Filters>(readFilters);
  const countries = useRemote(countryOptions, 'alert:countries:v1', 0);
  const invalidRange = Boolean(filters.since && filters.until && filters.since > filters.until);
  const query = new URLSearchParams({ limit: '50' });
  if (filters.country) query.set('country', filters.country);
  if (filters.theme) query.set('theme', filters.theme);
  if (filters.severity) query.set('severity', filters.severity);
  if (filters.since) query.set('since', `${filters.since}T00:00:00.000Z`);
  if (filters.until) query.set('until', `${filters.until}T23:59:59.999Z`);
  const queryKey = query.toString();
  const feed = useRemote(() => invalidRange ? Promise.resolve(null) : request<Feed>(`/api/alerts/feed?${queryKey}`).then(result => ({ ...result, query: queryKey })), `alert:feed:${invalidRange ? 'invalid' : queryKey}`, 90_000);
  const currentFeed = feed.data?.query === queryKey ? feed.data : null;
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(filters)); } catch { /* Preferencias opcionales. */ } }, [filters]);
  const update = (key: keyof Filters, value: string) => setFilters(current => ({ ...current, [key]: value } as Filters));
  return <>
    <SectionTitle eyebrow="MONITORIZACIÓN" title="Alertas observadas" description="Cambios detectados en registros públicos, con fecha, fuente y criterio de verificación." action={<button type="button" className="btn" onClick={feed.reload} disabled={feed.refreshing || invalidRange}>Actualizar feed</button>} />
    <p className="alerts-caveat">Las alertas proceden de reglas aplicadas a capturas públicas. La fecha indica cuándo se observó el cambio, no necesariamente cuándo ocurrió. Una coincidencia en el título de un artículo es solo metadato.</p>
    <Panel title="Filtrar alertas"><div className="alerts-filters"><label className="form-field"><span>País</span><select value={filters.country} onChange={event => update('country', event.target.value)}><option value="">Todos los países</option>{filters.country && !countries.data?.some(row => String(row.id) === filters.country) && <option value={filters.country}>ID {filters.country}</option>}{countries.data?.map(row => <option key={String(row.id)} value={String(row.id)}>{displayName(row)}</option>)}</select></label><label className="form-field"><span>Tema</span><select value={filters.theme} onChange={event => update('theme', event.target.value)}><option value="">Todos los temas</option>{alertThemes.map(theme => <option key={theme} value={theme}>{themeNames[theme]}</option>)}</select></label><label className="form-field"><span>Importancia</span><select value={filters.severity} onChange={event => update('severity', event.target.value)}><option value="">Todas</option>{alertSeverities.map(severity => <option key={severity} value={severity}>{severityNames[severity]}</option>)}</select></label><label className="form-field"><span>Desde (UTC)</span><input type="date" value={filters.since} onChange={event => update('since', event.target.value)} /></label><label className="form-field"><span>Hasta (UTC)</span><input type="date" value={filters.until} onChange={event => update('until', event.target.value)} /></label></div><div className="alerts-filter-footer"><span>Estos filtros se guardan solo en este navegador.</span><button type="button" className="btn small" onClick={() => setFilters(emptyFilters)}>Restablecer filtros</button></div>{countries.error && <div className="alerts-country-error"><ErrorState error={countries.error} onRetry={countries.reload} /></div>}</Panel>
    <Panel title="Cambios capturados" className="section-gap">{invalidRange ? <Empty title="Revisa las fechas" detail="La fecha inicial debe ser anterior o igual a la fecha final." /> : !currentFeed && !feed.error ? <Loading label="Consultando alertas…" /> : feed.error ? <ErrorState error={feed.error} onRetry={feed.reload} /> : currentFeed ? <><p className="alerts-count">{number(currentFeed.items.length)} alertas en esta consulta. Se muestran como máximo {number(currentFeed.limit)} cambios recientes que cumplen los filtros; el feed no representa cobertura exhaustiva.</p>{currentFeed.items.length ? <ol className="alerts-feed">{currentFeed.items.map(item => { const source = safeUrl(item.sourceUrl), href = entityHref(item); return <li key={item.id}><div className="alerts-head"><Link to={`/alertas/${encodeURIComponent(item.id)}`}>{localizedTitle(item.title)}</Link><Badge tone={item.severity === 'high' ? 'bad' : item.severity === 'notable' ? 'warn' : 'muted'}>{severityNames[item.severity]}</Badge></div><div className="alerts-meta"><span>{themeNames[item.theme]}</span><time dateTime={item.observedAt}>{date(item.observedAt)}</time>{item.countryId && <Link to={`/paises/${encodeURIComponent(item.countryId)}`}>País ID {item.countryId}</Link>}</div>{item.explanation ? <p>{item.explanation}</p> : <p className="alerts-no-explanation">No se capturó una explicación adicional para este cambio.</p>}<div className="alerts-links">{href && <Link to={href}>Abrir registro relacionado ↗</Link>}{source && <a href={source} target="_blank" rel="noopener noreferrer">Fuente original ↗</a>}</div><details className="alerts-evidence"><summary>Ver datos observados y criterio</summary><div><section><strong>Antes</strong><pre>{evidence(item.before)}</pre></section><section><strong>Después</strong><pre>{evidence(item.after)}</pre></section></div><small>Verificación: {item.verification === 'observed-change' ? 'Cambio entre capturas' : item.verification || 'Sin dato'}{item.rule ? ` · Criterio: ${item.rule}` : ''}</small></details></li>; })}</ol> : <Empty title="Sin alertas para estos filtros" detail="No se ha capturado ningún cambio que cumpla la selección actual." />}</> : null}</Panel>
  </>;
}
