import { AI_LIMITS, type AiPlan, type AiResource, type AiTool } from '../shared/ai';

/**
 * Deterministic, read-only understanding of Spanish or English questions:
 * keyword tool selection and resolution of collected entity names to IDs.
 * Nothing here calls the model; ambiguous names are reported, never guessed.
 */
type NameRow = { id: string; name: string; code?: string | null };
export type Resolution = { ids: string[]; matched: string[]; ambiguous: string[] };

const OPAQUE_ID = /\b[a-f0-9]{24}\b/gi;
const STOPWORDS = new Set(('de del la las el los y e o u en a al con por para que qué cual cuál cuales cuáles como cómo quien quién ' +
  'es son esta está estan están entre sobre segun según dame dime muestra muestrame muéstrame quiero ver hay tiene tienen su sus mi mis ' +
  'un una unos unas lo le les me te se ya mas más menos muy cuanto cuánto cuantos cuántos vs versus contra hoy ahora ' +
  'the of and or in on at to for with by from is are was what which who how show me give tell compare comparar compara ' +
  'pais país paises países jugador jugadores partido partidos unidad unidades ejercito ejército militar elecciones gobierno ' +
  'country countries player players party parties unit units army military election elections government history historia ' +
  'evolucion evolución estrategia strategy informe report prensa press precios prices mercado market eventos events alertas censo').split(' '));

export const normalize = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();

function displayNames(code: string): string[] {
  const names: string[] = [];
  for (const locale of ['es', 'en']) {
    try {
      const name = new Intl.DisplayNames([locale], { type: 'region' }).of(code.toUpperCase());
      if (name && name.toUpperCase() !== code.toUpperCase()) names.push(name);
    } catch { /* Unknown or non-ISO code: only the stored name is used. */ }
  }
  return names;
}

/** Countries named in the question, by stored name or Spanish/English ISO display name, in question order. */
export async function resolveCountries(db: D1Database, question: string, max: number): Promise<Resolution> {
  const rows = (await db.prepare('SELECT id,name,code FROM countries ORDER BY id LIMIT 400').all<NameRow>()).results;
  const text = ` ${normalize(question)} `;
  const spans: { id: string; name: string; start: number; end: number }[] = [];
  for (const row of rows) {
    const aliases = new Set([row.name, ...(row.code && /^[a-z]{2}$/i.test(row.code) ? displayNames(row.code) : [])].map(normalize).filter(alias => alias.length >= 3));
    for (const alias of aliases) {
      let from = 0;
      for (;;) {
        const at = text.indexOf(` ${alias} `, from);
        if (at < 0) break;
        spans.push({ id: row.id, name: row.name, start: at + 1, end: at + 1 + alias.length });
        from = at + 1;
      }
    }
  }
  // Longest match wins: "guinea" inside "guinea ecuatorial" is not a second country.
  const kept = spans.sort((a, b) => (b.end - b.start) - (a.end - a.start))
    .filter((span, index, all) => !all.slice(0, index).some(other => other.id !== span.id && span.start >= other.start && span.end <= other.end))
    .sort((a, b) => a.start - b.start);
  const ids: string[] = [], matched: string[] = [];
  for (const span of kept) if (!ids.includes(span.id) && ids.length < max) { ids.push(span.id); matched.push(span.name); }
  return { ids, matched, ambiguous: [] };
}

