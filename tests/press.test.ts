import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyPressTitle, PRESS_CLASSIFICATION } from '../shared/press';
import { pressRoute } from '../worker/press';
import { createTestDB } from './sqlite-d1';
import type { Env } from '../worker/types';

afterEach(() => vi.unstubAllGlobals());
const insert = (store: ReturnType<typeof createTestDB>, id: string, title: string, publishedAt: string | null,
  country = 'es', language = 'es') => store.sqlite.prepare(`INSERT INTO articles
    (id,name,country_id,title,author_id,published_at,language,category,source_url,updated_at,first_seen,hash,data_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,title,country,title,'author-1',publishedAt,language,null,
      `https://api2.warera.io/trpc/article.getArticleById?input=${encodeURIComponent(JSON.stringify({articleId:id}))}`,
      '2026-10-12T12:00:00.000Z','2026-10-12T12:00:00.000Z',`hash-${id}`,JSON.stringify({ body:'never expose article text' }));
const call = (env: Env, query = '', method = 'GET') => pressRoute(new Request(`https://wint.test/api/press${query}`,{method}),env);

describe('public metadata press sample', () => {
  it('classifies only exact title keywords and keeps unknown titles unasserted', () => {
    expect(classifyPressTitle('Batalla y mercado: entrevista')).toEqual(['military','economy','community']);
    expect(classifyPressTitle('Election results and government')).toEqual(['politics']);
    expect(classifyPressTitle('Editorial de hoy')).toEqual(['other']);
    expect(classifyPressTitle('marketplace')).toEqual(['other']);
  });

  it('reads at most the latest 100 captured rows and never exposes article bodies or infers facts', async () => {
    const store = createTestDB();
    const env = { DB: store.db } as Env;
    const upstream = vi.fn(() => { throw new Error('Press must not fetch upstream'); });
    vi.stubGlobal('fetch',upstream);
    try {
      for (let index = 0; index < 105; index++) insert(store,`article-${index}`,`Batalla ${index}`,
        new Date(Date.UTC(2026,6,1+index)).toISOString());
      const response = await call(env,'?limit=100');
      expect(response?.status).toBe(200);
      const data = await response!.json() as { items: {id:string;topics:string[];related:unknown[]}[];
        sampled:number; matched:number; isSample:boolean; coverage:string; classification:string;
        trends:{daily:unknown[];unknownDateCount:number} };
      expect(data).toMatchObject({ sampled:100,matched:100,isSample:true,coverage:'latest-100-captured-metadata',classification:PRESS_CLASSIFICATION });
      expect(data.items).toHaveLength(100);
      expect(data.items[0].id).toBe('article-104');
      expect(data.items.some(item => item.id === 'article-0')).toBe(false);
      expect(data.items[0].topics).toEqual(['military']);
      expect(data.items[0].related).toHaveLength(6);
      expect(data.trends.daily).toHaveLength(100);
      expect(JSON.stringify(data)).not.toContain('never expose article text');
      expect(upstream).not.toHaveBeenCalled();
    } finally { store.sqlite.close(); }
  });

  it('applies indexed country/date predicates, filters language inside the sample, and separates unknown dates', async () => {
    const store = createTestDB();
    const env = { DB: store.db } as Env;
    try {
      insert(store,'es-1','Mercado de acero','2026-10-10T08:00:00.000Z','es','es');
      insert(store,'es-2','Government election','2026-10-11T08:00:00.000Z','es','en');
      insert(store,'fr-1','Battle today','2026-10-11T12:00:00.000Z','fr','en');
      insert(store,'es-unknown','Comunidad sin fecha',null,'es','es');
      const filtered = await call(env,'?country=es&language=en&from=2026-10-10&to=2026-10-11');
      expect(await filtered!.json()).toMatchObject({ sampled:2,matched:1,items:[{id:'es-2',topics:['politics']}],
        trends:{daily:[{date:'2026-10-11',count:1}],unknownDateCount:0} });
      const plan = store.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT id FROM articles
        WHERE country_id=? AND published_at>=? AND published_at<? ORDER BY published_at DESC,id DESC LIMIT 100`)
        .all('es','2026-10-10T00:00:00.000Z','2026-10-12T00:00:00.000Z');
      expect(plan.some(step => String(step.detail).includes('idx_articles_country_published'))).toBe(true);
      const all = await call(env,'?country=es');
      expect(await all!.json()).toMatchObject({ sampled:3,matched:3,trends:{unknownDateCount:1} });
      const head = await call(env,'?country=es','HEAD');
      expect(head?.status).toBe(200);
      expect(await head!.text()).toBe('');
    } finally { store.sqlite.close(); }
  });

  it('relates at most six articles by shared non-generic title topics, with no claim about article content', async () => {
    const store = createTestDB();
    const env = { DB: store.db } as Env;
    try {
      for (let i=0;i<9;i++) insert(store,`military-${i}`,`Battle ${i}`,
        new Date(Date.UTC(2026,9,1+i)).toISOString());
      insert(store,'economy','Market prices','2026-10-10T12:00:00.000Z');
      insert(store,'other','A personal editorial','2026-10-11T12:00:00.000Z');
      const response = await call(env,'?limit=11');
      const data = await response!.json() as { items: {id:string;related:{id:string;sharedTopics:string[]}[]}[] };
      expect(data.items.find(item => item.id === 'military-8')?.related).toHaveLength(6);
      expect(data.items.find(item => item.id === 'military-8')?.related.every(item => item.sharedTopics.includes('military'))).toBe(true);
      expect(data.items.find(item => item.id === 'economy')?.related).toEqual([]);
      expect(data.items.find(item => item.id === 'other')?.related).toEqual([]);
    } finally { store.sqlite.close(); }
  });

  it('rejects unsupported search, malformed filters, oversized limits and write methods before D1 access', async () => {
    const store = createTestDB();
    const env = { DB: store.db } as Env;
    try {
      for (const query of ['?q=battle','?limit=101','?country=es%27%3BDROP','?from=2026-02-30',
        '?from=2026-10-12&to=2026-10-11','?language=es&language=en'])
        expect((await call(env,query))?.status).toBe(400);
      expect((await call(env,'','POST'))?.status).toBe(405);
      expect((await pressRoute(new Request('https://wint.test/api/other'),env))).toBeNull();
    } finally { store.sqlite.close(); }
  });
});
