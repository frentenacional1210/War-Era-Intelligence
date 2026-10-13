import type { Env } from './types';
const encoder = new TextEncoder();
const bytes = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const b64 = (value: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(value)));
async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign','verify']);
  return {key, signature:b64(await crypto.subtle.sign('HMAC', key, encoder.encode(value)))};
}
export async function passwordMatches(password:string, stored:string):Promise<boolean> {
  const [algorithm, rounds, salt, expected] = stored.split('$');
  if (algorithm !== 'pbkdf2' || Number(rounds) !== 100000 || !salt || !expected) return false;
  try {
    const key = await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
    const output = new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:bytes(salt),iterations:100000},key,256));
    const target = bytes(expected);
    let difference = output.length ^ target.length;
    for(let i=0;i<output.length;i++) difference |= output[i] ^ (target[i] ?? 0);
    return difference === 0;
  } catch { return false; }
}
export async function takeLimit(env:Env, request:Request, scope:string, max:number, seconds:number) {
  if (!env.SESSION_SECRET) return false;
  const now = Math.floor(Date.now()/1000);
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  const bucket = `${scope}:${(await hmac(env.SESSION_SECRET,ip)).signature}`;
  const row = await env.DB.prepare(`INSERT INTO request_limits(bucket,hits,reset_at) VALUES(?,1,?)
    ON CONFLICT(bucket) DO UPDATE SET hits=CASE WHEN reset_at<=? THEN 1 ELSE hits+1 END,
    reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END
    WHERE request_limits.reset_at<=? OR request_limits.hits<? RETURNING hits`).bind(bucket,now+seconds,now,now,now,max).first<{hits:number}>();
  return !!row && row.hits <= max;
}
export function csrfValid(request:Request) {
  const origin = request.headers.get('Origin');
  return request.headers.get('X-WINT-CSRF') === '1' && (!origin || origin === new URL(request.url).origin);
}
export async function createSession(env:Env, request:Request) {
  const id = crypto.randomUUID();
  const expiry = Math.floor(Date.now()/1000)+8*3600;
  await env.DB.prepare('INSERT INTO admin_sessions(id,expires_at,created_at) VALUES(?,?,?)').bind(id,expiry,Math.floor(Date.now()/1000)).run();
  const signature = (await hmac(env.SESSION_SECRET!, `${id}.${expiry}`)).signature;
  return `wint_session=${encodeURIComponent(`${id}.${expiry}.${signature}`)}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=28800${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
export async function sessionId(env:Env, request:Request):Promise<string|null> {
  if (!env.SESSION_SECRET || !env.ADMIN_PASSWORD_HASH) return null;
  const match = request.headers.get('Cookie')?.match(/(?:^|;\s*)wint_session=([^;]+)/);
  if (!match) return null;
  try {
    const [id,expiry,signature] = decodeURIComponent(match[1]).split('.');
    if (!id || !expiry || !signature || Number(expiry) <= Date.now()/1000) return null;
    const {key} = await hmac(env.SESSION_SECRET,`${id}.${expiry}`);
    if (!await crypto.subtle.verify('HMAC',key,bytes(signature),encoder.encode(`${id}.${expiry}`))) return null;
    const session = await env.DB.prepare('SELECT id FROM admin_sessions WHERE id=? AND expires_at>?').bind(id,Math.floor(Date.now()/1000)).first();
    return session ? id : null;
  } catch { return null; }
}
