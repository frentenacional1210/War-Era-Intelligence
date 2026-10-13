import {readFile,writeFile} from 'node:fs/promises';
const origin=process.env.WINT_URL;
if(!origin?.startsWith('https://'))throw new Error('WINT_URL must use HTTPS');
const password=(await readFile('artifacts/private/ADMIN_ACCESS.txt','utf8')).match(/^Contrase\u00f1a: (.+)$/m)?.[1];
if(!password)throw new Error('Private admin credentials unavailable');
const headers={'Content-Type':'application/json','X-WINT-CSRF':'1',Origin:origin};
const login=await fetch(`${origin}/api/admin/login`,{method:'POST',headers,body:JSON.stringify({password})});
if(!login.ok)throw new Error(`Admin login HTTP ${login.status}`);
const cookie=login.headers.get('set-cookie')?.split(';')[0];
if(!cookie)throw new Error('No admin session');
const authorized={...headers,Cookie:cookie};
const evidence={verifiedAt:new Date().toISOString(),routes:[]};
try {
  const countries=await (await fetch(`${origin}/api/countries?limit=1`)).json();
  const country=countries.items?.[0]?.id;
  const paths=['/api/coverage?limit=1','/api/search?q=Spain&limit=7','/api/alerts/feed?limit=1','/api/ai/tools','/api/admin/diagnostics'];
  if(country)paths.push(`/api/strategy?country=${encodeURIComponent(country)}`,`/api/politics?country=${encodeURIComponent(country)}`);
  for(const path of paths){const response=await fetch(`${origin}${path}`,{headers:path.startsWith('/api/admin/')?authorized:undefined});evidence.routes.push({route:path.split('?')[0],status:response.status});if(!response.ok)throw new Error(`${path.split('?')[0]} HTTP ${response.status}`);}
  const state=await (await fetch(`${origin}/api/admin/status`,{headers:authorized})).json();
  evidence.totals=state.totals;evidence.quota=state.quota;
  const maintenance=await fetch(`${origin}/api/admin/maintenance`,{method:'POST',headers:authorized,body:'{}'});
  evidence.maintenance={httpStatus:maintenance.status,...await maintenance.json()};
  if(!maintenance.ok || evidence.maintenance.status==='error')throw new Error('History maintenance failed');
  if(process.argv.includes('--validate-ai')){
    const response=await fetch(`${origin}/api/admin/ai/validate`,{method:'POST',headers:authorized,body:'{}'});
    evidence.aiValidation={httpStatus:response.status,...await response.json()};
    if(!response.ok || !evidence.aiValidation.available)throw new Error('Workers AI provider validation failed');
  }
} finally {
  await fetch(`${origin}/api/admin/logout`,{method:'POST',headers:authorized,body:'{}'});
  await writeFile('artifacts/validation/continuation.json',JSON.stringify(evidence,null,2)+'\n');
}
console.log(JSON.stringify(evidence));
