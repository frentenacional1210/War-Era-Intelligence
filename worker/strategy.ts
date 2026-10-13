import type { Env } from './types';

/** Descriptive cross-domain report. No causal or predictive score is inferred. */
export async function strategyRoute(request:Request,env:Env):Promise<Response|null> {
  const url=new URL(request.url);
  if(url.pathname!=='/api/strategy')return null;
  if(!['GET','HEAD'].includes(request.method))return Response.json({error:'Method not allowed'}, {status:405});
  const id=url.searchParams.get('country');
  if(!id || id.length>100 || /[\u0000-\u001f]/.test(id))return Response.json({error:'Invalid country'}, {status:400});
  const country=await env.DB.prepare('SELECT id,name,source_url sourceUrl,updated_at updatedAt FROM countries WHERE id=?').bind(id).first();
  if(!country)return Response.json({error:'Country not captured'}, {status:404});
  const results=await env.DB.batch<Record<string,unknown>>([
    env.DB.prepare(`SELECT COALESCE(cc.players_registered,0) registeredPlayers,cc.last_profile_at lastProfileAt,COALESCE(s.completed_sweeps,0) completedSweeps,s.last_scanned_at lastScannedAt FROM countries c LEFT JOIN coverage_country_counts cc ON cc.country_id=c.id LEFT JOIN player_census_state s ON s.country_id=c.id WHERE c.id=?`).bind(id),
    env.DB.prepare(`SELECT (SELECT COUNT(*) FROM governments WHERE country_id=?) governmentCount,(SELECT COUNT(*) FROM elections WHERE country_id=?) electionsCaptured,(SELECT COUNT(*) FROM parties WHERE country_id=?) partiesCaptured`).bind(id,id,id),
    env.DB.prepare(`SELECT (SELECT COUNT(*) FROM military_units WHERE country_id=?) unitsCaptured,(SELECT COUNT(*) FROM battles WHERE country_id=? AND is_active=1) activeBattlesCaptured`).bind(id,id),
    env.DB.prepare('SELECT COUNT(*) companiesCaptured FROM companies WHERE country_id=?').bind(id),
    env.DB.prepare(`SELECT id,name,json_extract(data_json,'$.theme') theme,json_extract(data_json,'$.severity') severity,updated_at updatedAt,source_url sourceUrl FROM events WHERE country_id=? ORDER BY updated_at DESC,id DESC LIMIT 12`).bind(id),
    env.DB.prepare('SELECT id,name,published_at publishedAt,source_url sourceUrl FROM articles WHERE country_id=? ORDER BY published_at DESC,id LIMIT 12').bind(id),
    env.DB.prepare(`SELECT id,last_success lastSuccess,status FROM source_registry WHERE id IN ('countries','players','parties','military-units','battles','articles','markets','companies','elections','governments') ORDER BY id`),
  ]);
  const coverage=results[0].results[0] ?? {},politics=results[1].results[0] ?? {};
  const missing=['No reliable global player denominator or active-player census.','Company country attribution is used only when explicitly supplied.','No measured causal relationship, battle participants, national liquidity or forecast.'];
  if(!Number(coverage.completedSweeps ?? 0))missing.push('First player sweep for this country is incomplete.');
  if(!Number(politics.governmentCount ?? 0))missing.push('Government has not been captured for this country.');
  return Response.json({country,coverage,politics,military:results[2].results[0],industry:{...results[3].results[0],companyCountryAttribution:'explicit-only'},events:results[4].results,press:results[5].results,freshness:results[6].results,missing,methodology:'Descriptive counts of captured public records; absence is unknown. Battle country is the defender. Prices are global, not country liquidity.'});
}
