import {afterEach,describe,expect,it,vi} from 'vitest';
import {createTestDB} from './sqlite-d1';
import {runSync} from '../worker/ingestion';
import type {Env} from '../worker/types';
import {COLLECTOR_HANDOFF_SECONDS,PLAYER_ROWS} from '../shared/ingestion-config';

afterEach(()=>vi.unstubAllGlobals());
const fullReservation=140+PLAYER_ROWS*70;
const setup=()=>{
  const store=createTestDB();
  store.sqlite.exec(`INSERT INTO countries(id,name,code,source_url,updated_at,first_seen,hash,data_json) VALUES
    ('es','Spain','es','https://example.test','2026-01-01','2026-01-01','a','{}')`);
  return {...store,env:{DB:store.db} as Env};
};
const budget=(store:ReturnType<typeof setup>)=>store.sqlite.prepare('SELECT reserved_writes,measured_writes FROM ingestion_budget').get() as {reserved_writes:number;measured_writes:number};
const profiles=()=>vi.fn(async(input:string,init?:RequestInit)=>{
  if(init?.method==='POST'){
    const batch=JSON.parse(String(init.body)) as Record<string,{userId:string}>;
    return Response.json(Object.values(batch).map(({userId})=>({result:{data:{_id:userId,username:userId,country:'es',leveling:{level:1},isActive:true}}})));
  }
  return Response.json({result:{data:{items:Array.from({length:PLAYER_ROWS},(_,i)=>({_id:`es-${i}`})),nextCursor:'next'}}});
});

describe('daily write reservation settlement',()=>{
  it('settles a run that failed upstream before any entity write to its measured bookkeeping',async()=>{
    const store=setup();
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('limited',{status:429,headers:{'retry-after':'60'}})));
    try{
      expect(await runSync(store.env,{source:'players',force:true})).toMatchObject({status:'error',source:'players'});
      const day=budget(store);
      expect(day.reserved_writes).toBeGreaterThan(8);
      expect(day.reserved_writes).toBeLessThan(40);
      expect(day.measured_writes).toBe(day.reserved_writes-8);
      const run=store.sqlite.prepare('SELECT status,rows_written,reserved_writes,collector_mode FROM ingestion_runs').get();
      expect(run).toMatchObject({status:'error',reserved_writes:fullReservation,collector_mode:'direct'});
      expect(Number(run?.rows_written)).toBe(day.measured_writes);
    }finally{store.sqlite.close();}
  });
  it('keeps the whole reservation once entity writes began, even if the save fails',async()=>{
    const store=setup();
    store.sqlite.exec("CREATE TRIGGER fail_player BEFORE INSERT ON players BEGIN SELECT RAISE(ABORT,'storage failure'); END;");
    vi.stubGlobal('fetch',profiles());
    try{
      expect(await runSync(store.env,{source:'players',force:true})).toMatchObject({status:'error',source:'players'});
      expect(budget(store)).toMatchObject({reserved_writes:fullReservation,measured_writes:0});
      expect(store.sqlite.prepare('SELECT rows_written FROM ingestion_runs').get()?.rows_written).toBeNull();
    }finally{store.sqlite.close();}
  });
});

describe('scheduled ticks yield collector sources',()=>{
  const onlyPlayersDue=(store:ReturnType<typeof setup>)=>{
    store.sqlite.exec("UPDATE ingestion_cursors SET next_run_at='2999-01-01T00:00:00.000Z' WHERE source_id<>'players'");
    store.sqlite.exec("UPDATE ingestion_cursors SET next_run_at='2000-01-01T00:00:00.000Z',lease_until=NULL WHERE source_id='players'");
  };
  const compactRun=(store:ReturnType<typeof setup>,secondsAgo:number)=>store.sqlite.prepare(`INSERT INTO ingestion_runs(id,source_id,started_at,status,collector_mode)
    VALUES(?,?,?,?,?)`).run(`run-${secondsAgo}`,'players',new Date(Date.now()-secondsAgo*1000).toISOString(),'ok','compact');
  it('leaves players to a collector that committed recently',async()=>{
    const store=setup(),network=vi.fn();vi.stubGlobal('fetch',network);
    onlyPlayersDue(store);compactRun(store,60);
    try{
      expect(await runSync(store.env)).toEqual({status:'idle'});
      expect(network).not.toHaveBeenCalled();
      expect(store.sqlite.prepare('SELECT COUNT(*) count FROM ingestion_budget').get()?.count).toBe(0);
    }finally{store.sqlite.close();}
  });
  it('takes players back once the collector has been silent past the handoff window',async()=>{
    const store=setup();vi.stubGlobal('fetch',profiles());
    onlyPlayersDue(store);compactRun(store,COLLECTOR_HANDOFF_SECONDS+60);
    try{
      expect(await runSync(store.env)).toMatchObject({status:'ok',source:'players',processed:PLAYER_ROWS});
    }finally{store.sqlite.close();}
  });
  it('still honours an explicit administrative run while the collector is active',async()=>{
    const store=setup();vi.stubGlobal('fetch',profiles());
    onlyPlayersDue(store);compactRun(store,60);
    try{
      expect(await runSync(store.env,{source:'players',force:true})).toMatchObject({status:'ok',source:'players'});
    }finally{store.sqlite.close();}
  });
});
