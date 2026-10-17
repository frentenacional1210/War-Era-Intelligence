import type { Env } from './types';

/**
 * "Hoy en WarEra": a deterministic digest of what WINT observed in the last
 * 24 hours. D1 reads only; no model, no upstream request. Times are WINT
 * observation times, which can be later than the in-game event.
 */
type Row = Record<string, unknown>;
export type TodayItem = { id: string; title: string; type: string; countryId: string | null; countryName: string | null;
  observedAt: string; sourceUrl: string | null; entityType: string | null; entityId: string | null; severity: string | null };
export type TodayDigest = { window: { from: string; to: string }; sections: Record<string, TodayItem[]>; counts: Record<string, number>;
  players: { newActive: number; updated: number }; articles: { id: string; title: string; publishedAt: string | null; countryId: string | null; sourceUrl: string | null }[];
  notes: string[] };

export const TODAY_SECTIONS: Record<string, string[]> = {
  military: ['battle-observed', 'battle-inactive'],
  politics: ['election-finished', 'government-leader'],
  territory: ['region-country'],
  markets: ['price-move'],
  people: ['player-country', 'player-party', 'player-unit', 'member-growth'],
  press: ['article-keyword'],
};
const PER_SECTION = 12;
const parse = (value: unknown): Row => { try { const data: unknown = JSON.parse(String(value ?? '{}')); return data && typeof data === 'object' ? data as Row : {}; } catch { return {}; } };
const str = (value: unknown) => typeof value === 'string' && value ? value : null;

export async function readToday(db: D1Database, now = new Date()): Promise<TodayDigest> {
  const to = now.toISOString(), from = new Date(now.getTime() - 86_400_000).toISOString();
  const types = Object.values(TODAY_SECTIONS).flat();
  const [events, counts, articles, players] = await Promise.all([
    db.prepare(`SELECT e.id,e.name,e.event_type,e.country_id,c.name country_name,e.updated_at,e.source_url,e.data_json FROM events e
      LEFT JOIN countries c ON c.id=e.country_id WHERE e.updated_at>=? AND e.updated_at<=? AND e.event_type IN (${types.map(() => '?').join(',')})
      ORDER BY e.updated_at DESC,e.id DESC LIMIT 400`).bind(from, to, ...types).all<Row>(),
    db.prepare('SELECT event_type,COUNT(*) n FROM events WHERE updated_at>=? AND updated_at<=? GROUP BY event_type').bind(from, to).all<{ event_type: string; n: number }>(),
    db.prepare('SELECT id,title,published_at,country_id,source_url FROM articles WHERE published_at>=? AND published_at<=? ORDER BY published_at DESC,id DESC LIMIT 8').bind(from, to).all<Row>(),
    db.prepare('SELECT COALESCE(SUM(new_rows),0) new_rows,COALESCE(SUM(updated_rows),0) updated_rows FROM ingestion_daily_stats WHERE source_id=? AND day_key IN (?,?)')
      .bind('players', from.slice(0, 10), to.slice(0, 10)).first<{ new_rows: number; updated_rows: number }>(),
  ]);
  const sections: Record<string, TodayItem[]> = Object.fromEntries(Object.keys(TODAY_SECTIONS).map(key => [key, []]));
  for (const row of events.results) {
    const type = String(row.event_type);
    const section = Object.entries(TODAY_SECTIONS).find(([, list]) => list.includes(type))?.[0];
    if (!section || sections[section].length >= PER_SECTION) continue;
    const data = parse(row.data_json);
    sections[section].push({ id: String(row.id), title: String(row.name), type, countryId: str(row.country_id), countryName: str(row.country_name),
      observedAt: String(row.updated_at), sourceUrl: str(row.source_url), entityType: str(data.entityType), entityId: str(data.entityId), severity: str(data.severity) });
  }
  return {
    window: { from, to }, sections,
    counts: Object.fromEntries(counts.results.map(row => [row.event_type, Number(row.n)])),
    // Day-bucketed counters cover today and yesterday (UTC), so this is an upper bound for 24 hours.
    players: { newActive: Number(players?.new_rows ?? 0), updated: Number(players?.updated_rows ?? 0) },
    articles: articles.results.map(row => ({ id: String(row.id), title: String(row.title), publishedAt: str(row.published_at), countryId: str(row.country_id), sourceUrl: str(row.source_url) })),
    notes: [
      'Solo cambios observados por WINT en las últimas 24 horas; la hora es la de observación, no necesariamente la del suceso.',
      'Las altas de jugadores suman los días UTC de hoy y ayer, por lo que pueden superar la ventana de 24 horas.',
      'Si la recopilación estuvo en pausa por cuota, faltan los cambios ocurridos durante la pausa.',
    ],
  };
}

export async function todayRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/today') return null;
  if (!['GET', 'HEAD'].includes(request.method)) return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'GET, HEAD' } });
  return Response.json(await readToday(env.DB));
}
