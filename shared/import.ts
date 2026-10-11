import Papa from 'papaparse';
import { unzipSync } from 'fflate';

export const MAX_IMPORT_BYTES = 1_048_576;
export const MAX_ZIP_ENTRIES = 10;
export const MAX_IMPORT_RECORDS = 500;
export const MAX_RECORD_BYTES = 8_192;
export const IMPORT_RESOURCES = ['players', 'parties', 'military-units'] as const;
export type ImportResource = typeof IMPORT_RESOURCES[number];
export interface ImportResult {
  records: Record<string, unknown>[];
  errors: string[];
  duplicates: number;
}

const decoder = new TextDecoder('utf-8', { fatal: true });
const idKeys = ['id', '_id', 'userId', 'playerId', 'partyId', 'unitId', 'militaryUnitId'];
const nameKeys = ['name', 'username', 'displayName', 'title'];
const numericFields = ['level', 'experience', 'xp', 'member_count'] as const;
const referenceFields = ['party_id', 'party', 'mu', 'military_unit_id', 'leader_id', 'owner_id'] as const;
const statFields = ['damagesCount', 'damage', 'damages', 'battles', 'wins', 'fights', 'kills'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function publicId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() && value.trim().length <= 100) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function publicNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function sensitiveField(value: Record<string, unknown>): string | null {
  const stack: unknown[] = [value];
  let examined = 0;
  while (stack.length) {
    if (++examined > 2_000) return 'estructura demasiado compleja';
    const item = stack.pop();
    if (Array.isArray(item)) { for (const child of item) stack.push(child); continue; }
    if (!isRecord(item)) continue;
    for (const [key, child] of Object.entries(item)) {
      const normalized = key.replace(/[_\s-]/g, '').toLowerCase();
      if (/(?:password|passwd|pwd|token|secret|credential|apikey|email|phone|mobile|address|privatekey|session|authorization)/.test(normalized) || normalized === 'auth') return key;
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return null;
}

function normalize(value: Record<string, unknown>): Record<string, unknown> | null {
  const id = idKeys.map(key => value[key]).find(v => (typeof v === 'string' && v.trim() !== '') || (typeof v === 'number' && Number.isFinite(v)));
  if (id === undefined || id === null) return null;
  const name = nameKeys.map(key => value[key]).find(v => typeof v === 'string' && v.trim() !== '');
  if (typeof name !== 'string') return null;
  const result: Record<string, unknown> = { id: String(id).trim(), name: name.trim() };
  const country = value.country_id ?? value.countryId ?? value.country;
  if (publicId(country)) result.country_id = publicId(country);
  for (const field of numericFields) {
    const numeric = publicNumber(value[field]);
    if (numeric !== null) result[field] = numeric;
  }
  for (const field of referenceFields) {
    const reference = publicId(value[field]);
    if (reference !== null) result[field] = reference;
  }
  if (isRecord(value.leveling)) {
    const leveling: Record<string, number> = {};
    for (const field of ['level', 'totalXp', 'xp'] as const) {
      const numeric = publicNumber(value.leveling[field]);
      if (numeric !== null) leveling[field] = numeric;
    }
    if (Object.keys(leveling).length) result.leveling = leveling;
    if(result.level===undefined && leveling.level!==undefined)result.level=leveling.level;
    const experience=leveling.totalXp ?? leveling.xp;
    if(result.experience===undefined && experience!==undefined)result.experience=experience;
  }
  if(result.party_id===undefined && result.party!==undefined)result.party_id=result.party;
  if(result.military_unit_id===undefined && result.mu!==undefined)result.military_unit_id=result.mu;
  const activity = value.last_active_at ?? value.lastConnectionAt;
  if (typeof activity === 'string' && Number.isFinite(Date.parse(activity))) result.last_active_at = new Date(activity).toISOString();
  if (isRecord(value.stats)) {
    const stats: Record<string, number> = {};
    for (const field of statFields) {
      const numeric = publicNumber(value.stats[field]);
      if (numeric !== null) stats[field] = numeric;
    }
    if (Object.keys(stats).length) result.stats = stats;
  }
  return result;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

export function validateImport(resource: string, input: unknown): ImportResult {
  const errors: string[] = [];
  if (!IMPORT_RESOURCES.includes(resource as ImportResource)) {
    return { records: [], errors: [`Recurso no admitido: ${resource}`], duplicates: 0 };
  }
  if (!Array.isArray(input)) return { records: [], errors: ['Se esperaba una lista de registros.'], duplicates: 0 };
  if (input.length > MAX_IMPORT_RECORDS) return { records: [], errors: [`Máximo ${MAX_IMPORT_RECORDS} registros por importación.`], duplicates: 0 };
  const records: Record<string, unknown>[] = [];
  const seen = new Map<string, string>();
  let duplicates = 0;
  input.forEach((value, index) => {
    if (!isRecord(value)) { errors.push(`Registro ${index + 1}: no es un objeto.`); return; }
    const sensitive = sensitiveField(value);
    if (sensitive) { errors.push(`Registro ${index + 1}: campo sensible o estructura no admitida (${sensitive}).`); return; }
    const record = normalize(value);
    if (!record) { errors.push(`Registro ${index + 1}: faltan ID o nombre válidos.`); return; }
    if ((record.id as string).length > 100) { errors.push(`Registro ${index + 1}: ID superior a 100 caracteres.`); return; }
    if (new TextEncoder().encode(JSON.stringify(record)).length > MAX_RECORD_BYTES) { errors.push(`Registro ${index + 1}: supera 8 KB.`); return; }
    const signature = canonical(record);
    const old = seen.get(record.id as string);
    if (old !== undefined) {
      duplicates++;
      if (old !== signature) errors.push(`Registro ${index + 1}: ID ${record.id} duplicado con datos distintos; se omite.`);
      return;
    }
    seen.set(record.id as string, signature);
    records.push(record);
  });
  return { records, errors, duplicates };
}

function parseText(fileName: string, bytes: Uint8Array): unknown[] {
  const extension = fileName.toLowerCase().split('.').at(-1);
  const text = decoder.decode(bytes).replace(/^\uFEFF/, '');
  if (extension === 'json') {
    const json: unknown = JSON.parse(text);
    if (Array.isArray(json)) return json;
    if (isRecord(json)) {
      for (const key of ['records', 'items', 'data']) {
        if (Array.isArray(json[key])) return json[key];
      }
      return [json];
    }
    throw new Error('JSON: se esperaba una lista u objeto.');
  }
  if (extension === 'csv') {
    const result = Papa.parse<Record<string, unknown>>(text, { header: true, skipEmptyLines: 'greedy', dynamicTyping: false, transformHeader: h => h.trim() });
    if (result.errors.length) throw new Error(`CSV: ${result.errors[0].message}`);
    if (!result.meta.fields?.length) throw new Error('CSV: faltan cabeceras.');
    return result.data;
  }
  throw new Error('Solo se admiten archivos CSV o JSON dentro del ZIP.');
}

function checkedZipEntries(bytes: Uint8Array): string[] {
  // Read the central directory before decompression. This prevents large or encrypted entries.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65_557); p--) {
    if (view.getUint32(p, true) === 0x06054b50) { end = p; break; }
  }
  if (end < 0) throw new Error('ZIP: directorio central no encontrado.');
  const count = view.getUint16(end + 10, true);
  const total = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  if (count < 1 || count > MAX_ZIP_ENTRIES) throw new Error(`ZIP: máximo ${MAX_ZIP_ENTRIES} entradas.`);
  if (total > MAX_IMPORT_BYTES) throw new Error('ZIP: contenido descomprimido superior a 1 MB.');
  const names: string[] = [];
  let sum = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new Error('ZIP: entrada corrupta.');
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const size = view.getUint32(offset + 24, true);
    const packedSize = view.getUint32(offset + 20, true);
    const length = view.getUint16(offset + 28, true);
    const extra = view.getUint16(offset + 30, true);
    const comment = view.getUint16(offset + 32, true);
    const attributes = view.getUint32(offset + 38, true);
    const localOffset = view.getUint32(offset + 42, true);
    if (offset + 46 + length + extra + comment > bytes.length) throw new Error('ZIP: entrada truncada.');
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + length));
    if ((flags & 1) !== 0 || (flags & 0x40) !== 0) throw new Error('ZIP: archivos cifrados no admitidos.');
    if (method !== 0 && method !== 8) throw new Error('ZIP: método de compresión no admitido.');
    if (size === 0xffffffff) throw new Error('ZIP64 no admitido.');
    if (name.includes('\\') || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '.') || /^[a-zA-Z]:/.test(name)) throw new Error('ZIP: ruta insegura.');
    if (name.endsWith('/') || !/\.(csv|json)$/i.test(name)) throw new Error('ZIP: solo CSV y JSON normales.');
    if (((attributes >>> 16) & 0xf000) === 0xa000) throw new Error('ZIP: enlaces simbólicos no admitidos.');
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('ZIP: cabecera local ausente.');
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    if (localFlags !== flags || localMethod !== method || localOffset + 30 + localNameLength + localExtraLength + packedSize > bytes.length) throw new Error('ZIP: cabeceras inconsistentes.');
    if (decoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength)) !== name) throw new Error('ZIP: nombres inconsistentes.');
    if ((flags & 8) === 0 && (view.getUint32(localOffset + 18, true) !== packedSize || view.getUint32(localOffset + 22, true) !== size)) throw new Error('ZIP: tamaños inconsistentes.');
    names.push(name);
    sum += size;
    if (sum > MAX_IMPORT_BYTES) throw new Error('ZIP: contenido descomprimido superior a 1 MB.');
    offset += 46 + length + extra + comment;
  }
  if (new Set(names).size !== names.length) throw new Error('ZIP: nombres duplicados.');
  return names;
}

