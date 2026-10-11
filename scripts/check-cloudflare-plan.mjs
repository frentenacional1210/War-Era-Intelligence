import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
const config=JSON.parse((await readFile('wrangler.jsonc','utf8')).replace(/^\s*\/\/.*$/gm,''));
const accountId=config.account_id ?? process.env.CLOUDFLARE_ACCOUNT_ID;
if(!accountId)throw new Error('Configure account_id en wrangler.jsonc para esta comprobación.');
let token=process.env.CLOUDFLARE_API_TOKEN;
if(!token && process.platform==='win32') {
  const text=await readFile(join(process.env.APPDATA,'xdg.config','.wrangler','config','default.toml'),'utf8');
  token=text.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
}
if(!token)throw new Error('No hay credencial local para comprobar el plan. Use Wrangler login.');
for(const path of ['workers/account-settings','subscriptions']) {
  const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/${path}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20000)});
  const data=await response.json();
  if(!response.ok || !data.success){console.log(JSON.stringify({resource:path,status:response.status,verified:false,errorCodes:data.errors?.map(e=>e.code)}));continue;}
  const result=path==='subscriptions'?data.result.map(s=>({plan:s.rate_plan?.id,name:s.rate_plan?.public_name ?? s.rate_plan?.name,state:s.state})):data.result;
  console.log(JSON.stringify({resource:path,status:response.status,verified:true,result}));
}