/** Candidate phrases: quoted text first, then 1–4 word windows that are not only stopwords. */
export function namePhrases(question: string): string[] {
  const quoted = [...question.matchAll(/["«“'‘]([^"»”'’]{2,60})["»”'’]/g)].map(match => match[1].trim());
  const words = question.replace(/[«»"“”‘’¿?¡!,;:()]/g, ' ').split(/\s+/).filter(Boolean);
  const windows: string[] = [];
  for (let size = 4; size >= 1; size--) {
    for (let start = 0; start + size <= words.length; start++) {
      const part = words.slice(start, start + size);
      if (part.every(word => STOPWORDS.has(normalize(word)))) continue;
      if (size === 1 && (normalize(part[0]).length < 3 || STOPWORDS.has(normalize(part[0])))) continue;
      windows.push(part.join(' '));
    }
  }
  return [...new Set([...quoted, ...windows].filter(phrase => phrase.length <= 60))].slice(0, 45);
}

/** Exact, case-insensitive name matches; a name shared by several records is ambiguous and not chosen. */
export async function resolveByName(db: D1Database, table: 'players' | 'parties' | 'military_units', question: string, max: number): Promise<Resolution> {
  const phrases = namePhrases(question);
  if (!phrases.length) return { ids: [], matched: [], ambiguous: [] };
  const lowered = phrases.map(phrase => phrase.toLowerCase());
  const rows = (await db.prepare(`SELECT id,name FROM ${table} WHERE name IN (${phrases.map(() => '?').join(',')})
    OR lower(name) IN (${lowered.map(() => '?').join(',')}) ORDER BY id LIMIT 60`).bind(...phrases, ...lowered).all<NameRow>()).results;
  const byName = new Map<string, NameRow[]>();
  for (const row of rows) byName.set(row.name.toLowerCase(), [...(byName.get(row.name.toLowerCase()) ?? []), row]);
  // A longer matched phrase claims its words first; results keep question order.
  const lowerQuestion = question.toLowerCase();
  const claimed: string[] = [];
  for (const name of [...byName.keys()].sort((a, b) => b.length - a.length)) if (!claimed.some(longer => longer.includes(name))) claimed.push(name);
  const ids: string[] = [], matched: string[] = [], ambiguous: string[] = [];
  for (const name of claimed.sort((a, b) => lowerQuestion.indexOf(a) - lowerQuestion.indexOf(b))) {
    const found = byName.get(name)!;
    if (found.length > 1) ambiguous.push(found[0].name);
    else if (ids.length < max) { ids.push(found[0].id); matched.push(found[0].name); }
  }
  return { ids, matched, ambiguous };
}

const has = (text: string, pattern: RegExp) => pattern.test(text);
export const opaqueIds = (question: string, max: number) => [...new Set(question.match(OPAQUE_ID) ?? [])].slice(0, max);

const historyResource = (text: string): AiResource | null =>
  has(text, /\b(jugador|player)/) ? 'players' : has(text, /\b(partido|party|parties)/) ? 'parties'
    : has(text, /\b(unidad|unit|ejercito|army)/) ? 'military-units' : has(text, /\b(precio|price|mercado|market)/) ? 'markets'
      : has(text, /\b(pais|paises|country|countries)/) ? 'countries' : null;
const tableOf = (resource: AiResource) => resource === 'players' ? 'players' : resource === 'parties' ? 'parties' : resource === 'military-units' ? 'military_units' : null;

export type DeterministicPlan = { plan: AiPlan; notes: string[] };

/**
 * A confident plan from keywords plus resolved names, or null to let the model
 * choose. Tools that need IDs are only returned when at least one ID resolved.
 */
export async function deterministicPlan(db: D1Database, question: string): Promise<DeterministicPlan | null> {
  const text = normalize(question);
  const notes: string[] = [];
  const explicit = (max: number) => opaqueIds(question, max);
  const countries = async (max: number) => {
    const direct = explicit(max);
    if (direct.length) return direct;
    const found = await resolveCountries(db, question, max);
    if (found.matched.length) notes.push(`Países reconocidos por nombre: ${found.matched.join(', ')}.`);
    return found.ids;
  };
  const named = async (table: 'players' | 'parties' | 'military_units', label: string) => {
    const direct = explicit(AI_LIMITS.maxIds);
    if (direct.length) return direct;
    const found = await resolveByName(db, table, question, AI_LIMITS.maxIds);
    if (found.matched.length) notes.push(`${label} reconocidos por nombre: ${found.matched.join(', ')}.`);
    if (found.ambiguous.length) notes.push(`Nombres ambiguos no elegidos (varios registros): ${found.ambiguous.join(', ')}. Usa el ID.`);
    return found.ids;
  };
  const withIds = (tool: AiTool, ids: string[], extra: Partial<AiPlan> = {}): DeterministicPlan | null => ids.length ? { plan: { tool, ids, ...extra }, notes } : null;

  if (has(text, /\b(eventos?|alertas?|events?|alerts?)\b/)) return { plan: { tool: 'events-24h' }, notes };
  if (has(text, /\b(prensa|hemeroteca|articulos|noticias|press|news)\b/)) {
    const ids = await countries(1);
    return { plan: { tool: 'press', ...(ids.length ? { ids } : {}) }, notes };
  }
  if (has(text, /\b(precios?|mercados?|prices?|markets?)\b/) && !has(text, /\b(historia|historico|evolucion|history)/)) return { plan: { tool: 'market-changes' }, notes };
  if (has(text, /\b(censo|cobertura|census|coverage)\b/)) return { plan: { tool: 'census' }, notes };
  if (has(text, /\b(historia|historico|historicos|evolucion|tendencia|history|trend)/)) {
    const resource = historyResource(text);
    if (resource === 'countries') return withIds('history', await countries(AI_LIMITS.maxIds), { resource });
    const table = resource && tableOf(resource);
    if (resource && table) return withIds('history', await named(table, 'Registros'), { resource });
    return null;
  }
  if (has(text, /\b(eleccion\w*|gobiern\w*|presiden\w*|congres\w*|politic\w*|election\w*|government\w*|president\w*|politics)\b/))
    return withIds('politics', await countries(AI_LIMITS.maxIds));
  if (has(text, /\b(estrategia|estrategico|informe|strategy|strategic|report)\b/)) return withIds('strategy', await countries(2));
  if (has(text, /\b(unidad|unidades|unit|units)\b/)) {
    const units = await named('military_units', 'Unidades');
    if (units.length) return withIds('unit-military', units);
  }
  if (has(text, /\b(ejercito|ejercitos|militar|fuerza|army|military)\b/)) {
    // Country-level military questions use the strategic counts (units, active battles).
    const ids = await countries(2);
    if (ids.length) return withIds('strategy', ids);
  }
  if (has(text, /\b(jugador|jugadores|player|players)\b/)) return withIds('player-compare', await named('players', 'Jugadores'));
  if (has(text, /\b(compara|comparar|comparacion|compare|vs|versus|frente)\b/)) {
    const ids = await countries(AI_LIMITS.maxIds);
    if (ids.length) return withIds('country-compare', ids);
    const players = await named('players', 'Jugadores');
    if (players.length) return withIds('player-compare', players);
    return null;
  }
  return null;
}

/** Fill or replace IDs of a model plan when it named entities instead of giving collected IDs. */
export async function resolvePlanIds(db: D1Database, question: string, plan: AiPlan): Promise<{ plan: AiPlan; notes: string[] }> {
  const needs = ['country-compare', 'player-compare', 'unit-military', 'politics', 'strategy', 'history'];
  if (!needs.includes(plan.tool)) return { plan, notes: [] };
  const ids = plan.ids ?? [];
  if (ids.length && ids.every(id => /^[a-f0-9]{24}$/i.test(id))) return { plan, notes: [] };
  const max = plan.tool === 'strategy' ? 2 : AI_LIMITS.maxIds;
  const direct = opaqueIds(question, max);
  if (direct.length) return { plan: { ...plan, ids: direct }, notes: [] };
  const resource = plan.tool === 'history' ? plan.resource : plan.tool === 'player-compare' ? 'players' : plan.tool === 'unit-military' ? 'military-units' : 'countries';
  if (resource === 'countries') {
    const found = await resolveCountries(db, question, max);
    return found.ids.length ? { plan: { ...plan, ids: found.ids }, notes: [`Países reconocidos por nombre: ${found.matched.join(', ')}.`] } : { plan, notes: [] };
  }
  const table = resource ? tableOf(resource) : null;
  if (!table) return { plan, notes: [] };
  const found = await resolveByName(db, table, question, max);
  const notes = [...(found.matched.length ? [`Registros reconocidos por nombre: ${found.matched.join(', ')}.`] : []),
    ...(found.ambiguous.length ? [`Nombres ambiguos no elegidos (varios registros): ${found.ambiguous.join(', ')}. Usa el ID.`] : [])];
  return found.ids.length ? { plan: { ...plan, ids: found.ids }, notes } : { plan, notes };
}

const SPANISH = new Set('el la los las de del que y en un una por con para se no es son esta está datos registros más solo sólo sin observados públicos hay muestra pero como sus su'.split(' '));
const ENGLISH = new Set('the of and is are to in for with data records this that not only shows there but as its their be'.split(' '));
/** Heuristic language check for a short generated sentence. */
export function looksSpanish(text: string): boolean {
  if (/[ñ¿¡]/i.test(text)) return true;
  const words = text.toLowerCase().normalize('NFC').split(/[^a-záéíóúüñ]+/).filter(Boolean);
  const es = words.filter(word => SPANISH.has(word)).length, en = words.filter(word => ENGLISH.has(word)).length;
  return es > en && es >= 1;
}
