import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Empty, ErrorState, Loading, Metric, Pagination, Panel, SectionTitle } from './components';
import { request } from './api';
import { useRemote } from './hooks';
import { age, date, number } from './utils';
import type { Source } from './types';
import { ActivityPanel } from './activity';

type CoverageSummary = {
  players_registered: number;
  countries_total: number;
  countries_started: number;
  countries_completed: number;
  countries_pending: number;
  completed_sweeps: number;
  rows_new_today: number;
  rows_updated_today: number;
  profiles_per_hour: number | null;
  eta: null | { estimated_at?: string | null; remaining_seconds?: number | null };
  player_total: number | null;
  active_player_total: number | null;
  methodology_since?: string | null;
  errors_last_hour?: number | null;
};
type CountryCoverage = {
  id: string;
  name: string;
  code?: string | null;
  players_registered: number;
  records_observed: number;
  completed_sweeps: number;
  last_scanned_at: string | null;
  next_run_at: string | null;
  last_profile_at: string | null;
  status: string;
};
type Coverage = { summary: CoverageSummary; countries: CountryCoverage[]; page: number; total: number; limit: number; sources: Source[]; timestamp: string; playerCollectionPolicy?: { mode: string } };

function countryState(status: string) {
  if (['completed', 'complete', 'done'].includes(status)) return { label: 'Recorrido completo', tone: 'good' as const };
  if (['scanning', 'running', 'in-progress'].includes(status)) return { label: 'En curso', tone: 'accent' as const };
  if (['error', 'failed'].includes(status)) return { label: 'Con error', tone: 'bad' as const };
  if (['pending', 'not-started', 'waiting'].includes(status)) return { label: 'Pendiente', tone: 'muted' as const };
  return { label: 'Estado sin confirmar', tone: 'muted' as const };
}

function coverageSourceState(source: Source) {
  if (source.last_error || ['error', 'failed'].includes(source.status ?? '')) return { label: 'Error de recopilación', tone: 'bad' as const };
  if (['stale', 'delayed', 'quota-paused'].includes(source.status ?? '')) return { label: 'Fuente retrasada', tone: 'warn' as const };
  if (['ok', 'active', 'completed'].includes(source.status ?? '')) return { label: 'Fuente activa', tone: 'good' as const };
  if (['running', 'busy'].includes(source.status ?? '')) return { label: 'En curso', tone: 'accent' as const };
  return { label: 'Sin confirmar', tone: 'muted' as const };
}

function etaLabel(eta: CoverageSummary['eta']): string {
  if (!eta) return 'No calculable con los datos disponibles';
  if (eta.estimated_at && !Number.isNaN(new Date(eta.estimated_at).valueOf())) return date(eta.estimated_at);
  if (typeof eta.remaining_seconds === 'number' && Number.isFinite(eta.remaining_seconds) && eta.remaining_seconds >= 0) {
    const hours = Math.ceil(eta.remaining_seconds / 3600);
    return hours < 24 ? `${number(hours)} h aprox.` : `${number(Math.ceil(hours / 24))} días aprox.`;
  }
  return 'No calculable con los datos disponibles';
}

