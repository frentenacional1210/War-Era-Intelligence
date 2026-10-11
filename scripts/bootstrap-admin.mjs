import {randomBytes,pbkdf2Sync} from 'node:crypto';
import {mkdir,writeFile,access} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const target='artifacts/private/ADMIN_ACCESS.txt';
try{await access(target);throw new Error('Ya existe el acceso administrativo local. No se rotan secretos automáticamente.');}catch(error){if(error.code!=='ENOENT')throw error;}
const cli=fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url));
const run=spawnSync(process.execPath,[cli,'secret','list'],{encoding:'utf8'});
if(run.status!==0)throw new Error('Despliega primero el Worker y autentica Wrangler.');
const list=JSON.parse(run.stdout.slice(run.stdout.indexOf('[')));
if(list.some(secret=>['ADMIN_PASSWORD_HASH','SESSION_SECRET'].includes(secret.name)))throw new Error('El Worker ya tiene secretos administrativos; no se sobrescriben.');
const password=randomBytes(24).toString('base64url'),salt=randomBytes(16);
const secrets={ADMIN_PASSWORD_HASH:`pbkdf2$100000$${salt.toString('base64')}$${pbkdf2Sync(password,salt,100000,32,'sha256').toString('base64')}`,SESSION_SECRET:randomBytes(32).toString('base64')};
await mkdir('artifacts/private',{recursive:true});
await writeFile(target,`Acceso privado a WINT\nContraseña: ${password}\nPágina: /admin\nGenerada: ${new Date().toISOString()}\nNo compartir ni incluir este archivo en Git. Guárdala en tu gestor de contraseñas.\n`,{encoding:'utf8',mode:0o600});
const upload=spawnSync(process.execPath,[cli,'secret','bulk'],{encoding:'utf8',input:JSON.stringify(secrets)});
if(upload.status!==0)throw new Error('No se pudieron configurar los secretos. El archivo local se conserva; revisa Wrangler sin imprimir credenciales.');
console.log('Secretos administrativos configurados. Acceso guardado únicamente en artifacts/private/ADMIN_ACCESS.txt, excluido de Git.');
