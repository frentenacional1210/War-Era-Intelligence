import {mkdir,readFile,writeFile} from 'node:fs/promises';
const origin=process.env.WINT_URL;
if(!origin?.startsWith('https://'))throw new Error('Define WINT_URL con la URL pública HTTPS.');
const path='artifacts/validation/persistence.json';
const resources=['countries','regions','players','parties','military-units','battles','articles'];
const read=async path=>{const r=await fetch(`${origin}${path}`,{signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error(`${path}: HTTP ${r.status}`);return r.json();};
const collections=await Promise.all(resources.map(async resource=>({resource,...await read(`/api/${resource}?limit=1&sort=name&verify=${Date.now()}`)})));
const now={verifiedAt:new Date().toISOString(),origin,counts:Object.fromEntries(collections.map(c=>[c.resource,c.total])),samples:Object.fromEntries(collections.map(c=>[c.resource,c.items[0]?.id ?? null]))};
await mkdir('artifacts/validation',{recursive:true});
if(process.argv.includes('--before')){await writeFile(path,JSON.stringify({before:now},null,2)+'\n');console.log('Muestra y contadores anteriores al despliegue guardados.');}
else{
  const evidence=JSON.parse(await readFile(path,'utf8'));
  if(evidence.before.origin!==origin)throw new Error('La URL cambió respecto a la captura anterior.');
  const retained=await Promise.all(resources.map(async resource=>{
    const id=evidence.before.samples[resource];if(!id)throw new Error(`No hay muestra real para ${resource}.`);
    const detail=await read(`/api/${resource}/${encodeURIComponent(id)}`);
    if(detail.item?.id!==id || now.counts[resource]<evidence.before.counts[resource])throw new Error(`No se conserva ${resource}.`);
    return resource;
  }));
  await writeFile(path,JSON.stringify({...evidence,after:now,retained,passed:true},null,2)+'\n');
  console.log(JSON.stringify({persistedAfterRedeploy:true,resources:retained,counts:now.counts}));
}
