import {readFile,writeFile,mkdir} from 'node:fs/promises';
const origin=process.env.WINT_URL;
if(!origin || !origin.startsWith('https://'))throw new Error('Define WINT_URL con la URL pública HTTPS.');
const text=await readFile('artifacts/private/ADMIN_ACCESS.txt','utf8');
const password=text.match(/^Contraseña: (.+)$/m)?.[1];
if(!password)throw new Error('No se encuentra el acceso administrativo privado.');
const headers={'Content-Type':'application/json','X-WINT-CSRF':'1'};
const login=await fetch(`${origin}/api/admin/login`,{method:'POST',headers,body:JSON.stringify({password})});
if(!login.ok)throw new Error(`Login: HTTP ${login.status}`);
const cookie=login.headers.get('set-cookie')?.split(';')[0];
if(!cookie)throw new Error('No se recibió una sesión.');
const secureHeaders={...headers,Cookie:cookie};
const syncResults=[];
if(process.argv.includes('--sync')) {
  for(const source of ['countries','players','parties','military-units','articles','markets','battles','regions']) {
    const response=await fetch(`${origin}/api/admin/sync`,{method:'POST',headers:secureHeaders,body:JSON.stringify({source})});
    const result=await response.json();syncResults.push({source,httpStatus:response.status,...result});
    console.log(JSON.stringify({source,httpStatus:response.status,...result}));
    if(!response.ok)throw new Error(`Sincronización ${source}: HTTP ${response.status}`);
  }
}
const admin=await fetch(`${origin}/api/admin/status`,{headers:secureHeaders});
if(!admin.ok)throw new Error(`Estado administrativo: HTTP ${admin.status}`);
const state=await admin.json();
const health=await fetch(`${origin}/api/health`);
const home=await fetch(origin);
const snapshot={verifiedAt:new Date().toISOString(),origin,homeStatus:home.status,healthStatus:health.status,totals:state.totals,sources:state.sources,quota:state.quota,syncResults,runs:state.runs};
await mkdir('artifacts/validation',{recursive:true});
await writeFile('artifacts/validation/live.json',JSON.stringify(snapshot,null,2)+'\n');
const logout=await fetch(`${origin}/api/admin/logout`,{method:'POST',headers:secureHeaders,body:'{}'});
const revoked=await fetch(`${origin}/api/admin/status`,{headers:secureHeaders});
console.log(JSON.stringify({home:home.status,health:health.status,totals:state.totals,logout:logout.status,revokedSession:revoked.status}));
if(home.status!==200 || health.status!==200 || logout.status!==200 || revoked.status!==401)throw new Error('Falló una comprobación pública o de sesión.');
