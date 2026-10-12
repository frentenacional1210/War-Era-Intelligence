import {afterEach,describe,expect,it,vi} from 'vitest';
import {createTestDB} from './sqlite-d1';
import {runSync} from '../worker/ingestion';
import type {Env} from '../worker/types';
import {PLAYER_ROWS} from '../shared/ingestion-config';
import {collectorRoute} from '../worker/collector';

afterEach(()=>vi.unstubAllGlobals());
const setup=()=>{
  const store=createTestDB();
  store.sqlite.exec(`INSERT INTO countries(id,name,code,source_url,updated_at,first_seen,hash,data_json) VALUES
    ('es','Spain','es','https://example.test','2026-01-01','2026-01-01','a','{}'),
    ('fr','France','fr','https://example.test','2026-01-01','2026-01-01','b','{}')`);
  return {...store,env:{DB:store.db} as Env};
};
describe('throughput with real SQLite migrations and cursor transactions',()=>{
  it('commits compact public pages through the real collector and ingestion without any upstream network request',async()=>{
    const store=setup(),secret='test-collector-secret-only-not-production';
    store.env.COLLECTOR_SECRET=secret;
    const network=vi.fn(()=>{throw new Error('Collector commit must not fetch upstream');});vi.stubGlobal('fetch',network);
    const call=(path:string,payload:unknown)=>collectorRoute(new Request(`https://wint.test/api/collector/${path}`,{method:'POST',headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},body:JSON.stringify(payload)}),store.env);
    try{
      const plan=await (await call('plan',{source:'players'}))!.json() as {cursorExpected:string|null;inputs:Record<string,unknown>};
      const refs=Array.from({length:PLAYER_ROWS},(_,i)=>({_id:`user-${i}`}));
      const response=await call('commit',{source:'players',cursorExpected:plan.cursorExpected,input:plan.inputs,page:{items:refs,nextCursor:'next'},profiles:refs.map(ref=>({...ref,username:ref._id,country:'es',leveling:{level:1},secret:'omit'}))});
      expect(await response!.json()).toMatchObject({status:'ok',processed:PLAYER_ROWS,changed:PLAYER_ROWS});
      const articlePlan=await (await call('plan',{source:'articles'}))!.json() as {cursorExpected:string|null;inputs:Record<string,unknown>};
      const articleResponse=await call('commit',{source:'articles',cursorExpected:articlePlan.cursorExpected,input:articlePlan.inputs,page:{items:[{_id:'public',title:'Public',isPublic:true,isPublished:true,content:'omit body'},{_id:'private',isPublic:false}],nextCursor:'older'}});
      expect(await articleResponse!.json()).toMatchObject({status:'ok',processed:1,changed:1});
      expect(store.sqlite.prepare('SELECT COUNT(*) count FROM articles').get()?.count).toBe(1);
      expect(JSON.stringify(store.sqlite.prepare('SELECT data_json FROM players').all())).not.toContain('omit');
      expect(network).not.toHaveBeenCalled();
      const stale=await call('commit',{source:'players',cursorExpected:null,input:plan.inputs,page:{items:refs,nextCursor:'next'},profiles:refs.map(ref=>({...ref,username:ref._id}))});
      expect(stale!.status).toBe(409);
    }finally{store.sqlite.close();}
  });
  it('batches profiles, rotates countries, preserves their independent cursors and refunds unused quota',async()=>{
    const store=setup(),calls:{procedure:string;country?:string;cursor?:string}[]=[];
    vi.stubGlobal('fetch',vi.fn(async(input:string,init?:RequestInit)=>{
      const url=new URL(input),procedure=url.pathname.split('/').at(-1)!;
      if(init?.method==='POST'){
        expect(url.searchParams.get('batch')).toBe('1');
        const batch=JSON.parse(String(init.body)) as Record<string,{userId:string}>;
        return Response.json(Object.values(batch).map(({userId})=>({result:{data:{_id:userId,username:userId,country:userId.split('-')[0],leveling:{level:5,totalXp:100}}}})));
      }
      const query=JSON.parse(url.searchParams.get('input')!);
      calls.push({procedure,country:query.countryId,cursor:query.cursor});
      return Response.json({result:{data:{items:Array.from({length:PLAYER_ROWS},(_,i)=>({_id:`${query.countryId}-${query.cursor?'second':'first'}-${i}`})),nextCursor:`${query.countryId}-${query.cursor?'end':'next'}`}}});
    }));
    try{
      for(let i=0;i<3;i++)expect(await runSync(store.env,{source:'players',force:true})).toMatchObject({status:'ok',processed:PLAYER_ROWS,changed:PLAYER_ROWS});
      expect(calls.map(call=>call.country)).toEqual(['es','fr','es']);
      expect(calls[2].cursor).toBe('es-next');
      expect(store.sqlite.prepare('SELECT COUNT(*) count FROM players').get()?.count).toBe(PLAYER_ROWS*3);
      const budget=store.sqlite.prepare('SELECT reserved_writes FROM ingestion_budget').get();
      expect(Number(budget?.reserved_writes)).toBeLessThan(220*3);
      expect(Number(budget?.reserved_writes)).toBeGreaterThan(0);
      expect(store.sqlite.prepare("SELECT rows_written FROM ingestion_runs LIMIT 1").get()?.rows_written).toBeGreaterThan(0);
    }finally{store.sqlite.close();}
  });
  it('continues an article archive beyond the old 20-page ceiling, refreshes the head without losing progress and excludes unknown visibility',async()=>{
    const store=setup(),tokens:unknown[]=[];
    store.sqlite.prepare("UPDATE ingestion_cursors SET cursor=? WHERE source_id='articles'").run(JSON.stringify({token:'old-page-20',pages:20}));
    vi.stubGlobal('fetch',vi.fn(async(input:string)=>{
      const query=JSON.parse(new URL(input).searchParams.get('input')!);tokens.push(query.cursor);
      return Response.json({result:{data:{items:[{_id:query.cursor?'archive':'head',title:'Public',isPublic:true,isPublished:true,content:'do not persist'},
        {_id:'unknown',title:'Unknown'},{_id:'private',title:'Private',isPublic:false,isPublished:true}],nextCursor:query.cursor==='old-page-20'?'old-page-21':'old-page-22'}}});
    }));
    try{
      expect(await runSync(store.env,{source:'articles',force:true})).toMatchObject({status:'ok',processed:1});
      let cursor=JSON.parse(String(store.sqlite.prepare("SELECT cursor FROM ingestion_cursors WHERE source_id='articles'").get()?.cursor));
      expect(cursor.archiveToken).toBe('old-page-21');
      cursor.headNextAt='1970-01-01T00:00:00.000Z';
      store.sqlite.prepare("UPDATE ingestion_cursors SET cursor=? WHERE source_id='articles'").run(JSON.stringify(cursor));
      expect(await runSync(store.env,{source:'articles',force:true})).toMatchObject({status:'ok',processed:1});
      cursor=JSON.parse(String(store.sqlite.prepare("SELECT cursor FROM ingestion_cursors WHERE source_id='articles'").get()?.cursor));
      expect(cursor.archiveToken).toBe('old-page-21');
      expect(tokens).toEqual(['old-page-20',undefined]);
      const rows=store.sqlite.prepare('SELECT id,data_json FROM articles ORDER BY id').all();
      expect(rows.map(row=>row.id)).toEqual(['archive','head']);
      expect(JSON.stringify(rows)).not.toContain('do not persist');
    }finally{store.sqlite.close();}
  });
  it('rejects a mismatched batch atomically without skipping its country page',async()=>{
    const store=setup();
    vi.stubGlobal('fetch',vi.fn(async(_input:string,init?:RequestInit)=>init?.method==='POST'
      ? Response.json([{result:{data:{_id:'wrong',username:'Wrong'}}}])
      : Response.json({result:{data:{items:[{_id:'expected'}],nextCursor:'next'}}})));
    try{
      expect(await runSync(store.env,{source:'players',force:true})).toMatchObject({status:'error'});
      expect(store.sqlite.prepare('SELECT COUNT(*) count FROM players').get()?.count).toBe(0);
      expect(store.sqlite.prepare('SELECT COUNT(*) count FROM player_census_state').get()?.count).toBe(0);
      expect(store.sqlite.prepare("SELECT cursor FROM ingestion_cursors WHERE source_id='players'").get()?.cursor).toBeNull();
    }finally{store.sqlite.close();}
  });
  it('rejects cyclic and empty article continuations without erasing the archive cursor',async()=>{
    const store=setup();
    const cursor=JSON.stringify({archiveToken:'B',recentTokens:['A'],headNextAt:'2099-01-01T00:00:00.000Z'});
    store.sqlite.prepare("UPDATE ingestion_cursors SET cursor=? WHERE source_id='articles'").run(cursor);
    const fetcher=vi.fn(async()=>Response.json({result:{data:{items:[{_id:'a',title:'Public',isPublic:true,isPublished:true}],nextCursor:'A'}}}));
    vi.stubGlobal('fetch',fetcher);
    try{
      expect(await runSync(store.env,{source:'articles',force:true})).toMatchObject({status:'error'});
      fetcher.mockImplementationOnce(async()=>Response.json({result:{data:{items:[],nextCursor:'C'}}}));
      expect(await runSync(store.env,{source:'articles',force:true})).toMatchObject({status:'error'});
      expect(store.sqlite.prepare("SELECT cursor FROM ingestion_cursors WHERE source_id='articles'").get()?.cursor).toBe(cursor);
      expect(store.sqlite.prepare('SELECT COUNT(*) count FROM articles').get()?.count).toBe(0);
    }finally{store.sqlite.close();}
  });
  it('does not advance a country checkpoint or overwrite another owner after losing the lease',async()=>{
    const store=setup();
    const original=store.db.batch.bind(store.db);
    store.env.DB={...store.db,batch:async(statements:D1PreparedStatement[])=>{
      if((statements[0] as unknown as {_sql:string})._sql.startsWith('INSERT INTO player_census_state')){
        store.sqlite.exec("UPDATE ingestion_lock SET owner='new-owner'; UPDATE source_registry SET status='new-owner-status' WHERE id='players'");
      }
      return original(statements);
    }} as D1Database;
    vi.stubGlobal('fetch',vi.fn(async(_input:string,init?:RequestInit)=>init?.method==='POST'
      ? Response.json([{result:{data:{_id:'expected',username:'Expected'}}}])
      : Response.json({result:{data:{items:[{_id:'expected'}],nextCursor:'next'}}})));
    try{
      expect(await runSync(store.env,{source:'players',force:true})).toMatchObject({status:'error'});
      expect(store.sqlite.prepare('SELECT COUNT(*) count FROM player_census_state').get()?.count).toBe(0);
      expect(store.sqlite.prepare("SELECT cursor FROM ingestion_cursors WHERE source_id='players'").get()?.cursor).toBeNull();
      expect(store.sqlite.prepare("SELECT status FROM source_registry WHERE id='players'").get()?.status).toBe('new-owner-status');
      expect(store.sqlite.prepare('SELECT owner FROM ingestion_lock').get()?.owner).toBe('new-owner');
    }finally{store.sqlite.close();}
  });
});
