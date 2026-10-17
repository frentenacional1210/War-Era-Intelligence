import {afterEach,describe,expect,it,vi} from 'vitest';
import {createTestDB} from './sqlite-d1';
import {runSync} from '../worker/ingestion';
import type {Env} from '../worker/types';
import {PLAYER_ROWS} from '../shared/ingestion-config';

afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
const setup=()=>{
  const store=createTestDB();
  store.sqlite.exec(`INSERT INTO countries(id,name,code,source_url,updated_at,first_seen,hash,data_json) VALUES
    ('es','Spain','es','https://example.test','2026-01-01','2026-01-01','a','{}')`);
  return {...store,env:{DB:store.db} as Env};
};
const at=(iso:string)=>vi.setSystemTime(new Date(iso));
const count=(store:ReturnType<typeof setup>,type:string)=>Number(store.sqlite.prepare('SELECT COUNT(*) count FROM entity_snapshots WHERE entity_type=?').get(type)?.count);

describe('history snapshots skip volatile-only changes within a UTC day',()=>{
  it('refreshes player rows on every change but snapshots only material changes and one daily sample',async()=>{
    vi.useFakeTimers({toFake:['Date']});
    const store=setup(),profile={level:5,xp:100,party:'p1'};
    vi.stubGlobal('fetch',vi.fn(async(input:string,init?:RequestInit)=>{
      if(init?.method==='POST'){
        const batch=JSON.parse(String(init.body)) as Record<string,{userId:string}>;
        return Response.json(Object.values(batch).map(({userId})=>({result:{data:{_id:userId,username:userId,country:'es',party:profile.party,
          leveling:{level:profile.level,totalXp:profile.xp},dates:{lastConnectionAt:new Date().toISOString()},isActive:true}}})));
      }
      return Response.json({result:{data:{items:Array.from({length:PLAYER_ROWS},(_,i)=>({_id:`es-${i}`})),nextCursor:`next-${Date.now()}`}}});
    }));
    const run=async(iso:string)=>{at(iso);store.sqlite.exec("UPDATE player_census_state SET next_run_at='2000-01-01T00:00:00.000Z'");return runSync(store.env,{source:'players',force:true});};
    try{
      expect(await run('2026-10-18T01:00:00.000Z')).toMatchObject({status:'ok',changed:PLAYER_ROWS});
      expect(count(store,'players')).toBe(PLAYER_ROWS);
      profile.xp=150;
      expect(await run('2026-10-18T02:00:00.000Z')).toMatchObject({status:'ok',changed:PLAYER_ROWS});
      expect(count(store,'players')).toBe(PLAYER_ROWS);
      expect(JSON.parse(String(store.sqlite.prepare("SELECT data_json FROM players WHERE id='es-0'").get()?.data_json)).experience).toBe(150);
      profile.party='p2';
      await run('2026-10-18T03:00:00.000Z');
      expect(count(store,'players')).toBe(PLAYER_ROWS*2);
      profile.xp=175;
      await run('2026-10-19T00:30:00.000Z');
      expect(count(store,'players')).toBe(PLAYER_ROWS*3);
      const latest=JSON.parse(String(store.sqlite.prepare("SELECT data_json FROM entity_snapshots WHERE entity_id='es-0' ORDER BY id DESC LIMIT 1").get()?.data_json));
      expect(latest).toMatchObject({experience:175,party_id:'p2'});
    }finally{store.sqlite.close();}
  });
  it('applies the same rule on the per-row path to article view counts',async()=>{
    vi.useFakeTimers({toFake:['Date']});
    const store=setup();let views=10,title='First title',page=0;
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({result:{data:{items:[{_id:'a1',title,isPublic:true,isPublished:true,stats:{views}},{_id:'a2',title:'Other',isPublic:true,isPublished:true,stats:{views}}],nextCursor:`older-${++page}`}}})));
    const run=async(iso:string)=>{at(iso);return runSync(store.env,{source:'articles',force:true});};
    try{
      expect(await run('2026-10-18T01:00:00.000Z')).toMatchObject({status:'ok',changed:2});
      views=50;
      expect(await run('2026-10-18T01:10:00.000Z')).toMatchObject({status:'ok',changed:2});
      expect(count(store,'articles')).toBe(2);
      title='Edited title';
      await run('2026-10-18T01:20:00.000Z');
      expect(count(store,'articles')).toBe(3);
      views=80;
      await run('2026-10-19T01:00:00.000Z');
      expect(count(store,'articles')).toBe(5);
    }finally{store.sqlite.close();}
  });
  it('keeps every battle damage change',async()=>{
    vi.useFakeTimers({toFake:['Date']});
    const store=setup();let damage=100;
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({result:{data:{items:[{_id:'b1',isActive:true,attacker:{country:'es',damages:damage},defender:{country:'es',damages:0}}],nextCursor:null}}})));
    try{
      at('2026-10-18T01:00:00.000Z');expect(await runSync(store.env,{source:'battles',force:true})).toMatchObject({status:'ok'});
      damage=500;
      at('2026-10-18T01:05:00.000Z');expect(await runSync(store.env,{source:'battles',force:true})).toMatchObject({status:'ok'});
      expect(count(store,'battles')).toBe(2);
    }finally{store.sqlite.close();}
  });
});