export function parseImport(fileName: string, bytes: Uint8Array): ImportResult {
  try {
    if (bytes.length > MAX_IMPORT_BYTES) throw new Error('Archivo superior a 1 MB.');
    let values: unknown[];
    if (/\.zip$/i.test(fileName)) {
      const names = checkedZipEntries(bytes);
      let filteredSize = 0;
      const entries = unzipSync(bytes, { filter: entry => {
        if (!names.includes(entry.name) || entry.originalSize > MAX_IMPORT_BYTES || entry.originalSize < 0) return false;
        filteredSize += entry.originalSize;
        return filteredSize <= MAX_IMPORT_BYTES;
      } });
      values = names.flatMap(name => {
        const entry = entries[name];
        if (!entry) throw new Error(`ZIP: falta ${name}.`);
        if (entry.length > MAX_IMPORT_BYTES) throw new Error('ZIP: entrada superior a 1 MB.');
        return parseText(name, entry);
      });
    } else values = parseText(fileName, bytes);
    if (values.length > MAX_IMPORT_RECORDS) throw new Error(`Máximo ${MAX_IMPORT_RECORDS} registros por importación.`);
    // The resource is selected explicitly in the UI/CLI. Validate IDs and duplicates here.
    const errors: string[] = [];
    const records: Record<string, unknown>[] = [];
    const seen = new Map<string, string>();
    let duplicates = 0;
    values.forEach((value, index) => {
      if (!isRecord(value)) { errors.push(`Registro ${index + 1}: no es un objeto.`); return; }
      const sensitive = sensitiveField(value);
      if (sensitive) { errors.push(`Registro ${index + 1}: campo sensible o estructura no admitida (${sensitive}).`); return; }
      const record = normalize(value);
      if (!record) { errors.push(`Registro ${index + 1}: faltan ID o nombre válidos.`); return; }
      if ((record.id as string).length > 100) { errors.push(`Registro ${index + 1}: ID superior a 100 caracteres.`); return; }
      if (new TextEncoder().encode(JSON.stringify(record)).length > MAX_RECORD_BYTES) { errors.push(`Registro ${index + 1}: supera 8 KB.`); return; }
      const signature = canonical(record);
      const old = seen.get(record.id as string);
      if (old !== undefined) {
        duplicates++;
        if (old !== signature) errors.push(`Registro ${index + 1}: ID ${record.id} duplicado con datos distintos; se omite.`);
        return;
      }
      seen.set(record.id as string, signature);
      records.push(record);
    });
    return { records, errors, duplicates };
  } catch (error) {
    return { records: [], duplicates: 0, errors: [error instanceof Error ? error.message : String(error)] };
  }
}
