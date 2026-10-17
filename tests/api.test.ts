import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {pbkdf2Sync} from 'node:crypto';
import worker from '../worker/index';
import type {Env} from '../worker/types';
import {createTestDB} from './sqlite-d1';
vi.mock('../worker/ingestion',()=>({runSync:vi.fn(async()=>({status:'completed'}))}));
let env:Env,store:ReturnType<typeof createTestDB>;
const ctx={waitUntil:vi.fn((p:Promise<unknown>)=>p.catch(()=>{}))} as unknown as ExecutionContext;
async function call(path:string,init:RequestInit={}){return worker.fetch(new Request(`https://wint.test${path}`,init),env,ctx);}
beforeEach(()=>{
  store=createTestDB();
  env={DB:store.db,ASSETS:{fetch:async()=>new Response('assets')} as unknown as Fetcher,SESSION_SECRET:'test-session-secret-never-production',ADMIN_PASSWORD_HASH:`pbkdf2$100000$${Buffer.from('test-salt').toString('base64')}$${pbkdf2Sync('test-long-password',Buffer.from('test-salt'),100000,32,'sha256').toString('base64')}`};
  vi.stubGlobal('caches',{open:async()=>({match:async()=>undefined,put:async()=>undefined})});
  store.sqlite.exec(`INSERT INTO players(id,name,country_id,level,experience,source_url,updated_at,first_seen,hash,data_json) VALUES ('test-1','Zulu','es',5,100,'https://warera.io/user/test-1','2026-10-11','2026-10-11','a','{}'),('test-2','Alpha','fr',10,200,'https://warera.io/user/test-2','2026-10-11','2026-10-11','b','{}')`);
});
afterEach(()=>{store.sqlite.close();vi.unstubAllGlobals();});
describe('public D1 API and administrative isolation',()=>{
  it('applies migrations, filters and pagination without upstream calls',async()=>{
    const response=await call('/api/players?country=es&sort=level&limit=1');
    expect(response.status).toBe(200);const data=await response.json() as {items:{id:string}[];total:number};
    expect(data.items[0].id).toBe('test-1');expect(data.total).toBe(1);
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });
  it('rejects SQL identifiers, oversized pages and write methods',async()=>{
    expect((await call('/api/players?sort=name%3BDROP%20TABLE%20players')).status).toBe(400);
    expect((await call('/api/players?limit=999')).status).toBe(400);
    expect((await call('/api/players',{method:'POST',body:'{}'})).status).toBe(405);
    expect((await call('/api/players?q=%25')).status).toBe(200);
    expect(store.sqlite.prepare('SELECT COUNT(*) total FROM players').get()?.total).toBe(2);
  });
  it('refuses anonymous administration and cross origin CSRF',async()=>{
    expect((await call('/api/admin/status')).status).toBe(401);
    expect((await call('/api/admin/sync',{method:'POST',body:'{}'})).status).toBe(403);
    expect((await call('/api/admin/login',{method:'POST',headers:{'X-WINT-CSRF':'1',Origin:'https://evil.example'},body:'{}'})).status).toBe(403);
  });
  it('keeps public AI disabled before actor writes and enforces its CSRF boundary',async()=>{
    expect((await call('/api/ai/query',{method:'POST',headers:{'X-WINT-CSRF':'1',Origin:'https://evil.example'},body:'{"question":"censo"}'})).status).toBe(403);
    expect((await call('/api/ai/query',{method:'POST',headers:{'X-WINT-CSRF':'1'},body:'{"question":"censo"}'})).status).toBe(503);
    expect(store.sqlite.prepare('SELECT COUNT(*) n FROM request_limits').get()?.n).toBe(0);
    expect(store.sqlite.prepare('SELECT COUNT(*) n FROM ai_daily_budget').get()?.n).toBe(0);
    expect((await call('/api/ai/tools')).status).toBe(200);
  });
  it('reserves the global neuron budget before the admin model-validation probe',async()=>{
    let calls=0;
    env.AI={run:async(_model,input)=>{
      calls++;
      expect(input).toMatchObject({max_tokens:32});
      expect(store.sqlite.prepare('SELECT reserved_neurons FROM ai_daily_budget').get()?.reserved_neurons).toBe(120*calls);
      return {response:{tool:'census'}};
    }};
    const login=await call('/api/admin/login',{method:'POST',headers:{'X-WINT-CSRF':'1'},body:JSON.stringify({password:'test-long-password'})});
    expect(login.status).toBe(200);
    const headers={Cookie:login.headers.get('Set-Cookie')!.split(';')[0],'X-WINT-CSRF':'1'};
    for(let i=0;i<3;i++){
      const result=await call('/api/admin/ai/validate',{method:'POST',headers});
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({available:true,responseKind:'object'});
    }
    expect(calls).toBe(3);
    expect((await call('/api/admin/ai/validate',{method:'POST',headers})).status).toBe(429);
    expect(calls).toBe(3);
    expect(store.sqlite.prepare('SELECT request_count FROM ai_daily_budget').get()?.request_count).toBe(3);
    expect(store.sqlite.prepare('SELECT reserved_neurons FROM ai_daily_budget').get()?.reserved_neurons).toBe(360);
  });
  it('returns a bounded provider failure without leaking an upstream URL or bearer token',async()=>{
    env.AI={run:async()=>{throw Error('Rejected at https://provider.test/private?token=secret Bearer super-secret');}};
    const login=await call('/api/admin/login',{method:'POST',headers:{'X-WINT-CSRF':'1'},body:JSON.stringify({password:'test-long-password'})});
    const headers={Cookie:login.headers.get('Set-Cookie')!.split(';')[0],'X-WINT-CSRF':'1'};
    const result=await call('/api/admin/ai/validate',{method:'POST',headers});
    expect(result.status).toBe(503);
    const value=await result.json() as {available:boolean;providerError:string};
    expect(value.available).toBe(false);
    expect(value.providerError).toContain('[provider URL]');
    expect(value.providerError).not.toMatch(/provider\.test|super-secret|token=secret/);
    expect(store.sqlite.prepare('SELECT reserved_neurons FROM ai_daily_budget').get()?.reserved_neurons).toBe(120);
  });
  it('creates protected sessions and revokes logout',async()=>{
    const response=await call('/api/admin/login',{method:'POST',headers:{'X-WINT-CSRF':'1'},body:JSON.stringify({password:'test-long-password'})});
    expect(response.status).toBe(200);
    const cookie=response.headers.get('Set-Cookie')!;expect(cookie).toContain('HttpOnly');expect(cookie).toContain('Secure');
    const headers={Cookie:cookie.split(';')[0],'X-WINT-CSRF':'1'};
    const admin=await call('/api/admin/status',{headers});
    expect(admin.status).toBe(200);
    expect((await admin.json() as {writeUsage:{day:string;bySource:unknown[]}}).writeUsage).toMatchObject({day:expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),bySource:expect.any(Array)});
    expect((await call('/api/admin/logout',{method:'POST',headers})).status).toBe(200);
    expect((await call('/api/admin/status',{headers})).status).toBe(401);
  });
  it('caps persistent login attempts',async()=>{
    for(let i=0;i<5;i++)expect((await call('/api/admin/login',{method:'POST',headers:{'X-WINT-CSRF':'1'},body:'{"password":"wrong"}'})).status).toBe(401);
    expect((await call('/api/admin/login',{method:'POST',headers:{'X-WINT-CSRF':'1'},body:'{"password":"wrong"}'})).status).toBe(429);
  });
  it('imports typed public fields for filtering and never overwrites existing players',async()=>{
    const login=await call('/api/admin/login',{method:'POST',headers:{'X-WINT-CSRF':'1'},body:JSON.stringify({password:'test-long-password'})});
    const headers={Cookie:login.headers.get('Set-Cookie')!.split(';')[0],'X-WINT-CSRF':'1'};
    const records=[{id:'imported',name:'Imported',countryId:'es',leveling:{level:22,totalXp:800},party:'p1',mu:'m1'},{id:'test-1',name:'Replaced',level:99}];
    const response=await call('/api/admin/import',{method:'POST',headers,body:JSON.stringify({resource:'players',records})});
    expect(await response.json()).toMatchObject({inserted:1,skipped:1});
    const data=await (await call('/api/players?country=es&sort=level&order=desc')).json() as {items:{id:string;level:number;experience:number;party_id:string;military_unit_id:string}[]};
    expect(data.items[0]).toMatchObject({id:'imported',level:22,experience:800,party_id:'p1',military_unit_id:'m1'});
    expect(store.sqlite.prepare("SELECT name FROM players WHERE id='test-1'").get()?.name).toBe('Zulu');
  });
  it('fails closed when secrets are absent',async()=>{
    delete env.SESSION_SECRET;
    expect((await call('/api/admin/login',{method:'POST',headers:{'X-WINT-CSRF':'1'},body:'{}'})).status).toBe(503);
  });
});
