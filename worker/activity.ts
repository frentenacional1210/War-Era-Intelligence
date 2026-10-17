import type { Env } from './types';

/**
 * Weekly activity WINT can actually observe. "joined" counts active profiles
 * first stored that week; "lastSeen" counts players whose latest observed
 * connection falls in that week. Departures are not observable: inactive
 * profiles are deliberately not stored, so no week reports them.
 */
export type ActivityWeek = { weekStart: string; joined: number; lastSeen: number };
export type ActivityReport = { countryId: string | null; weeks: ActivityWeek[]; totalCaptured: number; since: string; notes: string[] };

export const ACTIVITY_WEEKS = 8;
const monday = (date: Date) => {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day;
};

export async function readActivity(db: D1Database, countryId: string | null, now = new Date()): Promise<ActivityReport> {
  const first = monday(now);
  first.setUTCDate(first.getUTCDate() - 7 * (ACTIVITY_WEEKS - 1));
  const since = first.toISOString();
  const scope = countryId ? ' AND country_id=?' : '';
  const args = countryId ? [since, countryId] : [since];
  // SQLite's date(x,'-6 days','weekday 1') is the Monday on or before x.
  const [joined, seen, total] = await Promise.all([
    db.prepare(`SELECT date(first_seen,'-6 days','weekday 1') week,COUNT(*) n FROM players WHERE first_seen>=?${scope} GROUP BY week`).bind(...args).all<{ week: string; n: number }>(),
    db.prepare(`SELECT date(last_active_at,'-6 days','weekday 1') week,COUNT(*) n FROM players WHERE last_active_at>=?${scope} GROUP BY week`).bind(...args).all<{ week: string; n: number }>(),
    db.prepare(`SELECT COUNT(*) n FROM players${countryId ? ' WHERE country_id=?' : ''}`).bind(...(countryId ? [countryId] : [])).first<{ n: number }>(),
  ]);
  const byWeek = (rows: { week: string; n: number }[]) => new Map(rows.map(row => [row.week, Number(row.n)]));
  const j = byWeek(joined.results), s = byWeek(seen.results);
  const weeks: ActivityWeek[] = Array.from({ length: ACTIVITY_WEEKS }, (_, index) => {
    const start = new Date(first); start.setUTCDate(start.getUTCDate() + 7 * index);
    const key = start.toISOString().slice(0, 10);
    return { weekStart: key, joined: j.get(key) ?? 0, lastSeen: s.get(key) ?? 0 };
  });
  return { countryId, weeks, totalCaptured: Number(total?.n ?? 0), since,
    notes: ['Semanas de lunes a domingo en UTC. «Altas» son perfiles activos guardados por primera vez esa semana: refleja el avance del censo de WINT, no altas en WarEra.',
      '«Última conexión» cuenta jugadores cuya conexión más reciente observada cae en esa semana; un jugador que se conectó después aparece solo en la semana más reciente.',
      'Las bajas no son observables: los perfiles inactivos no se guardan. No hay datos anteriores a la primera captura de WINT.'] };
}

export async function activityRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/activity') return null;
  if (!['GET', 'HEAD'].includes(request.method)) return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'GET, HEAD' } });
  const country = url.searchParams.get('country');
  if (country !== null && !/^[A-Za-z0-9_-]{1,100}$/.test(country)) return Response.json({ error: 'País no válido.' }, { status: 400 });
  return Response.json(await readActivity(env.DB, country));
}
