import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
// Only scheduled-event summaries are saved. Request headers and visitor metadata are discarded.
const cli=fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url));
const child=spawn(process.execPath,[cli,'tail','--format','json'],{stdio:['ignore','pipe','pipe']});
const records=[];let buffer='',writing=Promise.resolve();
const target=process.env.WINT_CRON_EVIDENCE ?? 'artifacts/validation/cron.json';
await mkdir('artifacts/validation',{recursive:true});
createInterface({input:child.stdout}).on('line',line=>{
  if(!buffer && line!=='{')return;
  buffer+=line+'\n';
  if(buffer.length>1_000_000){buffer='';return;}
  if(line!=='}')return;
  let event;try{event=JSON.parse(buffer);}catch{return;}finally{buffer='';}
  const scheduled=Boolean(event.event?.cron || event.event?.type==='scheduled');
  let sync=false;
  if(process.env.WINT_TAIL_SYNC==='true' && event.event?.request?.url){try{sync=new URL(event.event.request.url).pathname==='/api/admin/sync';}catch{}}
  if(!scheduled && !sync)return;
  const summary=(event.logs ?? []).flatMap(log=>log.message ?? []).find(value=>value && typeof value==='object' && 'status' in value && 'source' in value);
  const safe={observedAt:new Date().toISOString(),kind:scheduled?'cron':'manual-sync',cron:event.event.cron,outcome:event.outcome,cpuTimeMs:event.cpuTime,exceptionCount:event.exceptions?.length ?? 0,version:typeof event.scriptVersion?.id==='string'?event.scriptVersion.id:undefined,...(summary?{source:summary.source,status:summary.status,processed:summary.processed}:{})};
  records.push(safe);console.log(JSON.stringify(safe));
  writing=writing.then(()=>writeFile(target,JSON.stringify(records,null,2)+'\n'));
});
const timeout=setTimeout(()=>child.kill(),Number(process.env.WINT_WATCH_MS ?? 240000));
await new Promise(resolve=>child.on('exit',resolve));clearTimeout(timeout);await writing;
console.log(JSON.stringify({eventsObserved:records.length,scheduledEventsObserved:records.filter(row=>row.kind==='cron').length}));
