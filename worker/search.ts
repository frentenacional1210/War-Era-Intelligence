import type { Env } from './types';
const tables = {players:'players',parties:'parties','military-units':'military_units',countries:'countries',regions:'regions',articles:'articles',battles:'battles'};
export async function searchRoute(request:Request,env:Env):Promise<Response|null> {
  const url=new URL(request.url);if(url.pathname!=='/api/search')return null;
  if(!['GET','HEAD'].includes(request.method))return Response.json({error:'Solo lectura.'},{status:405});
  const q=(url.searchParams.get('q') ?? '').trim(),rawLimit=url.searchParams.get('limit') ?? '30',limit=Number(rawLimit);
  // D1's LIKE pattern itself is limited to 50 bytes, including escape characters.
  const escaped=q.replace(/[\\%_]/g,'\\$&'),pattern=`%${escaped}%`;
  if(q.length<2 || new TextEncoder().encode(q).length>40 || new TextEncoder().encode(pattern).length>48 || !/^\d+$/.test(rawLimit) || limit<1 || limit>30)
    return Response.json({error:'Busca al menos dos caracteres y como máximo 40 bytes; límite 1–30.'},{status:400});
  const result=await env.DB.batch<Record<string,unknown>>(Object.entries(tables).map(([resource,table])=>env.DB.prepare(`SELECT ? resource,id,name,source_url,updated_at FROM ${table} WHERE name LIKE ? ESCAPE '\\' OR id=? ORDER BY name,id LIMIT ?`).bind(resource,pattern,q,Math.max(3,Math.ceil(limit/7)))));
  const items=result.flatMap(row=>row.results).sort((a,b)=>String(a.name).localeCompare(String(b.name))).slice(0,limit);
  return Response.json({items,timestamp:new Date().toISOString(),methodology:'public names and exact game IDs; no external identity matching'});
}
