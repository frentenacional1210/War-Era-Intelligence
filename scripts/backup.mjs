/**
 * Private D1 backup with an isolated restore check. Never touches production
 * data: it exports, downloads, restores into in-memory SQLite and records
 * integrity, foreign keys and row counts. Signed export URLs, tokens and SQL
 * stay inside artifacts/private/ (excluded from Git) and are never printed.
 *
 *   npm run backup
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const dir = 'artifacts/private/backups';
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const sqlPath = `${dir}/wint-${stamp}.sql`, logPath = `${dir}/export-${stamp}-private.log`;
mkdirSync(dir, { recursive: true });

function exportOnce() {
  try {
    // Fixed command; the only variable part is the timestamped path built above.
    const output = execSync(`npx wrangler d1 export wint-db --remote --output "${sqlPath}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    writeFileSync(logPath, output, { flag: 'a' });
    return true;
  } catch (error) {
    writeFileSync(logPath, `${error.stdout ?? ''}\n${error.stderr ?? ''}`, { flag: 'a' });
    return false;
  }
}

// Wrangler can fail transiently (an OAuth refresh or the download step); retry once.
let ok = exportOnce() || exportOnce();
if (!existsSync(sqlPath)) {
  // The export may exist remotely with only the download failing: fetch it from the private log.
  const url = readFileSync(logPath, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').match(/https:\/\/\S+r2\.cloudflarestorage\.com\S+/)?.[0];
  if (url) {
    const response = await fetch(url).catch(() => null);
    if (response?.ok) { writeFileSync(sqlPath, Buffer.from(await response.arrayBuffer())); ok = true; }
  }
}
if (!ok || !existsSync(sqlPath)) {
  console.error(`Copia fallida: revisa el registro privado ${logPath} (no se imprime porque puede contener enlaces firmados).`);
  process.exit(1);
}

const sql = readFileSync(sqlPath);
const sha256 = createHash('sha256').update(sql).digest('hex');
const db = new DatabaseSync(':memory:');
db.exec(sql.toString('utf8'));
const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length;
const tables = ['countries', 'players', 'articles', 'battles', 'entity_snapshots', 'market_prices', 'history_rollups', 'events', 'alerts', 'd1_migrations'];
const counts = Object.fromEntries(tables.map(table => {
  try { return [table, db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]; } catch { return [table, null]; }
}));
const lastMigration = db.prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1').get()?.name ?? null;
db.close();

const report = { createdAt: new Date().toISOString(), file: sqlPath, bytes: statSync(sqlPath).size, sha256, isolatedRestore: { engine: 'node:sqlite :memory:', integrity, foreignKeyViolations, counts, lastMigration } };
writeFileSync(`${dir}/wint-${stamp}.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, file: `${dir}/wint-${stamp}.sql (privado)` }, null, 2));
if (integrity !== 'ok' || foreignKeyViolations) { console.error('La restauración aislada no superó las comprobaciones.'); process.exit(2); }
