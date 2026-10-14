import { useEffect, useMemo, useRef, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Empty, ErrorState, Loading, Panel } from './components';
import { request } from './api';
import { date, number, safeUrl } from './utils';
import { HISTORY_FIELDS, HISTORY_PERIODS, type HistoryMetric, type HistoryPeriod, type HistoryPoint, type HistoryResource, type HistorySeries } from '../shared/history';
import './history.css';

export type HistoryEntity = { id: string; name: string; sourceUrl?: string };
type Grain = 'auto' | 'raw' | 'day' | 'week' | 'month';
type PagedSeries = HistorySeries & { nextUrl?: string | null; nextCursor?: string | null; entityName?: string | null; sourceUrl?: string | null };
type Result = { key: string; series: PagedSeries[]; error: string | null; loading: boolean; moreLoading: boolean };
type HistoryExplorerProps = { resource: HistoryResource; id?: string; name?: string; entities?: HistoryEntity[]; title?: string; advanced?: boolean };

const labels: Record<string, string> = {
  level: 'Nivel', experience: 'Experiencia', damages_count: 'Daño acumulado', is_active: 'Actividad observada',
  last_connection_at: 'Última conexión observada', military_unit_id: 'Unidad militar', party_id: 'Partido', member_count: 'Miembros',
  leader_id: 'Líder', country_id: 'País', population: 'Población registrada', development: 'Desarrollo', money: 'Dinero',
  ruling_party_id: 'Partido gobernante', initial_country_id: 'País inicial', is_capital: 'Capital', active: 'Batalla activa',
  round: 'Ronda', attacker_damages: 'Daño atacante', defender_damages: 'Daño defensor', region_id: 'Región', price: 'Precio',
  monthly_damages: 'Daño mensual observado', ended_at: 'Fin registrado', won_by: 'Vencedor registrado',
  production: 'Producción indicada', worker_count: 'Trabajadores indicados', estimated_value: 'Valor estimado por la fuente',
  concrete_invested: 'Hormigón invertido indicado', is_full: 'Capacidad completa indicada', owner_id: 'Propietario',
  item_code: 'Producto', storage_upgrade: 'Mejora de almacén', automated_engine_upgrade: 'Mejora de automatización',
  break_room_upgrade: 'Mejora de descanso', status: 'Estado registrado', votes_count: 'Votos registrados',
  elected_count: 'Electos registrados', election_type: 'Tipo de elección', votes_start_at: 'Inicio de votación',
  votes_end_at: 'Fin de votación', president_id: 'Presidencia', vice_president_id: 'Vicepresidencia',
  minister_defense_id: 'Ministerio de defensa', minister_economy_id: 'Ministerio de economía',
  minister_foreign_affairs_id: 'Ministerio de exteriores', congress_count: 'Congresistas registrados',
};
const numeric: Record<HistoryResource, readonly string[]> = {
  players: ['level', 'experience', 'damages_count'], parties: ['member_count'],
  'military-units': ['level', 'member_count', 'monthly_damages'], countries: ['population', 'development', 'money'], regions: [],
  battles: ['round', 'attacker_damages', 'defender_damages'], markets: ['price'],
  companies: ['production', 'worker_count', 'estimated_value', 'concrete_invested', 'storage_upgrade', 'automated_engine_upgrade', 'break_room_upgrade'],
  elections: ['votes_count', 'elected_count'], governments: ['congress_count'],
};
const periodLabels: Record<HistoryPeriod, string> = { '7d': '7 días', '30d': '30 días', '90d': '90 días', '1y': '1 año', '2y': '2 años' };
const grainLabels: Record<string, string> = { raw: 'Capturas individuales', day: 'Resumen diario', week: 'Resumen semanal', month: 'Resumen mensual' };
const colors = ['#5ed5c1', '#f0b86d', '#86a7f3', '#d393d5'];
const pointTime = (point: HistoryPoint) => point.grain === 'raw' ? point.observed_at : point.bucket_start;
const metricText = (value: HistoryMetric | undefined, field: string): string => value === null || value === undefined ? 'Sin dato' : typeof value === 'boolean' ? value ? 'Sí' : 'No' : typeof value === 'number' ? number(value, 2) : /_at$/.test(field) ? date(value) : value;
const methodText = (method: HistoryPoint['method']) => method === 'observed-change' ? 'Cambio observado' : method === 'bucket-last' ? 'Último valor observado del periodo' : 'Primera captura disponible';
const sourceText = (point: HistoryPoint) => ({ raw: 'Captura original', rollup: 'Resumen conservado', mixed: 'Capturas y resumen', baseline: 'Referencia histórica conservada' } as Record<string, string>)[point.source] ?? 'Observación conservada';

