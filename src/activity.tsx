import { request } from './api';
import { Empty, ErrorState, Loading, Panel } from './components';
import { useRemote } from './hooks';
import { number } from './utils';
import type { ActivityReport } from '../worker/activity';

const weekLabel = (iso: string) => new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));

/** Observable weekly activity as an accessible table with CSS bars; no charting library. */
export function ActivityPanel({ countryId, title = 'Actividad semanal observada' }: { countryId?: string; title?: string }) {
  const query = countryId ? `?country=${encodeURIComponent(countryId)}` : '';
  const remote = useRemote(() => request<ActivityReport>(`/api/activity${query}`), `activity:${countryId ?? 'all'}`);
  const data = remote.data;
  const max = Math.max(1, ...(data?.weeks ?? []).flatMap(week => [week.joined, week.lastSeen]));
  return <Panel title={title}>
    {remote.error && <ErrorState error={remote.error} onRetry={remote.reload} hasData={!!data} />}
    {remote.loading && !data ? <Loading label="Calculando actividad…" /> : data && (data.totalCaptured === 0 ? <Empty detail="No hay jugadores capturados para calcular actividad." /> : <>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Tabla desplazable"><table className="data-table activity-table">
        <caption>Semanas UTC desde el lunes. Barras proporcionales al valor más alto de la tabla.</caption>
        <thead><tr><th scope="col">Semana</th><th scope="col">Altas en el censo de WINT</th><th scope="col">Última conexión observada</th></tr></thead>
        <tbody>{data.weeks.map(week => <tr key={week.weekStart}><th scope="row">{weekLabel(week.weekStart)}</th>
          <td><span className="activity-bar joined" style={{ width: `${(week.joined / max) * 100}%` }} aria-hidden="true" />{number(week.joined)}</td>
          <td><span className="activity-bar seen" style={{ width: `${(week.lastSeen / max) * 100}%` }} aria-hidden="true" />{number(week.lastSeen)}</td></tr>)}</tbody>
      </table></div>
      <ul className="footnote activity-notes">{data.notes.map(note => <li key={note}>{note}</li>)}</ul>
    </>)}
  </Panel>;
}
