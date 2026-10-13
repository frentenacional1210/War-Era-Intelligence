import { useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Empty, ErrorState, Loading, Panel } from './components';
import { request } from './api';
import { useRemote } from './hooks';
import { date, number } from './utils';
import { HISTORY_FIELDS, HISTORY_PERIODS, type HistoryMetric, type HistoryPeriod, type HistoryPoint, type HistoryResource, type HistorySeries } from '../shared/history';

export type HistoryEntity = { id: string; name: string };
type HistoryExplorerProps = { resource: HistoryResource; id?: string; name?: string; entities?: HistoryEntity[]; title?: string };

const labels: Record<string, string> = {
  level: 'Nivel', experience: 'Experiencia', damages_count: 'Daño acumulado', is_active: 'Actividad observada',
  last_connection_at: 'Última conexión observada', military_unit_id: 'Unidad militar', party_id: 'Partido', member_count: 'Miembros',
  leader_id: 'Líder', country_id: 'País', population: 'Población registrada', development: 'Desarrollo', money: 'Dinero',
  ruling_party_id: 'Partido gobernante', initial_country_id: 'País inicial', is_capital: 'Capital', active: 'Batalla activa',
  round: 'Ronda', attacker_damages: 'Daño atacante', defender_damages: 'Daño defensor',
  attacker_country_id: 'País atacante', defender_country_id: 'País defensor', region_id: 'Región', price: 'Precio',
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
const grainLabels = { raw: 'Capturas individuales', day: 'Resumen diario', week: 'Resumen semanal', month: 'Resumen mensual' };
const colors = ['#5ed5c1', '#f0b86d', '#86a7f3', '#d393d5'];
const pointTime = (point: HistoryPoint) => point.grain === 'raw' ? point.observed_at : point.bucket_start;
const metricText = (value: HistoryMetric | undefined, field: string): string => value === null || value === undefined ? 'Sin dato' : typeof value === 'boolean' ? value ? 'Sí' : 'No' : typeof value === 'number' ? number(value, 2) : /_at$/.test(field) ? date(value) : value;
const methodText = (method: HistoryPoint['method']) => method === 'observed-change' ? 'Cambio observado' : method === 'bucket-last' ? 'Último valor observado del periodo' : 'Primera captura disponible';

function chartRows(series: HistorySeries[], metric: string) {
  const rows = new Map<string, Record<string, string | number | null>>();
  for (let index = 0; index < series.length; index++) {
    for (const point of series[index].points) {
      const at = pointTime(point), row = rows.get(at) ?? { at };
      const value = point.metrics[metric];
      row[`series_${index}`] = typeof value === 'number' && Number.isFinite(value) ? value : null;
      rows.set(at, row);
    }
    for (const gap of series[index].gaps) {
      const row = rows.get(gap.from) ?? { at: gap.from };
      row[`series_${index}`] = null;
      rows.set(gap.from, row);
    }
  }
  return [...rows.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

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

export function HistoryExplorer({ resource, id, name, entities, title = 'Historial de largo plazo' }: HistoryExplorerProps) {
  const [period, setPeriod] = useState<HistoryPeriod>('30d');
  const [metric, setMetric] = useState(HISTORY_FIELDS[resource][0]);
  const selected = (entities?.length ? entities : id ? [{ id, name: name ?? id }] : []).slice(0, 4);
  const stableIds = selected.map(item => item.id).join('|');
  const remote = useRemote(() => Promise.all(selected.map(item => request<HistorySeries>(`/api/history?${new URLSearchParams({ resource, id: item.id, period })}`))), `history-explorer:${resource}:${period}:${stableIds}`, 0);
  const currentMetric = HISTORY_FIELDS[resource].includes(metric) ? metric : HISTORY_FIELDS[resource][0];
  const series = remote.data ?? [];
  const hasNumeric = numeric[resource].includes(currentMetric);
  const rows = hasNumeric ? chartRows(series, currentMetric) : [];
  const pointCount = series.reduce((total, item) => total + item.points.length, 0);
  const gapCount = series.reduce((total, item) => total + item.gaps.length, 0);
  return <div className="history-explorer"><Panel title={title}>
    <div className="history-controls"><label className="form-field"><span>Periodo</span><select value={period} onChange={event => setPeriod(event.target.value as HistoryPeriod)}>{HISTORY_PERIODS.map(option => <option value={option} key={option}>{periodLabels[option]}</option>)}</select></label><label className="form-field"><span>Medida observada</span><select value={currentMetric} onChange={event => setMetric(event.target.value)}>{HISTORY_FIELDS[resource].map(field => <option value={field} key={field}>{labels[field] ?? field}</option>)}</select></label></div>
    {!selected.length ? <Empty title="Elige un registro" detail="Selecciona una entidad para consultar sus capturas." /> : remote.loading && !remote.data ? <Loading label="Consultando capturas históricas…" /> : remote.error ? <ErrorState error={remote.error} onRetry={remote.reload} /> : series.length ? <>
      <div className="history-summary"><span>{number(pointCount)} puntos observados · {number(gapCount)} periodos sin observación</span><span>{grainLabels[series[0].grain]} · {periodLabels[period]}</span></div>
      {series.map((item, index) => <div className="history-entity-note" key={item.id}><strong style={{ color: colors[index] }}>{selected[index]?.name ?? item.id}</strong><span>Primera captura disponible: {item.baseline ? date(item.baseline.observed_at) : 'Sin capturas'}</span>{item.truncated && <span className="history-warning">Hay más capturas que las incluidas en esta consulta.</span>}{item.archive_pending && <span className="history-warning">Existen capturas antiguas pendientes de resumir.</span>}</div>)}
      {hasNumeric && rows.some(row => series.some((_item, index) => typeof row[`series_${index}`] === 'number')) ? <div className="history-chart" role="img" aria-label={`Evolución observada de ${labels[currentMetric] ?? currentMetric}`}><ResponsiveContainer width="100%" height="100%"><LineChart data={rows} margin={{ top: 14, right: 20, bottom: 12, left: 0 }}><CartesianGrid stroke="#263a43" strokeDasharray="3 3" /><XAxis dataKey="at" tickFormatter={value => date(String(value)).split(',')[0]} tick={{ fill: '#91a6b0', fontSize: 10 }} minTickGap={28} /><YAxis tick={{ fill: '#91a6b0', fontSize: 10 }} width={58} domain={['auto', 'auto']} /><Tooltip labelFormatter={value => date(String(value))} formatter={value => number(value, 2)} contentStyle={{ background: '#13232d', border: '1px solid #34515a', color: '#e8f2f3' }} /><Legend />{series.map((item, index) => <Line key={item.id} dataKey={`series_${index}`} name={selected[index]?.name ?? item.id} stroke={colors[index]} strokeWidth={2} connectNulls={false} dot={{ r: 3 }} activeDot={{ r: 5 }} />)}</LineChart></ResponsiveContainer></div> : <Empty title="Sin valores numéricos en el periodo" detail={hasNumeric ? 'Las capturas disponibles no contienen esta medida.' : 'Consulta la secuencia de cambios observados debajo.'} />}
      <p className="history-methodology">{methodology(series[0].methodology, resource)}</p>
      {gapCount > 0 && <details className="history-gaps"><summary>Ver periodos sin observación ({number(gapCount)})</summary><ul>{series.flatMap((item, index) => item.gaps.map((gap, gapIndex) => <li key={`${item.id}:${gapIndex}`}><strong>{selected[index]?.name ?? item.id}</strong><span>{date(gap.from)} – {date(gap.to)}</span><span>{gap.reason === 'before-first-capture' ? 'Antes de la primera captura' : gap.reason === 'archive-pending' ? 'Capturas pendientes de resumir' : 'Sin observación'}</span></li>))}</ul></details>}
      <details className="history-points"><summary>Ver capturas y resúmenes ({number(pointCount)})</summary>{pointCount ? <div className="history-points-scroll"><table><thead><tr><th scope="col">Registro</th><th scope="col">Fecha observada</th><th scope="col">{labels[currentMetric] ?? currentMetric}</th><th scope="col">Método</th><th scope="col">Capturas</th></tr></thead><tbody>{series.flatMap((item, index) => item.points.map((point, pointIndex) => <tr key={`${item.id}:${pointIndex}`}><th scope="row">{selected[index]?.name ?? item.id}</th><td><time dateTime={point.observed_at}>{date(point.observed_at)}</time></td><td>{metricText(point.metrics[currentMetric], currentMetric)}</td><td>{methodText(point.method)}</td><td>{number(point.observations)}</td></tr>))}</tbody></table></div> : <p>Sin capturas observadas en este periodo.</p>}</details>
    </> : null}
  </Panel></div>;
}
