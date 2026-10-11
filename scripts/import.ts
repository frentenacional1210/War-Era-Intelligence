import { readFile } from 'node:fs/promises';
import { parseImport, validateImport } from '../shared/import.js';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const file = flag('--file');
const resource = flag('--resource');
const base = flag('--url') ?? 'http://127.0.0.1:8787';
const apply = process.argv.includes('--apply');
if (!file || !resource) {
  console.error('Uso: npm run import -- --file datos.csv --resource players|parties|military-units [--url http://127.0.0.1:8787] [--apply]');
  process.exitCode = 2;
} else {
  const parsed = parseImport(file, new Uint8Array(await readFile(file)));
  const checked = validateImport(resource, parsed.records);
  const errors = [...parsed.errors, ...checked.errors];
  const summary = { resource, valid: checked.records.length, duplicates: parsed.duplicates + checked.duplicates, errors, preview: checked.records.slice(0, 500) };
  console.log(JSON.stringify(summary, null, 2));
  if (errors.length) {
    console.error('Se han detectado errores; no se enviará la importación.');
    process.exitCode = 1;
  } else if (apply) {
    const password = process.env.WINT_ADMIN_PASSWORD;
    if (!password) throw new Error('Defina WINT_ADMIN_PASSWORD en el entorno para --apply.');
    const origin = new URL(base).origin;
    const login = await fetch(`${origin}/api/admin/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-WINT-CSRF': '1' },
      body: JSON.stringify({ password }),
    });
    if (!login.ok) throw new Error(`Autenticación fallida (${login.status}).`);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    if (!cookie) throw new Error('El servidor no devolvió una cookie de sesión.');
    const headers = { 'content-type': 'application/json', 'X-WINT-CSRF': '1', cookie };
    const preview = await fetch(`${origin}/api/admin/import/preview`, {
      method: 'POST', headers, body: JSON.stringify({ resource, records: checked.records.slice(0, 500) }),
    });
    if (!preview.ok) throw new Error(`Previsualización rechazada (${preview.status}): ${(await preview.text()).slice(0, 300)}`);
    const previewResult = await preview.json() as { valid?: boolean; errors?: string[] };
    if (previewResult.valid !== true) throw new Error(`Previsualización inválida: ${(previewResult.errors ?? []).join('; ')}`);
    let inserted = 0;
    let skipped = 0;
    for (let offset = 0; offset < checked.records.length; offset += 10) {
      const batch = checked.records.slice(offset, offset + 10);
      const response = await fetch(`${origin}/api/admin/import/commit`, {
        method: 'POST', headers, body: JSON.stringify({ resource, records: batch }),
      });
      if (!response.ok) throw new Error(`Lote ${Math.floor(offset / 10) + 1} rechazado (${response.status}): ${(await response.text()).slice(0, 300)}`);
      const result = await response.json() as { inserted?: number; skipped?: number };
      inserted += Number(result.inserted ?? 0);
      skipped += Number(result.skipped ?? 0);
    }
    console.log(JSON.stringify({ inserted, skipped, total: checked.records.length }));
  }
}
