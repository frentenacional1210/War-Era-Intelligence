import {describe,expect,it} from 'vitest';
import {ingestionFreshness} from '../src/utils';
import type {Source} from '../src/types';

const now=Date.parse('2026-10-17T15:00:00.000Z');
const source=(id:string,status:string,lastSuccess:string|null,extra:Partial<Source>={}):Source=>({id,endpoint:`${id}.get`,status,last_success:lastSuccess,enabled:1,...extra});

describe('ingestion freshness notice',()=>{
  it('explains a quota pause with the last capture and the UTC reset',()=>{
    const notice=ingestionFreshness([source('players','quota-paused','2026-10-17T04:30:00.000Z'),source('articles','quota-paused','2026-10-17T04:29:00.000Z'),
      source('alerts','ok','2026-10-17T14:55:00.000Z',{endpoint:'derived:public snapshots and prices'})],now);
    expect(notice?.title).toBe('Recopilación en pausa por la cuota diaria gratuita');
    expect(notice?.detail).toContain('hace 10 h');
    expect(notice?.detail).toContain('00:00 UTC (dentro de 9 h 0 min)');
  });
  it('flags stale captures without a pause and stays silent when data is fresh',()=>{
    expect(ingestionFreshness([source('players','ok','2026-10-17T13:00:00.000Z')],now)?.title).toBe('Sin capturas recientes');
    expect(ingestionFreshness([source('players','ok','2026-10-17T14:50:00.000Z'),source('battles','quota-paused','2026-10-17T14:40:00.000Z'),source('articles','ok','2026-10-17T14:52:00.000Z')],now)).toBeNull();
  });
  it('ignores derived and disabled sources when judging upstream activity',()=>{
    expect(ingestionFreshness([source('alerts','ok','2026-10-17T14:59:00.000Z',{endpoint:'derived:x'}),source('players','quota-paused',null,{enabled:0})],now)).toBeNull();
  });
});
