import { runSync } from './ingestion';
import { analysisRoute } from './analysis';
import { collectorRoute } from './collector';
import { coverageData, coverageRoute } from './coverage';
import { searchRoute } from './search';
import { historyRoute } from './history';
import { intelligenceRoute } from './intelligence';
import { alertsRoute } from './alerts';
import { aiRoute, aiStatus, reserveInference } from './ai';
import { runHistoryMaintenance } from './history-maintenance';
import { strategyRoute } from './strategy';
import { orderbookRoute } from './orderbook';
import { pressRoute } from './press';
import { AI_MODEL } from '../shared/ai';
import { INGESTION_DAILY_BUDGET, INGESTION_DAILY_READ_BUDGET } from '../shared/ingestion-config';
import { csrfValid, createSession, passwordMatches, sessionId, takeLimit } from './auth';
import { resourceTables, type Env } from './types';
import { parseImport, validateImport } from '../shared/import';

class HttpError extends Error { constructor(public status:number,message:string){super(message);} }
const privateHeaders = {'Cache-Control':'no-store'};
const json = (value:unknown,status=200,headers:HeadersInit={}) => Response.json(value,{status,headers});
const decodeRow = (value:unknown) => {
  const row=value as Record<string,unknown>;
  const {data_json,hash,...rest} = row;
  let data:unknown = {};
  try { data = JSON.parse(String(data_json ?? '{}')); } catch { /* corrupt external JSON stays isolated */ }
  return {...rest,data};
};
function integer(raw:string|null, fallback:number, min:number, max:number) {
  if(raw === null) return fallback;
  if(!/^\d+$/.test(raw) || Number(raw)<min || Number(raw)>max) throw new HttpError(400,'Parámetro numérico fuera de rango.');
  return Number(raw);
}
async function readLimited(request:Request,limit=1_048_576):Promise<Uint8Array> {
  if(Number(request.headers.get('Content-Length') ?? 0)>limit)throw new HttpError(413,'Archivo demasiado grande. Máximo 1 MB.');
  const reader=request.body?.getReader();if(!reader)return new Uint8Array();
  const chunks:Uint8Array[]=[],lengths:number[]=[];let total=0;
  while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>limit){await reader.cancel();throw new HttpError(413,'Máximo 1 MB.');}chunks.push(value);lengths.push(value.byteLength);}
  const data=new Uint8Array(total);let offset=0;for(let i=0;i<chunks.length;i++){data.set(chunks[i],offset);offset+=lengths[i];}return data;
}
async function body(request:Request):Promise<Record<string,unknown>> {
  const text = new TextDecoder().decode(await readLimited(request));
  try { const result = JSON.parse(text); if(!result || Array.isArray(result) || typeof result !== 'object') throw Error(); return result; }
  catch {throw new HttpError(400,'JSON inválido.');}
}
async function source(env:Env,id:string) {return env.DB.prepare('SELECT * FROM source_registry WHERE id=?').bind(id).first();}
async function status(env:Env) {
  const sources = await env.DB.prepare('SELECT * FROM source_registry ORDER BY id').all();
  const totals=Object.fromEntries(sources.results.filter(row=>String(row.id) in resourceTables).map(row=>[String(row.id),Number(row.record_count ?? 0)]));
  const day = new Date().toISOString().slice(0,10);
  const budget=await env.DB.prepare('SELECT reserved_writes,tick_count,reserved_reads,measured_reads,measured_writes,database_bytes FROM ingestion_budget WHERE day_key=?').bind(day).first<{reserved_writes:number;tick_count:number;reserved_reads:number;measured_reads:number;measured_writes:number;database_bytes:number|null}>();
  const reserved=budget?.reserved_writes ?? 0;
  const coverage=await env.DB.prepare(`SELECT COUNT(*) countries_started,SUM(completed_sweeps>0) countries_completed,SUM(records_observed) profiles_observed FROM player_census_state`).first();
  return {sources:sources.results,totals:totals ?? {},coverage,quota:{day,dailyBudget:INGESTION_DAILY_BUDGET,reserved,remaining:Math.max(0,INGESTION_DAILY_BUDGET-reserved),tickCount:budget?.tick_count ?? 0,
    dailyReadBudget:INGESTION_DAILY_READ_BUDGET,reservedReads:budget?.reserved_reads ?? 0,measuredReads:budget?.measured_reads ?? 0,measuredWrites:budget?.measured_writes ?? 0,databaseBytes:budget?.database_bytes ?? null,
    estimate:true,method:'Measured ingestion batch metadata plus reserves; API visitors, discarded read envelopes, legacy writes and other applications are not fully metered'},ai:await aiStatus(env),timestamp:new Date().toISOString()};
}
async function list(request:Request,env:Env,resource:keyof typeof resourceTables) {
  const params = new URL(request.url).searchParams;
  const limit = integer(params.get('limit'),20,1,50),page=integer(params.get('page'),1,1,10000);
  const q=(params.get('q') ?? '').trim();
  if(new TextEncoder().encode(q).length>40 || new TextEncoder().encode(q.replace(/[\\%_]/g,'\\$&')).length>46) throw new HttpError(400,'Búsqueda demasiado larga (máximo 40 bytes).');
  const country=params.get('country');
  const allowed=['name','updated_at',...(resource==='players'?['level','experience']:[]),...(resource==='articles'?['published_at']:[])];
  const sort=params.get('sort') ?? (resource==='articles'?'published_at':'name');
  if(!allowed.includes(sort)) throw new HttpError(400,'Ordenación no válida.');
  const order=params.get('order') ?? (sort==='name'?'asc':'desc');
  if(!['asc','desc'].includes(order)) throw new HttpError(400,'Dirección de ordenación no válida.');
  const clauses:string[]=[],values:unknown[]=[];
  if(q){clauses.push("name LIKE ? ESCAPE '\\'");values.push(`%${q.replace(/[\\%_]/g,'\\$&')}%`);}
  if(country){if(country.length>100)throw new HttpError(400,'País no válido.');clauses.push('country_id=?');values.push(country);}
  if(resource==='players') {
    for(const [param,column] of [['party','party_id'],['unit','military_unit_id']] as const){const value=params.get(param);if(value){if(value.length>100)throw new HttpError(400,'Identificador no válido.');clauses.push(`${column}=?`);values.push(value);}}
    if(params.has('minLevel')){clauses.push('level>=?');values.push(integer(params.get('minLevel'),0,0,10000));}
    if(params.has('maxLevel')){clauses.push('level<=?');values.push(integer(params.get('maxLevel'),10000,0,10000));}
    const activity=params.get('activity');if(activity){if(!['recent','inactive','unknown'].includes(activity))throw new HttpError(400,'Actividad no válida.');const cutoff=new Date(Date.now()-7*86400_000).toISOString();clauses.push(activity==='unknown'?'last_active_at IS NULL':`last_active_at IS NOT NULL AND last_active_at${activity==='recent'?'>=':'<'}?`);if(activity!=='unknown')values.push(cutoff);}
  }
  if(resource==='articles') {
    for(const [param,column] of [['language','language'],['author','author_id'],['category','category']] as const){const value=params.get(param);if(value){if(value.length>100)throw new HttpError(400,'Filtro no válido.');clauses.push(`${column}=?`);values.push(value);}}
    for(const [param,operator] of [['from','>='],['to','<=']] as const){const value=params.get(param);if(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value)))throw new HttpError(400,'Fecha no válida.');clauses.push(`published_at${operator}?`);values.push(`${value}T${param==='from'?'00:00:00.000':'23:59:59.999'}Z`);}}
  }
  const where=clauses.length ? ' WHERE '+clauses.join(' AND ') : '';
  const table=resourceTables[resource];
  const batch=await env.DB.batch([
    env.DB.prepare(`SELECT * FROM ${table}${where} ORDER BY ${sort} ${order},id LIMIT ? OFFSET ?`).bind(...values,limit,(page-1)*limit),
    where?env.DB.prepare(`SELECT COUNT(*) total FROM ${table}${where}`).bind(...values):env.DB.prepare('SELECT record_count total FROM source_registry WHERE id=?').bind(resource),
    env.DB.prepare('SELECT * FROM source_registry WHERE id=?').bind(resource)
  ]);
  return {items:batch[0].results.map(decodeRow),total:(batch[1].results[0] as {total:number}).total,page,limit,source:batch[2].results[0] ?? null};
}
async function detail(env:Env,resource:keyof typeof resourceTables,id:string) {
  if(id.length>100) throw new HttpError(400,'Identificador no válido.');
  const row=await env.DB.prepare(`SELECT * FROM ${resourceTables[resource]} WHERE id=?`).bind(id).first<Record<string,unknown>>();
  if(!row)throw new HttpError(404,'Entidad no encontrada en el censo recopilado.');
  let history:unknown[]=[];
  if(['players','battles','parties','military-units'].includes(resource)) {
    history=(await env.DB.prepare('SELECT * FROM entity_snapshots WHERE entity_type=? AND entity_id=? ORDER BY captured_at DESC LIMIT 90').bind(resource,id).all()).results.map(decodeRow);
  }
  return {item:decodeRow(row),history,source:await source(env,resource)};
}
async function admin(request:Request,env:Env,path:string) {
  if(request.method!=='GET' && !csrfValid(request)) throw new HttpError(403,'Protección CSRF: se requiere una petición del mismo origen.');
  if(path==='login' && request.method==='POST') {
    if(!env.ADMIN_PASSWORD_HASH || !env.SESSION_SECRET)throw new HttpError(503,'Configura ADMIN_PASSWORD_HASH y SESSION_SECRET en el servidor.');
    if(!await takeLimit(env,request,'login',5,900))throw new HttpError(429,'Demasiados intentos. Espera 15 minutos.');
    const input=await body(request);
    if(typeof input.password!=='string' || input.password.length>256 || !await passwordMatches(input.password,env.ADMIN_PASSWORD_HASH))throw new HttpError(401,'Credenciales incorrectas.');
    return json({ok:true},200,{'Set-Cookie':await createSession(env,request),...privateHeaders});
  }
  const id=await sessionId(env,request);
  if(!id)throw new HttpError(401,'Se requiere una sesión administrativa.');
  if(path==='logout' && request.method==='POST') {
    await env.DB.prepare('DELETE FROM admin_sessions WHERE id=?').bind(id).run();
    return json({ok:true},200,{'Set-Cookie':'wint_session=; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=0',...privateHeaders});
  }
  if(path==='status' && request.method==='GET') {
    const runs=await env.DB.prepare('SELECT * FROM ingestion_runs ORDER BY started_at DESC LIMIT 50').all();
    return json({...await status(env),runs:runs.results},200,privateHeaders);
  }
  if(path==='coverage' && request.method==='GET')return json(await coverageData(env),200,privateHeaders);
  if(path==='maintenance' && request.method==='POST')return json(await runHistoryMaintenance(env),200,privateHeaders);
  if(path==='ai/validate' && request.method==='POST') {
    if(!env.AI)throw new HttpError(503,'Binding de IA no disponible.');
    if(!await takeLimit(env,request,'ai-validate',3,3600))throw new HttpError(429,'Validación de IA limitada a tres por hora.');
    if(!await reserveInference(env,new Date()))throw new HttpError(429,'Presupuesto diario de IA agotado.');
    let output:unknown;
    try {output=await env.AI.run(AI_MODEL,{messages:[{role:'user',content:'Return only this JSON object: {"tool":"census"}'}],max_tokens:32,temperature:0});}
    catch(error){
      const reason=error instanceof Error?error.message:'Provider unavailable';
      const safeReason=reason.replace(/https?:\/\/\S+/g,'[provider URL]').replace(/Bearer\s+\S+/gi,'[redacted]').slice(0,240);
      return json({available:false,model:AI_MODEL,providerError:safeReason,checkedAt:new Date().toISOString()},503,privateHeaders);
    }
    const value=output && typeof output==='object'?(output as Record<string,unknown>).response:null;
    const text=typeof output==='string'?output:typeof value==='string'?value:value && typeof value==='object'?JSON.stringify(value):'';
    return json({available:text.includes('census'),model:AI_MODEL,responseKind:typeof value,checkedAt:new Date().toISOString(),maximumOutputTokens:32},200,privateHeaders);
  }
  if(path==='diagnostics' && request.method==='GET') {
    const migrationRows=await env.DB.prepare('SELECT name,applied_at FROM d1_migrations ORDER BY id DESC LIMIT 50').all();
    return json({migrations:migrationRows.results,backup:{method:'private SQL export verified in isolated SQLite',productionRestorePerformed:false},timestamp:new Date().toISOString()},200,privateHeaders);
  }
  if(path==='sync' && request.method==='POST') {
    if(!await takeLimit(env,request,'sync',10,600))throw new HttpError(429,'Resincronizaciones limitadas a 10 cada 10 minutos.');
    const input=await body(request);
    if(input.source !== undefined && typeof input.source!=='string') throw new HttpError(400,'Fuente inválida.');
    return json(await runSync(env,{source:input.source as string|undefined,force:true}),200,privateHeaders);
  }
  if(path.startsWith('sources/') && request.method==='PATCH') {
    const input=await body(request),sourceId=path.slice(8);
    if(typeof input.enabled!=='boolean' || !Number.isInteger(input.interval_seconds) || Number(input.interval_seconds)<120 || Number(input.interval_seconds)>86400)throw new HttpError(400,'Intervalo permitido: 120–86400 segundos.');
    const result=await env.DB.prepare('UPDATE source_registry SET enabled=?,interval_seconds=? WHERE id=?').bind(input.enabled?1:0,input.interval_seconds,sourceId).run();
    if(!result.meta.changes)throw new HttpError(404,'Fuente desconocida.');
    return json({ok:true},200,privateHeaders);
  }
  if(path==='import/preview' && request.method==='POST') {
    let input:Record<string,unknown>;
    if(request.headers.get('Content-Type')?.startsWith('multipart/form-data')) {
      const buffer=await readLimited(request,1_100_000);
      const form=await new Response(buffer as unknown as BodyInit,{headers:{'Content-Type':request.headers.get('Content-Type')!}}).formData();
      const file=form.get('file');
      if(!file || typeof file==='string')throw new HttpError(400,'Falta archivo.');
      const parsed=await parseImport(file.name,new Uint8Array(await file.arrayBuffer()));
      input={resource:form.get('resource'),records:parsed.records};
      if(parsed.errors.length)return json({...parsed,valid:false},200,privateHeaders);
    } else input=await body(request);
    const result=validateImport(String(input.resource),input.records as Record<string,unknown>[]);
    return json({...result,valid:result.errors.length===0},200,privateHeaders);
  }
  if((path==='import' || path==='import/commit') && request.method==='POST') {
    const input=await body(request),resource=String(input.resource);
    if(!['players','parties','military-units'].includes(resource) || !Array.isArray(input.records) || input.records.length>10)throw new HttpError(400,'Importa como máximo 10 registros por petición.');
    const result=validateImport(resource,input.records);
    if(result.errors.length)throw new HttpError(400,result.errors.join(' '));
    const table=resourceTables[resource as keyof typeof resourceTables],now=new Date().toISOString();
    const extraColumns=resource==='players'?['level','experience','last_active_at','party_id','military_unit_id']:resource==='parties'?['leader_id','member_count']:['leader_id','member_count','level'];
    const columns=['id','name','country_id','source_url','updated_at','first_seen','hash','data_json',...extraColumns];
    const statements=result.records.map((record:Record<string,unknown>)=>env.DB.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')}) ON CONFLICT(id) DO NOTHING`).bind(String(record.id),String(record.name),record.country_id ?? null,'import:administrator',now,now,'import',JSON.stringify(record),...extraColumns.map(column=>record[column] ?? null)));
    const results=statements.length?await env.DB.batch(statements):[];
    return json({ok:true,inserted:results.reduce((sum,r)=>sum+Number(r.meta.changes ?? 0),0),skipped:result.records.length-results.reduce((sum,r)=>sum+Number(r.meta.changes ?? 0),0)},200,privateHeaders);
  }
  throw new HttpError(404,'Ruta administrativa desconocida.');
}
async function route(request:Request,env:Env):Promise<Response> {
  const url=new URL(request.url),path=url.pathname;
  const collection=await collectorRoute(request,env);if(collection)return collection;
  if(path.startsWith('/api/admin/'))return admin(request,env,path.slice(11));
  if(path==='/api/ai/query' && request.method==='POST') {
    if(!csrfValid(request))throw new HttpError(403,'La consulta requiere el mismo origen y cabecera CSRF.');
    if(!(await aiStatus(env)).enabled)throw new HttpError(503,'La IA todavía está desactivada o no disponible.');
    if(!await takeLimit(env,request,'ai-hour',5,3600) || !await takeLimit(env,request,'ai-day',30,86400))throw new HttpError(429,'Límite de consultas de IA por visitante alcanzado.');
    return (await aiRoute(request,env))!;
  }
  if(request.method!=='GET' && request.method!=='HEAD')throw new HttpError(405,'La API pública es de solo lectura.');
  for(const handler of [coverageRoute,searchRoute,historyRoute,intelligenceRoute,alertsRoute,aiRoute,strategyRoute,orderbookRoute,pressRoute]){const response=await handler(request,env);if(response)return response;}
  const analysis=await analysisRoute(request,env);if(analysis)return analysis;
  if(path==='/api/health'){await env.DB.prepare('SELECT 1').first();return json({ok:true,service:'WINT',version:'0.1.0'});}
  if(path==='/api/status')return json(await status(env));
  if(path==='/api/dashboard/summary') {
    const base=await status(env);
    const [events,articles,battles,markets]=await Promise.all([
      env.DB.prepare('SELECT * FROM events ORDER BY updated_at DESC LIMIT 8').all(),
      env.DB.prepare('SELECT * FROM articles ORDER BY published_at DESC LIMIT 5').all(),
      env.DB.prepare('SELECT * FROM battles WHERE is_active=1 ORDER BY updated_at DESC LIMIT 5').all(),
      env.DB.prepare('SELECT p.*,i.name FROM market_prices p JOIN market_items i ON i.id=p.item_id WHERE p.captured_at=(SELECT MAX(captured_at) FROM market_prices WHERE item_id=p.item_id) LIMIT 12').all()
    ]);
    return json({...base,recentEvents:events.results.map(decodeRow),recentArticles:articles.results.map(decodeRow),activeBattles:battles.results.map(decodeRow),marketPrices:markets.results});
  }
  if(path==='/api/markets/prices') {
    const params=url.searchParams,limit=integer(params.get('limit'),20,1,50),page=integer(params.get('page'),1,1,10000),q=(params.get('q') ?? '').trim();
    if(new TextEncoder().encode(q).length>40)throw new HttpError(400,'Búsqueda demasiado larga.');
    const sort=params.get('sort') ?? 'name',order=params.get('order') ?? 'asc';
    if(!['name','price','captured_at'].includes(sort) || !['asc','desc'].includes(order))throw new HttpError(400,'Ordenación no válida.');
    const where=" WHERE p.id=(SELECT id FROM market_prices WHERE item_id=i.id ORDER BY captured_at DESC,id DESC LIMIT 1) AND i.name LIKE ? ESCAPE '\\'";
    const search=`%${q.replace(/[\\%_]/g,'\\$&')}%`;
    const batch=await env.DB.batch([
      env.DB.prepare(`SELECT p.*,i.name,p.item_id id FROM market_items i JOIN market_prices p ON p.item_id=i.id${where} ORDER BY ${sort==='name'?'i.name':`p.${sort}`} ${order},i.id LIMIT ? OFFSET ?`).bind(search,limit,(page-1)*limit),
      env.DB.prepare(`SELECT COUNT(*) total FROM market_items i JOIN market_prices p ON p.item_id=i.id${where}`).bind(search)
    ]);
    return json({items:batch[0].results,total:(batch[1].results[0] as {total:number}).total,page,limit,source:await source(env,'markets')});
  }
  if(path==='/api/markets/history') {
    const item=url.searchParams.get('item');if(!item || item.length>100)throw new HttpError(400,'Falta un identificador válido.');
    const items=await env.DB.prepare('SELECT price,captured_at FROM market_prices WHERE item_id=? ORDER BY captured_at DESC LIMIT 288').bind(item).all();
    return json({items:items.results.reverse(),source:await source(env,'markets')});
  }
  const match=path.match(/^\/api\/([a-z-]+)(?:\/([^/]+))?$/);
  if(match && match[1] in resourceTables) {
    const resource=match[1] as keyof typeof resourceTables;
    return json(match[2]?await detail(env,resource,decodeURIComponent(match[2])):await list(request,env,resource));
  }
  throw new HttpError(404,'Ruta no encontrada.');
}
function secure(response:Response) {
  const headers=new Headers(response.headers);
  headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','strict-origin-when-cross-origin');
  headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  return new Response(response.body,{status:response.status,headers});
}
export default {
  async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response> {
    if(!new URL(request.url).pathname.startsWith('/api/'))return secure(await env.ASSETS.fetch(request));
    const isPublic=['GET','HEAD'].includes(request.method) && !new URL(request.url).pathname.startsWith('/api/admin/') && !new URL(request.url).pathname.startsWith('/api/collector/');
    if(isPublic && env.PUBLIC_RATE_LIMITER) {
      const actor=request.headers.get('CF-Connecting-IP') ?? 'local-preview';
      if(!(await env.PUBLIC_RATE_LIMITER.limit({key:`wint-public:${actor}`})).success)return secure(json({error:'Demasiadas consultas. Espera un minuto.'},429,{'Retry-After':'60',...privateHeaders}));
    }
    const key=new Request(request.url,{method:'GET'});
    const edgeCache=await caches.open('wint-public');
    if(isPublic){const cached=await edgeCache.match(key);if(cached)return secure(cached);}
    let response:Response;
    try {response=await route(request,env);}
    catch(error){const code=error instanceof HttpError?error.status:503;response=json({error:error instanceof HttpError?error.message:'Base de datos no disponible. Comprueba las migraciones y el panel de sincronización.'},code,privateHeaders);if(!(error instanceof HttpError)) console.error('wint_request_failed',{path:new URL(request.url).pathname,error:error instanceof Error?error.name:'unknown'});}
    if(isPublic && response.ok){response.headers.set('Cache-Control','public, max-age=60, s-maxage=90');ctx.waitUntil(edgeCache.put(key,response.clone()));}
    return secure(response);
  },
  async scheduled(event:ScheduledController,env:Env,ctx:ExecutionContext) {
    if(env.SYNC_ENABLED!=='false') {
      if(Math.floor(event.scheduledTime/60000)%10===0)ctx.waitUntil(runHistoryMaintenance(env).then(result=>{console.info('wint_history_maintenance',result);}));
      else ctx.waitUntil(runSync(env).then(result=>{console.info('wint_scheduled_sync',{status:result.status,source:result.source,processed:result.processed});}));
    }
  }
} satisfies ExportedHandler<Env>;
