import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const configPath = new URL('../wrangler.jsonc', import.meta.url);
const config = await readFile(configPath, 'utf8');
const idMatch = config.match(/"database_id"\s*:\s*"([0-9a-f-]{36})"/i);
if (!idMatch) throw new Error('No se encontró database_id en wrangler.jsonc.');
if (idMatch[1] !== '00000000-0000-0000-0000-000000000000') {
  console.log(`D1 ya configurada: ${idMatch[1]}. No se creará otra base de datos.`);
  process.exit(0);
}
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
function wrangler(args) {
  const run = spawnSync(npx, ['wrangler', ...args], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`wrangler ${args.join(' ')} falló: ${(run.stderr || run.stdout).trim()}`);
  return run.stdout;
}
wrangler(['whoami']);
const output = wrangler(['d1', 'create', 'wint-db']);
const uuid = output.match(/database_id\s*=\s*"([0-9a-f-]{36})"/i)?.[1]
  ?? output.match(/database_id["'\s:]+([0-9a-f-]{36})/i)?.[1];
if (!uuid) throw new Error('D1 creada, pero no se pudo leer su ID. Copie database_id desde la salida de Wrangler y configúrelo manualmente.');
await writeFile(configPath, config.replace(idMatch[0], idMatch[0].replace(idMatch[1], uuid)), 'utf8');
console.log(`D1 configurada en wrangler.jsonc: ${uuid}`);
