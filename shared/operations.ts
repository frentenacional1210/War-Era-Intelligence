/**
 * Operational health for administrators: is the GitHub collector still
 * committing, and are runs failing? A quota pause is expected and is not
 * reported as a collector failure.
 */
export type OperationsInput = { now: Date; lastCollectorCommitAt: string | null; errorsLastHour: number; runsLastHour: number; collectorSourcesPaused: boolean };
export type OperationsHealth = { level: 'ok' | 'warn' | 'bad'; messages: string[]; lastCollectorCommitAt: string | null; errorsLastHour: number; runsLastHour: number };

export const COLLECTOR_STALE_MINUTES = 60;
export const COLLECTOR_DOWN_MINUTES = 180;

export function operationsHealth(input: OperationsInput): OperationsHealth {
  const messages: string[] = [];
  let level: OperationsHealth['level'] = 'ok';
  const raise = (next: 'warn' | 'bad') => { if (level !== 'bad') level = next; };
  const last = input.lastCollectorCommitAt ? Date.parse(input.lastCollectorCommitAt) : NaN;
  const minutes = Number.isFinite(last) ? Math.floor((input.now.getTime() - last) / 60_000) : null;
  if (input.collectorSourcesPaused) messages.push('Jugadores y artículos están en pausa por la cuota diaria; el recolector no debe confirmar páginas hasta las 00:00 UTC.');
  else if (minutes === null) { raise('warn'); messages.push('No consta ninguna página confirmada por el recolector de GitHub.'); }
  else if (minutes >= COLLECTOR_DOWN_MINUTES) { raise('bad'); messages.push(`El recolector de GitHub no confirma páginas desde hace ${Math.floor(minutes / 60)} h: revisa GitHub Actions y el secreto del recolector.`); }
  else if (minutes >= COLLECTOR_STALE_MINUTES) { raise('warn'); messages.push(`El recolector de GitHub no confirma páginas desde hace ${minutes} min.`); }
  if (input.runsLastHour > 0 && input.errorsLastHour >= 3 && input.errorsLastHour / input.runsLastHour >= 0.2) {
    raise(input.errorsLastHour / input.runsLastHour >= 0.5 ? 'bad' : 'warn');
    messages.push(`${input.errorsLastHour} de ${input.runsLastHour} ejecuciones fallaron en la última hora.`);
  }
  return { level, messages, lastCollectorCommitAt: input.lastCollectorCommitAt, errorsLastHour: input.errorsLastHour, runsLastHour: input.runsLastHour };
}