export function CoveragePanel() {
  const [page, setPage] = useState(1);
  const remote = useRemote(() => request<Coverage>(`/api/coverage?${new URLSearchParams({ page: String(page), limit: '30' })}`), `coverage:${page}`, 90_000);
  const data = remote.data;
  const summary = data?.summary;
  const ratio = summary && summary.countries_total > 0 ? summary.countries_completed / summary.countries_total * 100 : null;
  return <div className="coverage-panel">
    {remote.error && <ErrorState error={remote.error} onRetry={remote.reload} hasData={!!data} />}
    {remote.loading && !data ? <Loading label="Consultando el avance del censo…" /> : data && summary ? <>
      <div className="coverage-context">Estado registrado: <time dateTime={data.timestamp}>{date(data.timestamp)}</time> · {age(data.timestamp)}. El número de perfiles corresponde a registros capturados; no representa la población mundial ni los jugadores activos.{summary.methodology_since && <> Seguimiento actual desde {date(summary.methodology_since)}.</>}{summary.errors_last_hour !== null && summary.errors_last_hour !== undefined && <> Errores de recopilación en la última hora: {number(summary.errors_last_hour)}.</>}</div>
      <div className="coverage-metrics">
        <div data-testid="coverage-players"><Metric label="Perfiles de jugadores registrados" value={number(summary.players_registered)} hint="Identidades capturadas por WINT" /></div>
        <Metric label="Países del directorio recorridos" value={`${number(summary.countries_completed)} / ${number(summary.countries_total)}`} hint={ratio === null ? 'Sin denominador disponible' : `${number(ratio, 1)} % de los países registrados`} />
        <Metric label="Países pendientes" value={number(summary.countries_pending)} hint={`${number(summary.countries_started)} países iniciados`} />
        <Metric label="Recorridos completos" value={number(summary.completed_sweeps)} hint="Incluye visitas posteriores a un mismo país" />
        <Metric label="Registros nuevos hoy" value={number(summary.rows_new_today)} />
        <Metric label="Registros actualizados hoy" value={number(summary.rows_updated_today)} />
        <Metric label="Velocidad observada" value={summary.profiles_per_hour === null ? 'Sin medida' : `${number(summary.profiles_per_hour, 1)} perfiles/h`} />
        <Metric label="Fin estimado del recorrido" value={etaLabel(summary.eta)} />
      </div>
      <p className="coverage-population">Población total de jugadores: <strong>{summary.player_total === null ? 'Desconocida' : number(summary.player_total)}</strong> · Jugadores activos: <strong>{summary.active_player_total === null ? 'Desconocidos' : number(summary.active_player_total)}</strong></p>
      {data.playerCollectionPolicy?.mode === 'active-only' && <p className="coverage-context">Se guardan y actualizan solo perfiles que WarEra marca como activos. Los candidatos inactivos o sin marca verificable se comprueban en recorridos posteriores para detectar reactivaciones. Los registros anteriores y sus históricos se conservan.</p>}
      <Panel title="Progreso por país">
        {data.countries.length ? <><div className="coverage-table-wrap"><table className="coverage-table"><thead><tr><th scope="col">País</th><th scope="col">Estado</th><th scope="col">Jugadores registrados</th><th scope="col">Registros observados</th><th scope="col">Recorridos completos</th><th scope="col">Último recorrido</th><th scope="col">Último perfil</th><th scope="col">Próximo intento</th></tr></thead><tbody>{data.countries.map(country => { const state = countryState(country.status); return <tr key={country.id}><th scope="row"><Link to={`/paises/${encodeURIComponent(country.id)}`}>{country.name}</Link>{country.code && <small>{country.code}</small>}</th><td><Badge tone={state.tone}>{state.label}</Badge></td><td>{number(country.players_registered)}</td><td>{number(country.records_observed)}</td><td>{number(country.completed_sweeps)}</td><td>{country.last_scanned_at ? <><time dateTime={country.last_scanned_at}>{date(country.last_scanned_at)}</time><small>{age(country.last_scanned_at)}</small></> : 'Sin recorrido'}</td><td>{country.last_profile_at ? <><time dateTime={country.last_profile_at}>{date(country.last_profile_at)}</time><small>{age(country.last_profile_at)}</small></> : 'Sin captura'}</td><td>{country.next_run_at ? date(country.next_run_at) : 'Sin fecha'}</td></tr>; })}</tbody></table></div><Pagination page={data.page} total={data.total} limit={data.limit} onPage={setPage} /></> : <Empty title="Sin países registrados" detail="El directorio de países aún no dispone de registros." />}
      </Panel>
      <Panel title="Estado de las fuentes" className="section-gap"><div className="coverage-sources">{data.sources?.length ? data.sources.map(source => { const state = coverageSourceState(source); return <div className="coverage-source" key={source.id}><strong>{source.id}</strong><Badge tone={state.tone}>{state.label}</Badge><span>Última captura: {date(source.last_success)} · {age(source.last_success)}</span>{source.last_error && <span className="coverage-source-error">Último intento fallido</span>}</div>; }) : <p>Sin fuentes registradas.</p>}</div></Panel>
    </> : null}
  </div>;
}

export function CoveragePage() {
  return <><SectionTitle eyebrow="CENSO" title="Cobertura de datos" description="Avance verificable de la recopilación pública por país y antigüedad de las capturas." /><CoveragePanel /><div className="section-gap"><ActivityPanel title="Actividad semanal observada · todos los países" /></div></>;
}
