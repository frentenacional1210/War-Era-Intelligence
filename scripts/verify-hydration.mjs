import {readFile,writeFile,mkdir} from 'node:fs/promises';
const origin=process.env.WINT_URL;
if(!origin?.startsWith('https://'))throw new Error('Define WINT_URL con la URL pública HTTPS.');
const password=(await readFile('artifacts/private/ADMIN_ACCESS.txt','utf8')).match(/^Contraseña: (.+)$/m)?.[1];
if(!password)throw new Error('No hay credencial administrativa local.');
const base={'Content-Type':'application/json','X-WINT-CSRF':'1'};
const login=await fetch(`${origin}/api/admin/login`,{method:'POST',headers:base,body:JSON.stringify({password})});
if(!login.ok)throw new Error(`Login: HTTP ${login.status}`);
const cookie=login.headers.get('set-cookie')?.split(';')[0];
if(!cookie)throw new Error('No se recibió sesión.');
const headers={...base,Cookie:cookie};const records=[];
try{
  for(const source of ['countries','countries','regions','regions']){
    const startedAt=new Date().toISOString();
    const response=await fetch(`${origin}/api/admin/sync`,{method:'POST',headers,body:JSON.stringify({source})});
    const result=await response.json();const row={startedAt,finishedAt:new Date().toISOString(),httpStatus:response.status,source,...result};records.push(row);console.log(JSON.stringify(row));
    if(!response.ok || result.status!=='ok')throw new Error('Falló una captura real de descubrimiento/hidratación.');
  }
  await mkdir('artifacts/validation',{recursive:true});
  await writeFile('artifacts/validation/hydration.json',JSON.stringify(records,null,2)+'\n');
}finally{await fetch(`${origin}/api/admin/logout`,{method:'POST',headers,body:'{}'});}
