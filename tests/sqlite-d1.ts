import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
export function createTestDB() {
  const sqlite=new DatabaseSync(':memory:');
  for(const name of readdirSync('migrations').filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(`migrations/${name}`,'utf8'));
  const make=(sql:string,params:unknown[]=[])=>({
    bind(...values:unknown[]){return make(sql,values);},
    async first(column?:string){const row=sqlite.prepare(sql).get(...params as (string|number|null)[]) ?? null;return column&&row ? row[column] : row;},
    async all(){const results=sqlite.prepare(sql).all(...params as (string|number|null)[]);return {success:true,results,meta:{changes:0,rows_read:results.length,rows_written:0}};},
    async run(){const result=sqlite.prepare(sql).run(...params as (string|number|null)[]);return {success:true,results:[],meta:{changes:Number(result.changes),rows_read:0,rows_written:Number(result.changes)}};},
    _sql:sql,_params:params
  });
  const db={prepare:make,async batch(statements:ReturnType<typeof make>[]){sqlite.exec('BEGIN');try{const results=[];for(const s of statements){const read=/^\s*SELECT|RETURNING/i.test(s._sql);results.push(read?await s.all():await s.run());}sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}},async exec(sql:string){sqlite.exec(sql);return {count:1,duration:0};}};
  return {db:db as unknown as D1Database,sqlite};
}
