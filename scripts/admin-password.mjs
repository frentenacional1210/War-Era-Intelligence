import { randomBytes, pbkdf2Sync } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const password = process.env.WINT_ADMIN_PASSWORD;
if (!password || password.length < 12) throw new Error('Defina WINT_ADMIN_PASSWORD (mínimo 12 caracteres) en el entorno.');
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, 100_000, 32, 'sha256');
const passwordHash = `pbkdf2$100000$${salt.toString('base64')}$${hash.toString('base64')}`;
const secret = randomBytes(32).toString('base64');
if (process.argv.includes('--local')) {
  let existing = '';
  try { existing = await readFile('.dev.vars', 'utf8'); } catch { /* first setup */ }
  const lines = existing.split(/\r?\n/).filter(line => line && !/^(ADMIN_PASSWORD_HASH|SESSION_SECRET)=/.test(line));
  lines.push(`ADMIN_PASSWORD_HASH=${passwordHash}`, `SESSION_SECRET=${secret}`);
  await writeFile('.dev.vars', `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log('Credenciales locales guardadas en .dev.vars (excluido de Git).');
} else {
  console.log(`ADMIN_PASSWORD_HASH=${passwordHash}\nSESSION_SECRET=${secret}`);
  console.log('Guarde estos valores como secretos de Wrangler; no los incluya en Git.');
}
