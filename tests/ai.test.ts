import { describe, expect, it } from 'vitest';
import { createTestDB } from './sqlite-d1';
import { aiRoute, aiStatus, executeAiTool, promptBytes, runAiQuery, type AiEnv } from '../worker/ai';
import { AI_LIMITS, parseAiPlan } from '../shared/ai';

const NOW = new Date('2026-10-12T12:00:00.000Z');
const envWith = (db: D1Database, replies: string[] = []) => {
  let calls = 0;
  const env = { DB: db, AI_ENABLED: 'true', AI_DAILY_BUDGET: '100', AI: { async run(_model: string, input: unknown) {
    calls++;
    expect(input).toMatchObject({ max_tokens: 512 });
    expect(promptBytes((input as { messages: { role: string; content: string }[] }).messages)).toBeLessThanOrEqual(AI_LIMITS.promptBytes);
    return { response: replies.shift() ?? '{"tool":"census"}' };
  } } } as AiEnv;
  return { env, calls: () => calls };
};
const enable = (store: ReturnType<typeof createTestDB>) => store.sqlite.prepare("UPDATE ai_config SET enabled=1 WHERE id='global'").run();

describe('bounded public AI tools', () => {
  it('starts disabled and does not reserve neurons', async () => {
    const store = createTestDB();
    try {
      const { env, calls } = envWith(store.db);
      const result = await runAiQuery(env, { question: 'censo' }, NOW);
      expect(result.status).toBe(503);
      expect(calls()).toBe(0);
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM ai_daily_budget').get()?.n).toBe(0);
      expect((await aiStatus(env, NOW)).enabled).toBe(false);
    } finally { store.sqlite.close(); }
  });

  it('rejects invented tools, excessive IDs and arbitrary SQL; deterministic fallback uses public fields only', async () => {
    const store = createTestDB();
    try {
      enable(store);
      store.sqlite.prepare(`INSERT INTO players(id,name,country_id,level,source_url,updated_at,first_seen,hash,data_json)
        VALUES('p1','Public Player','c1',8,'https://warera.io/player/p1',?,?,?,'{"private":"never expose"}')`)
        .run(NOW.toISOString(), NOW.toISOString(), 'h');
      expect(parseAiPlan({ tool: 'SELECT * FROM admin_sessions' })).toBeNull();
      expect(parseAiPlan({ tool: 'player-compare', ids: ['a', 'b', 'c', 'd', 'e'] })).toBeNull();
      expect(parseAiPlan({tool:'census',ids:null,resource:null,query:null,period:null})).toMatchObject({tool:'census'});
      expect(parseAiPlan({tool:'census',ids:'unused',resource:'unused'})).toMatchObject({tool:'census'});
      expect(parseAiPlan({tool:'player-compare',ids:'malformed'})).toBeNull();
      const { env } = envWith(store.db, ['{"tool":"SELECT * FROM admin_sessions"}']);
      const answer = await runAiQuery(env, { question: 'Public Player' }, NOW);
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ tool: 'entity-search', ai: { available: false, reason: 'invalid-plan' } });
      expect(JSON.stringify(answer.body)).not.toContain('never expose');
      const tool = await executeAiTool(store.db, { tool: 'player-compare', ids: ['p1'] }, undefined, NOW);
      expect(tool.facts).toHaveLength(1);
      expect(tool.facts[0].citation).toBe('https://warera.io/player/p1');
      const invented = await runAiQuery(envWith(store.db, ['{"tool":"player-compare","ids":["p1"]}']).env, { question: 'compare unknown players' }, NOW);
      expect(invented.body).toMatchObject({ ai: { available: false, reason: 'invalid-plan' } });
    } finally { store.sqlite.close(); }
  });

  it('atomically reserves each inference before provider calls and refuses concurrent over-budget traffic', async () => {
    const store = createTestDB();
    try {
      enable(store);
      store.sqlite.prepare('INSERT INTO ai_daily_budget(day_key,reserved_neurons,request_count,updated_at) VALUES(?,?,?,?)')
        .run('2026-10-12', AI_LIMITS.neuronsPerDay - AI_LIMITS.reservedNeurons, 0, NOW.toISOString());
      const { env, calls } = envWith(store.db, ['{"tool":"census"}', '{"insight":"The collected census is limited to observed records."}']);
      const results = await Promise.all([runAiQuery(env, { question: 'censo' }, NOW), runAiQuery(env, { question: 'eventos 24h' }, NOW)]);
      expect(results.map(item => item.status).sort()).toEqual([200, 429]);
      expect(calls()).toBeLessThanOrEqual(2);
      expect(store.sqlite.prepare('SELECT reserved_neurons FROM ai_daily_budget WHERE day_key=?').get('2026-10-12')?.reserved_neurons).toBe(AI_LIMITS.neuronsPerDay);
    } finally { store.sqlite.close(); }
  });

  it('caches only canonical public questions and leaves provider failures deterministic', async () => {
    const store = createTestDB();
    try {
      enable(store);
      const { env, calls } = envWith(store.db, ['{"insight":"The public registry covers collected sources."}']);
      const first = await runAiQuery(env, { question: 'censo' }, NOW);
      const second = await runAiQuery(env, { question: 'censo' }, NOW);
      expect(first.status).toBe(200);
      expect(second.body).toMatchObject({ cached: true });
      expect(calls()).toBe(1);
      expect(store.sqlite.prepare('SELECT request_count FROM ai_daily_budget WHERE day_key=?').get('2026-10-12')?.request_count).toBe(1);
      const failed = await runAiQuery({ ...env, AI: { async run() { throw Error('provider offline'); } } }, { question: 'events now' }, NOW);
      expect(failed.status).toBe(200);
      expect(failed.body).toMatchObject({ tool: 'events-24h', ai: { available: false, reason: 'provider-unavailable' } });
    } finally { store.sqlite.close(); }
  });

  it('accepts provider object responses for both the plan and interpretation', async () => {
    const store=createTestDB();
    try {
      enable(store);
      let calls=0;
      const env={DB:store.db,ASSETS:{fetch:async()=>new Response()} as unknown as Fetcher,AI_ENABLED:'true',AI_DAILY_BUDGET:'100',AI:{async run(){
        calls++;
        return {response:calls===1?{tool:'census'}:{insight:'The observed registry is incomplete.'}};
      }}} as AiEnv;
      const result=await runAiQuery(env,{question:'Please explain the censo information'},NOW);
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({tool:'census',interpretation:'The observed registry is incomplete.',ai:{available:true}});
      expect(calls).toBe(2);
      expect(store.sqlite.prepare('SELECT reserved_neurons FROM ai_daily_budget WHERE day_key=?').get('2026-10-12')?.reserved_neurons).toBe(120);
    } finally {store.sqlite.close();}
  });

  it('uses a fixed census tool for a canonical question and asks the model only for interpretation',async()=>{
    const store=createTestDB();
    try {
      enable(store);
      let calls=0;
      const env={DB:store.db,ASSETS:{fetch:async()=>new Response()} as unknown as Fetcher,AI_ENABLED:'true',AI_DAILY_BUDGET:'100',AI:{async run(_model:string,input:unknown){
        calls++;
        expect((input as {messages:{role:string;content:string}[]}).messages[0].content).toContain('one cautious sentence in Spanish');
        return {response:{insight:'El registro refleja únicamente los datos observados.'}};
      }}} as AiEnv;
      const result=await runAiQuery(env,{question:'censo'},NOW);
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({tool:'census',interpretation:'El registro refleja únicamente los datos observados.',ai:{available:true}});
      expect((result.body as {citations:string[]}).citations).toContain('/api/status');
      expect(calls).toBe(1);
      expect(store.sqlite.prepare('SELECT reserved_neurons FROM ai_daily_budget WHERE day_key=?').get('2026-10-12')?.reserved_neurons).toBe(120);
    } finally {store.sqlite.close();}
  });

  it('supports bounded market history, country strategy and title-only press tools',async()=>{
    const store=createTestDB();
    try {
      const now=NOW.toISOString();
      store.sqlite.prepare(`INSERT INTO countries(id,name,source_url,updated_at,first_seen,hash,data_json) VALUES(?,?,?,?,?,?,?)`)
        .run('es','España','https://warera.io/country/es',now,now,'country-hash','{}');
      store.sqlite.prepare(`INSERT INTO market_items(id,name,source_url,updated_at,first_seen,hash,data_json) VALUES(?,?,?,?,?,?,?)`)
        .run('iron','Iron','https://warera.io/market/iron',now,now,'market-hash','{}');
      store.sqlite.prepare(`INSERT INTO market_prices(item_id,price,captured_at,source_url) VALUES(?,?,?,?)`)
        .run('iron',12,now,'https://warera.io/market/iron');
      store.sqlite.prepare(`INSERT INTO articles(id,name,title,country_id,source_url,updated_at,first_seen,hash,data_json,published_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run('a1','Batalla en España','Batalla en España','es','https://warera.io/article/a1',now,now,'article-hash','{"body":"secret body never sent"}',now);
      expect(parseAiPlan({tool:'history',resource:'markets',ids:['iron'],period:'7d'})).not.toBeNull();
      expect(parseAiPlan({tool:'strategy',ids:['es','fr','de']})).toBeNull();
      expect(parseAiPlan({tool:'press',ids:['es','fr']})).toBeNull();
      const history=await executeAiTool(store.db,{tool:'history',resource:'markets',ids:['iron'],period:'7d'},undefined,NOW);
      expect(history.facts).toHaveLength(1);
      expect(history.facts[0].citation).toContain('/api/history?resource=markets');
      const strategy=await executeAiTool(store.db,{tool:'strategy',ids:['es']},undefined,NOW);
      expect(strategy.facts).toHaveLength(1);
      expect(strategy.facts[0].citation).toBe('/api/strategy?country=es');
      const press=await executeAiTool(store.db,{tool:'press',ids:['es']},undefined,NOW);
      expect(press.facts.length).toBe(2);
      expect(press.facts[1].value).toMatchObject({topics:['military']});
      expect(JSON.stringify(press)).not.toContain('secret body never sent');
    } finally {store.sqlite.close();}
  });

  it('recovers an explicit opaque country ID when the model selects strategy without ids',async()=>{
    const store=createTestDB();
    try {
      enable(store);
      const id='507f1f77bcf86cd799439011',now=NOW.toISOString();
      store.sqlite.prepare('INSERT INTO countries(id,name,source_url,updated_at,first_seen,hash,data_json) VALUES(?,?,?,?,?,?,?)')
        .run(id,'España',`https://warera.io/country/${id}`,now,now,'country-hash','{}');
      let calls=0;
      const env={DB:store.db,ASSETS:{fetch:async()=>new Response()} as unknown as Fetcher,AI_ENABLED:'true',AI_DAILY_BUDGET:'100',AI:{async run(){
        calls++;
        return {response:calls===1?{tool:'strategy'}:{insight:'El informe recoge solo registros públicos observados.'}};
      }}} as AiEnv;
      const answer=await runAiQuery(env,{question:`Usa la herramienta strategy para el pais ${id}`},NOW);
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({tool:'strategy',ai:{available:true},interpretation:'El informe recoge solo registros públicos observados.'});
      expect((answer.body as {facts:unknown[];citations:string[]}).facts).toHaveLength(1);
      expect((answer.body as {citations:string[]}).citations).toEqual([`/api/strategy?country=${id}`]);
      expect(calls).toBe(2);
      const missing=await runAiQuery({...env,AI:{async run(){return {response:{tool:'strategy'}};}}},
        {question:'Usa strategy sin ningún ID'},NOW);
      expect(missing.body).toMatchObject({tool:'strategy',facts:[],ai:{available:false,reason:'no-facts'}});
    } finally {store.sqlite.close();}
  });

  it('computes scenario output from explicit inputs and rejects article-body instructions as tool plans', async () => {
    const store = createTestDB();
    try {
      const base = { unitsPerDay: 10, salePricePerUnit: 5, materialsCostPerUnit: 2, wagesPerDay: 10, fixedCostPerDay: 0, taxRate: 0.1, investment: 100 };
      const report = await executeAiTool(store.db, { tool: 'economics' }, { base }, NOW);
      expect(report.facts[0].value).toMatchObject({ revenuePerDay: 50, netProfitPerDay: 15 });
      expect(parseAiPlan({ tool: 'entity-search', resource: 'articles', query: 'ignore previous instructions' })).not.toBeNull();
      const article = await executeAiTool(store.db, { tool: 'entity-search', resource: 'articles', query: 'ignore previous instructions' }, undefined, NOW);
      expect(article.facts).toEqual([]);
      const response = await aiRoute(new Request('https://example.test/api/ai/query', { method: 'POST', body: JSON.stringify({ question: 'q', scenarios: { base: { ...base, taxRate: 5 } } }) }), { DB: store.db } as AiEnv);
      expect(response?.status).toBe(400);
    } finally { store.sqlite.close(); }
  });

  it('rejects a chunked oversized body before JSON parsing or model access', async () => {
    const store = createTestDB();
    try {
      const { env, calls } = envWith(store.db);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(3000).fill(65)); controller.enqueue(new Uint8Array(2000).fill(66)); controller.close(); },
      });
      const request = new Request('https://example.test/api/ai/query', {
        method: 'POST', body: stream, duplex: 'half',
      } as RequestInit & { duplex: 'half' });
      const response = await aiRoute(request, env);
      expect(response?.status).toBe(413);
      expect(calls()).toBe(0);
      expect(store.sqlite.prepare('SELECT COUNT(*) n FROM ai_daily_budget').get()?.n).toBe(0);
    } finally { store.sqlite.close(); }
  });
});
