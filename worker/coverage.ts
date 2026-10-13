import type { Env } from './types';

const number = (value: unknown) => Number(value ?? 0);
const param = (value: string | null, fallback: number, max: number) => {
  if (value === null) return fallback;
  const n = Number(value); if (!/^\d+$/.test(value) || n < 1 || n > max) throw new RangeError('Paginación no válida.'); return n;
};
export async function coverageData(env: Env, page = 1, limit = 30) {
  const now = new Date(), today = now.toISOString().slice(0, 10), hour = new Date(now.valueOf() - 3_600_000).toISOString();
  const results = await env.DB.batch<Record<string,unknown>>([
    env.DB.prepare(`SELECT COUNT(*) countries_total,SUM(s.country_id IS NOT NULL) countries_started,
      COALESCE(SUM(s.completed_sweeps>0),0) countries_completed,COALESCE(SUM(s.completed_sweeps),0) completed_sweeps
      FROM countries c LEFT JOIN player_census_state s ON s.country_id=c.id`),
    env.DB.prepare(`SELECT c.id,c.name,c.code,COALESCE(p.players_registered,0) players_registered,p.last_profile_at,
      COALESCE(s.records_observed,0) records_observed,COALESCE(s.completed_sweeps,0) completed_sweeps,s.last_scanned_at,s.next_run_at,
      CASE WHEN s.country_id IS NULL THEN 'pending' WHEN s.completed_sweeps>0 THEN 'completed' ELSE 'in-progress' END status
      FROM countries c LEFT JOIN player_census_state s ON s.country_id=c.id LEFT JOIN coverage_country_counts p ON p.country_id=c.id
      ORDER BY CASE WHEN s.country_id IS NULL THEN 0 WHEN s.completed_sweeps=0 THEN 1 ELSE 2 END,c.name,c.id LIMIT ? OFFSET ?`).bind(limit,(page-1)*limit),
    env.DB.prepare('SELECT id,record_count,status,last_success,last_error,interval_seconds,enabled FROM source_registry ORDER BY id'),
    env.DB.prepare('SELECT new_rows,updated_rows FROM ingestion_daily_stats WHERE day_key=? AND source_id=?').bind(today,'players'),
    env.DB.prepare(`SELECT COALESCE(SUM(records_count),0) processed,COUNT(*) runs,COALESCE(SUM(status='error'),0) errors
      FROM ingestion_runs WHERE source_id='players' AND started_at>=?`).bind(hour),
    env.DB.prepare('SELECT value FROM observability_config WHERE id=?').bind('change_counter_since'),
  ]);
  const totals=results[0].results[0],sources=results[2].results,stats=results[3].results[0],rate=results[4].results[0];
  return {summary:{players_registered:number(sources.find(row=>row.id==='players')?.record_count),
    countries_total:number(totals.countries_total),countries_started:number(totals.countries_started),countries_completed:number(totals.countries_completed),
    countries_pending:number(totals.countries_total)-number(totals.countries_completed),completed_sweeps:number(totals.completed_sweeps),
    countries_not_started:number(totals.countries_total)-number(totals.countries_started),countries_in_progress:number(totals.countries_started)-number(totals.countries_completed),
    rows_new_today:number(stats?.new_rows),rows_updated_today:number(stats?.updated_rows),profiles_per_hour:number(rate.processed),
    eta:null,player_total:null,active_player_total:null,methodology_since:results[5].results[0]?.value ?? null,
    coverage_denominator:'countries stored from verified discovery',errors_last_hour:number(rate.errors)},
    countries:results[1].results,page,total:number(totals.countries_total),limit,sources,timestamp:now.toISOString()};
}
export async function coverageRoute(request: Request, env: Env): Promise<Response | null> {
  const url=new URL(request.url);if(url.pathname!=='/api/coverage')return null;
  if(!['GET','HEAD'].includes(request.method))return Response.json({error:'Solo lectura.'},{status:405});
  try{return Response.json(await coverageData(env,param(url.searchParams.get('page'),1,10000),param(url.searchParams.get('limit'),30,50)));}
  catch(error){if(error instanceof RangeError)return Response.json({error:error.message},{status:400});throw error;}
}