function methodology(value: string, resource: HistoryResource) {
  const description = value.startsWith('Change-only observations.')
    ? 'Se muestran cambios observados. En cada intervalo se usa el último valor capturado, sin calcular medias ni rellenar periodos vacíos. Algunos datos antiguos pueden estar pendientes de resumen; no pueden recuperarse capturas borradas antes de iniciar los resúmenes históricos.'
    : value;
  const caveats: Record<string, string> = {
    markets: 'Los precios son cotizaciones globales observadas; no se infieren liquidez, volumen ni precios nacionales.',
    companies: 'Los valores estimados y mejoras proceden de la ficha capturada; no son operaciones de mercado verificadas.',
    elections: 'Los votos y electos son registros observados; esta serie no infiere resultados electorales faltantes.',
    governments: 'Una fecha de captura no establece cuándo empezó o terminó un cargo.',
    battles: 'Una fecha de captura no establece por sí sola cuándo empezó o terminó una batalla.',
  };
  return caveats[resource] ? `${description} ${caveats[resource]}` : description;
}

function chartData(series: PagedSeries[], metric: string) {
  const rows = new Map<number, Record<string, number>>();
  const lines: { key: string; name: string; color: string }[] = [];
  series.forEach((item, index) => {
    let segment = 0;
    let previous: number | null = null;
    for (const point of item.points) {
      const value = point.metrics[metric];
      if (typeof value !== 'number' || !Number.isFinite(value)) { previous = null; segment++; continue; }
      const at = Date.parse(pointTime(point));
      if (!Number.isFinite(at)) continue;
      if (previous !== null && item.gaps.some(gap => Date.parse(gap.from) < at && Date.parse(gap.to) > previous!)) segment++;
      const key = `s${index}_${segment}`;
      const row = rows.get(at) ?? { at };
      row[key] = value;
      rows.set(at, row);
      if (!lines.some(line => line.key === key)) lines.push({ key, name: item.id, color: colors[index] });
      previous = at;
    }
  });
  return { rows: [...rows.values()].sort((a, b) => a.at - b.at), lines };
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? '' : String(value);
  // The CSV is opened in spreadsheets; prefix formula-like values to prevent execution.
  const safe = typeof value === 'number' ? text : /^[\s]*[=+@-]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}
