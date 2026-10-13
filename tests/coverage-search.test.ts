import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {createTestDB} from './sqlite-d1';
import {coverageRoute} from '../worker/coverage';
import {searchRoute} from '../worker/search';
import {strategyRoute} from '../worker/strategy';
import type {Env} from '../worker/types';

let store:ReturnType<typeof createTestDB>;
let env:Env;
const at='2026-10-12T12:00:00.000Z';
function entity(table:string,id:string,name:string,countryId:string|null=null) {
  store.sqlite.prepare(`INSERT INTO ${table}(id,name,country_id,source_url,updated_at,first_seen,hash,data_json) VALUES(?,?,?,?,?,?,?,?)`)
    .run(id,name,countryId,`https://warera.io/${table}/${id}`,at,at,`hash-${id}`,'{}');
}
async function get<T>(handler:(request:Request,env:Env)=>Promise<Response|null>,path:string):Promise<{status:number;data:T}> {
  const response=await handler(new Request(`https://wint.test${path}`),env);
  if(!response)throw Error('Route did not match');
  return {status:response.status,data:await response.json() as T};
}
beforeEach(()=>{store=createTestDB();env={DB:store.db,ASSETS:{fetch:async()=>new Response()} as unknown as Fetcher};});
afterEach(()=>store.sqlite.close());

describe('coverage, search and strategic bounds on migrated SQLite',()=>{
  it('distinguishes untouched, in-progress and completed countries, and counts changed hashes',async()=>{
    entity('countries','es','España');entity('countries','fr','France');entity('countries','de','Deutschland');
    entity('players','p1','Ana','es');entity('players','p2','Berta','fr');
    store.sqlite.prepare('UPDATE source_registry SET record_count=2 WHERE id=?').run('players');
    store.sqlite.prepare('INSERT INTO player_census_state(country_id,next_run_at,last_scanned_at,records_observed,completed_sweeps) VALUES(?,?,?,?,?)')
      .run('es',at,at,1,1);
    store.sqlite.prepare('INSERT INTO player_census_state(country_id,next_run_at,last_scanned_at,records_observed,completed_sweeps) VALUES(?,?,?,?,?)')
      .run('fr',at,at,1,0);
    store.sqlite.prepare('UPDATE players SET name=?,hash=?,updated_at=? WHERE id=?').run('Ana nueva','hash-p1-v2',at,'p1');
    type Coverage={summary:{countries_total:number;countries_started:number;countries_completed:number;countries_pending:number;countries_not_started:number;countries_in_progress:number;players_registered:number;rows_new_today:number;rows_updated_today:number};countries:{id:string;status:string;players_registered:number}[]};
    const {status,data}=await get<Coverage>(coverageRoute,'/api/coverage?limit=3');
    expect(status).toBe(200);
    expect(data.summary).toMatchObject({countries_total:3,countries_started:2,countries_completed:1,countries_pending:2,countries_not_started:1,countries_in_progress:1,players_registered:2});
    expect(Object.fromEntries(data.countries.map(c=>[c.id,[c.status,c.players_registered]]))).toMatchObject({de:['pending',0],fr:['in-progress',1],es:['completed',1]});
    const today=new Date().toISOString().slice(0,10);
    const stats=store.sqlite.prepare('SELECT new_rows,updated_rows FROM ingestion_daily_stats WHERE day_key=? AND source_id=?').get(today,'players') as {new_rows:number;updated_rows:number};
    expect(stats).toMatchObject({new_rows:2,updated_rows:1});
  });

  it('searches literal wildcard characters and exact IDs without SQL interpretation',async()=>{
    entity('players','id-%-1','Ana%');entity('players','id-2','AnaX');entity('parties','party-1','Ana_');
    type Search={items:{id:string;resource:string}[]};
    expect((await get<Search>(searchRoute,'/api/search?q=Ana%25')).data.items.map(i=>i.id)).toEqual(['id-%-1']);
    expect((await get<Search>(searchRoute,'/api/search?q=Ana_')).data.items.map(i=>i.id)).toEqual(['party-1']);
    expect((await get<Search>(searchRoute,'/api/search?q=id-%25-1')).data.items.map(i=>i.id)).toEqual(['id-%-1']);
    expect((await get<Search>(searchRoute,'/api/search?q=%27%20OR%201%3D1--')).data.items).toEqual([]);
    expect((await get<Search>(searchRoute,`/api/search?q=${encodeURIComponent('ñ'.repeat(21))}`)).status).toBe(400);
  });

  it('bounds strategy by captured country and uses country-leading indexes',async()=>{
    entity('countries','es','España');entity('countries','fr','France');
    entity('companies','co-es','Empresa española','es');entity('companies','co-fr','Entreprise française','fr');
    entity('battles','b-es','Batalla','es');
    expect((await get<{industry:{companiesCaptured:number}}>(strategyRoute,'/api/strategy?country=es')).data.industry.companiesCaptured).toBe(1);
    expect((await get<unknown>(strategyRoute,'/api/strategy?country=unknown')).status).toBe(404);
    for(const [sql,index] of [
      ['SELECT COUNT(*) FROM companies WHERE country_id=?','idx_companies_country'],
      ['SELECT COUNT(*) FROM battles WHERE country_id=? AND is_active=1','idx_battles_country_active'],
      ['SELECT id FROM events WHERE country_id=? ORDER BY updated_at DESC LIMIT 12','idx_events_country_time'],
      ['SELECT id FROM articles WHERE country_id=? ORDER BY published_at DESC LIMIT 12','idx_articles_country_published'],
    ]){
      const plan=store.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('es').map(row=>String(row.detail)).join(' ');
      expect(plan).toContain(index);
    }
  });
});
