import type { Env } from './types';
import { isAlertSeverity, isAlertTheme, validAlertId, validAlertTime, type AlertFeedItem } from '../shared/alerts';

type AlertRow = { id: string; name: string; country_id: string | null; severity: string | null;
  source_url: string; updated_at: string; data_json: string };
const respond = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Indexed, bounded feed. Event text is rule-authored; article bodies are never read. */
export async function alertsRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/alerts/feed') return null;
  if (request.method !== 'GET') return respond({ error: 'Method not allowed' }, 405);
  const country = url.searchParams.get('country');
  const theme = url.searchParams.get('theme');
  const severity = url.searchParams.get('severity');
  const since = url.searchParams.get('since');
  const until = url.searchParams.get('until');
  const sinceIso = since === null ? null : validAlertTime(since) ? new Date(since).toISOString() : null;
  const untilIso = until === null ? null : validAlertTime(until) ? new Date(until).toISOString() : null;
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw === null ? 20 : Number(limitRaw);
  if ((country !== null && !validAlertId(country)) || (theme !== null && !isAlertTheme(theme))
    || (severity !== null && !isAlertSeverity(severity)) || (since !== null && !validAlertTime(since))
    || (until !== null && !validAlertTime(until)) || (sinceIso && untilIso && sinceIso > untilIso)
    || !Number.isInteger(limit) || limit < 1 || limit > 50) return respond({ error: 'Invalid alert filter' }, 400);

  const clauses: string[] = [];
  const values: (string | number)[] = [];
  if (country !== null) { clauses.push('country_id=?'); values.push(country); }
  if (theme !== null) { clauses.push("json_extract(data_json,'$.theme')=?"); values.push(theme); }
  if (severity !== null) { clauses.push('severity=?'); values.push(severity); }
  if (sinceIso !== null) { clauses.push('updated_at>=?'); values.push(sinceIso); }
  if (untilIso !== null) { clauses.push('updated_at<=?'); values.push(untilIso); }
  const rows = (await env.DB.prepare(`SELECT id,name,country_id,severity,source_url,updated_at,data_json FROM alerts
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC,id DESC LIMIT ?`)
    .bind(...values, limit).all<AlertRow>()).results;
  const items: AlertFeedItem[] = rows.map(row => {
    let data: Record<string, unknown> = {};
    try { data = object(JSON.parse(row.data_json)); } catch { /* Old malformed rows keep a sourced shell. */ }
    return { id: row.id, title: row.name, theme: isAlertTheme(data.theme) ? data.theme : 'activity',
      severity: isAlertSeverity(row.severity) ? row.severity : 'info', observedAt: row.updated_at,
      countryId: row.country_id, sourceUrl: row.source_url,
      entityType: String(data.entityType ?? ''), entityId: String(data.entityId ?? ''),
      explanation: String(data.explanation ?? ''), verification: String(data.verification ?? 'observed-change'),
      before: data.before ?? null, after: data.after ?? null, rule: String(data.rule ?? '') };
  });
  return respond({ items, limit, filters: { country, theme, severity, since: sinceIso, until: untilIso },
    methodology: 'Deterministic rules over public captured changes. Observation times are not event start times; title matches are metadata only.' });
}