function download(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function HistoryExplorer({ resource, id, name, entities, title = 'Historial de largo plazo', advanced = false }: HistoryExplorerProps) {
  const [period, setPeriod] = useState<HistoryPeriod>('30d');
  const [metric, setMetric] = useState(HISTORY_FIELDS[resource][0]);
  const [grain, setGrain] = useState<Grain>('auto');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const moreBusy = useRef(false);
  const selected = useMemo(() => (entities?.length ? entities : id ? [{ id, name: name ?? id }] : []).slice(0, 4), [entities, id, name]);
  const selectedKey = JSON.stringify(selected.map(item => item.id));
  const validRange = !from || !to || from <= to;
  const query = new URLSearchParams({ resource, period, limit: '200' });
  if (grain !== 'auto') query.set('grain', grain);
  if (from) query.set('from', from);
  if (to) query.set('to', to);
  const key = `${query}:${selectedKey}:${retry}`;

  useEffect(() => {
    if (!selected.length || !validRange) return;
    const controller = new AbortController();
    setResult({ key, series: [], error: null, loading: true, moreLoading: false });
    Promise.all(selected.map(item => request<PagedSeries>(`/api/history?${query}&id=${encodeURIComponent(item.id)}`, { signal: controller.signal })))
      .then(series => { if (!controller.signal.aborted) setResult({ key, series, error: null, loading: false, moreLoading: false }); })
      .catch(error => { if (!controller.signal.aborted) setResult({ key, series: [], error: error instanceof Error ? error.message : 'No se pudo consultar el historial.', loading: false, moreLoading: false }); });
    return () => controller.abort();
    // A serialized key holds every query and selected identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, validRange]);

  const current = result?.key === key ? result : null;
  const series = current?.series ?? [];
  const currentMetric = HISTORY_FIELDS[resource].includes(metric) ? metric : HISTORY_FIELDS[resource][0];
  const hasNumeric = numeric[resource].includes(currentMetric);
  const chart = hasNumeric ? chartData(series, currentMetric) : { rows: [], lines: [] };
  const pointCount = series.reduce((total, item) => total + item.points.length, 0);
  const gapCount = series.reduce((total, item) => total + item.gaps.length, 0);
  const next = series.filter(item => item.nextUrl);
  const loadMore = async () => {
    if (moreBusy.current || !next.length) return;
    moreBusy.current = true;
    setResult(previous => previous?.key === key ? { ...previous, moreLoading: true, error: null } : previous);
    try {
      const pages = await Promise.all(next.map(item => {
        const url = new URL(item.nextUrl!, window.location.origin);
        if (url.origin !== window.location.origin || url.pathname !== '/api/history') throw new Error('Enlace de paginación inválido.');
        return request<PagedSeries>(url.pathname + url.search);
      }));
      setResult(previous => previous?.key === key ? {
        ...previous, moreLoading: false,
        series: previous.series.map(item => {
          const page = pages.find(candidate => candidate.id === item.id);
          return page ? { ...page, points: [...item.points, ...page.points], gaps: [...new Map([...item.gaps, ...page.gaps].map(gap => [`${gap.from}|${gap.to}|${gap.reason}`, gap])).values()], baseline: item.baseline ?? page.baseline } : item;
        }),
      } : previous);
    } catch (error) {
      setResult(previous => previous?.key === key ? { ...previous, moreLoading: false, error: error instanceof Error ? error.message : 'No se pudieron cargar más capturas.' } : previous);
    } finally { moreBusy.current = false; }
  };
  const exportData = (format: 'csv' | 'json') => {
    const records = series.flatMap((item, index) => item.points.map(point => ({ resource, id: item.id, name: selected[index]?.name ?? item.id, observed_at: point.observed_at, bucket_start: point.bucket_start, grain: point.grain, metric: currentMetric, value: point.metrics[currentMetric] ?? null, observations: point.observations, method: point.method, source: sourceText(point) })));
    const stem = `wint-historicos-${resource}-${currentMetric}-${period}`;
    if (format === 'json') download(`${stem}.json`, JSON.stringify({ resource, metric: currentMetric, period, requestedGrain: grain, requestedFrom: from || null, requestedTo: to || null, generatedAt: new Date().toISOString(), records, series: series.map(item => ({ id: item.id, entityName: item.entityName, sourceUrl: item.sourceUrl, sourceMeaning: item.sourceMeaning, actualWindow: { from: item.from, to: item.to, grain: item.grain }, baseline: item.baseline, gaps: item.gaps, methodology: item.methodology, methodologyVersion: item.methodologyVersion, retention: item.retention, archivePending: item.archive_pending, boundaryLimited: item.boundaryLimited, nextUrl: item.nextUrl })), complete: !next.length }, null, 2), 'application/json');
    else download(`${stem}.csv`, [['resource', 'id', 'name', 'observed_at', 'bucket_start', 'grain', 'metric', 'value', 'observations', 'method', 'source'].join(','), ...records.map(record => Object.values(record).map(csvCell).join(','))].join('\r\n'), 'text/csv;charset=utf-8');
  };

  return <div className="history-explorer"><Panel title={title}>
    <div className="history-controls"><label className="form-field"><span>Periodo</span><select aria-label="Periodo" value={period} onChange={event => setPeriod(event.target.value as HistoryPeriod)}>{HISTORY_PERIODS.map(option => <option value={option} key={option}>{periodLabels[option]}</option>)}</select></label><label className="form-field"><span>Medida observada</span><select aria-label="Medida observada" value={currentMetric} onChange={event => setMetric(event.target.value)}>{HISTORY_FIELDS[resource].map(field => <option value={field} key={field}>{labels[field] ?? field}</option>)}</select></label></div>
    {advanced && <div className="history-controls history-advanced"><label className="form-field"><span>Resolución temporal</span><select value={grain} onChange={event => setGrain(event.target.value as Grain)}><option value="auto">Automática según el periodo</option>{Object.entries(grainLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="form-field"><span>Desde</span><input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label><label className="form-field"><span>Hasta</span><input type="date" value={to} onChange={event => setTo(event.target.value)} /></label></div>}
    {!validRange && <p className="history-validation" role="alert">La fecha inicial debe ser anterior o igual a la final.</p>}
    {!selected.length ? <Empty title="Elige un registro" detail="Selecciona una entidad para consultar sus capturas." /> : !validRange ? null : !current || current.loading ? <Loading label="Consultando capturas históricas…" /> : current.error && !series.length ? <ErrorState error={current.error} onRetry={() => setRetry(value => value + 1)} /> : series.length ? <>
      <div className="history-summary"><span>{number(pointCount)} puntos observados · {number(gapCount)} periodos sin observación</span><span>{grainLabels[series[0].grain] ?? series[0].grain} · {periodLabels[period]}</span></div>
      {series.map((item, index) => <div className="history-entity-note" key={item.id}><strong style={{ color: colors[index] }}>{selected[index]?.name ?? item.entityName ?? item.id}</strong><span>Primera captura disponible: {item.baseline ? date(item.baseline.observed_at) : 'Sin capturas'}</span>{item.baseline && <span>Procedencia de referencia: {sourceText(item.baseline)}</span>}{safeUrl(item.sourceUrl ?? selected[index]?.sourceUrl) && <a href={safeUrl(item.sourceUrl ?? selected[index]?.sourceUrl)!} target="_blank" rel="noopener noreferrer">Fuente actual del registro</a>}{item.archive_pending && <span className="history-warning">Existen capturas antiguas pendientes de resumir.</span>}{item.boundaryLimited && <span className="history-warning">Un resumen cruza la fecha final; no se puede reconstruir ese límite con exactitud.</span>}{(item.nextUrl || item.truncated) && <span className="history-warning">Hay más capturas disponibles.</span>}</div>)}
      <div className="history-actions"><button className="btn small" onClick={() => exportData('csv')}>Exportar CSV</button><button className="btn small" onClick={() => exportData('json')}>Exportar JSON</button><span>Se exportan las capturas cargadas y la medida visible{next.length ? '; carga más para incluir otras páginas' : ''}.</span></div>
      {hasNumeric && chart.rows.length ? <><div className="history-chart" role="img" aria-label={`Evolución observada de ${labels[currentMetric] ?? currentMetric}`}><ResponsiveContainer width="100%" height="100%"><LineChart data={chart.rows} margin={{ top: 14, right: 20, bottom: 12, left: 0 }}><CartesianGrid stroke="#263a43" strokeDasharray="3 3" /><XAxis dataKey="at" type="number" domain={['dataMin', 'dataMax']} scale="time" tickFormatter={value => date(new Date(Number(value)).toISOString()).split(',')[0]} tick={{ fill: '#91a6b0', fontSize: 10 }} minTickGap={28} /><YAxis tick={{ fill: '#91a6b0', fontSize: 10 }} width={58} domain={['auto', 'auto']} /><Tooltip labelFormatter={value => date(new Date(Number(value)).toISOString())} formatter={value => number(value, 2)} contentStyle={{ background: '#13232d', border: '1px solid #34515a', color: '#e8f2f3' }} />{chart.lines.map(line => <Line key={line.key} dataKey={line.key} name={selected[series.findIndex(item => item.id === line.name)]?.name ?? line.name} stroke={line.color} strokeWidth={2} connectNulls dot={{ r: 3 }} activeDot={{ r: 5 }} legendType="none" />)}</LineChart></ResponsiveContainer></div><div className="history-legend">{series.map((item, index) => <span key={item.id}><i style={{ background: colors[index] }} />{selected[index]?.name ?? item.id}</span>)}</div></> : hasNumeric ? <Empty title="Sin valores numéricos en el periodo" detail="Las capturas disponibles no contienen esta medida." /> : <div className="history-categorical"><h3>Secuencia de valores observados</h3>{pointCount ? <div className="history-points-scroll"><table><thead><tr><th scope="col">Registro</th><th scope="col">Fecha observada</th><th scope="col">{labels[currentMetric] ?? currentMetric}</th><th scope="col">Procedencia</th></tr></thead><tbody>{series.flatMap((item, index) => item.points.map((point, pointIndex) => <tr key={`${item.id}:${pointIndex}`}><th scope="row">{selected[index]?.name ?? item.id}</th><td><time dateTime={point.observed_at}>{date(point.observed_at)}</time></td><td>{metricText(point.metrics[currentMetric], currentMetric)}</td><td>{sourceText(point)}</td></tr>))}</tbody></table></div> : <p>Sin observaciones de esta medida en el periodo.</p>}</div>}
      <p className="history-methodology">{methodology(series[0].methodology, resource)}</p>
      {gapCount > 0 && <details className="history-gaps"><summary>Ver periodos sin observación ({number(gapCount)})</summary><ul>{series.flatMap((item, index) => item.gaps.map((gap, gapIndex) => <li key={`${item.id}:${gapIndex}`}><strong>{selected[index]?.name ?? item.id}</strong><span>{date(gap.from)} – {date(gap.to)}</span><span>{gap.reason === 'before-first-capture' ? 'Antes de la primera captura' : gap.reason === 'archive-pending' ? 'Capturas pendientes de resumir' : gap.reason === 'raw-retention' ? 'Detalle compactado: consulte los resúmenes' : gap.reason === 'resolution-retention' ? 'Resolución vencida: consulte un resumen más amplio' : 'Sin observación'}</span></li>))}</ul></details>}
      <details className="history-points"><summary>Ver capturas y resúmenes ({number(pointCount)})</summary>{pointCount ? <div className="history-points-scroll"><table><thead><tr><th scope="col">Registro</th><th scope="col">Fecha observada</th><th scope="col">{labels[currentMetric] ?? currentMetric}</th><th scope="col">Método</th><th scope="col">Capturas</th><th scope="col">Procedencia</th></tr></thead><tbody>{series.flatMap((item, index) => item.points.map((point, pointIndex) => <tr key={`${item.id}:${pointIndex}`}><th scope="row">{selected[index]?.name ?? item.id}</th><td><time dateTime={point.observed_at}>{date(point.observed_at)}</time></td><td>{metricText(point.metrics[currentMetric], currentMetric)}</td><td>{methodText(point.method)}</td><td>{number(point.observations)}</td><td>{sourceText(point)}</td></tr>))}</tbody></table></div> : <p>Sin capturas observadas en este periodo.</p>}</details>
      {current.error && <ErrorState error={current.error} onRetry={() => void loadMore()} hasData />}
      {next.length > 0 && <div className="history-more"><button className="btn" onClick={() => void loadMore()} disabled={current.moreLoading}>{current.moreLoading ? 'Cargando más capturas…' : 'Cargar más capturas'}</button><span>{next.length} serie{next.length === 1 ? '' : 's'} con más páginas</span></div>}
    </> : null}
  </Panel></div>;
}
