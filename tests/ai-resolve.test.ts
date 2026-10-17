import { describe, expect, it } from 'vitest';
import { createTestDB } from './sqlite-d1';
import { deterministicPlan, looksSpanish, resolveCountries } from '../worker/ai-resolve';
import { runAiQuery, type AiEnv } from '../worker/ai';

const NOW = new Date('2026-10-12T12:00:00.000Z');
const seed = () => {
  const store = createTestDB(), now = NOW.toISOString();
  const country = store.sqlite.prepare('INSERT INTO countries(id,name,code,source_url,updated_at,first_seen,hash,data_json) VALUES(?,?,?,?,?,?,?,?)');
  for (const [id, name, code] of [['es', 'Spain', 'es'], ['fr', 'France', 'fr'], ['de', 'Germany', 'de'], ['gq', 'Equatorial Guinea', 'gq'], ['gn', 'Guinea', 'gn']])
    country.run(id, name, code, `https://warera.io/country/${id}`, now, now, `h-${id}`, '{}');
  const player = store.sqlite.prepare('INSERT INTO players(id,name,country_id,level,source_url,updated_at,first_seen,hash,data_json) VALUES(?,?,?,?,?,?,?,?,?)');
  for (const [id, name] of [['p1', 'Fer37'], ['p2', 'Neo'], ['p3', 'Twin'], ['p4', 'twin']]) player.run(id, name, 'es', 5, `https://warera.io/user/${id}`, now, now, `h-${id}`, '{}');
  store.sqlite.prepare('INSERT INTO military_units(id,name,country_id,source_url,updated_at,first_seen,hash,data_json) VALUES(?,?,?,?,?,?,?,?)')
    .run('u1', 'Tercio Viejo', 'es', 'https://warera.io/mu/u1', now, now, 'h-u1', '{}');
  store.sqlite.prepare('INSERT INTO parties(id,name,country_id,source_url,updated_at,first_seen,hash,data_json) VALUES(?,?,?,?,?,?,?,?)')
    .run('pa1', 'Frente Nacional', 'es', 'https://warera.io/party/pa1', now, now, 'h-pa1', '{}');
  return store;
};

// Regression bank of real-style questions. null means "not confident: let the model plan".
const BANK: [string, { tool: string; ids?: string[]; resource?: string } | null][] = [
  ['Compara España y Francia', { tool: 'country-compare', ids: ['es', 'fr'] }],
  ['Spain vs France', { tool: 'country-compare', ids: ['es', 'fr'] }],
  ['Alemania frente a España', { tool: 'country-compare', ids: ['de', 'es'] }],
  ['¿Quién gobierna en Alemania?', { tool: 'politics', ids: ['de'] }],
  ['Elecciones en España y Francia', { tool: 'politics', ids: ['es', 'fr'] }],
  ['¿Cómo va la presidencia de Francia?', { tool: 'politics', ids: ['fr'] }],
  ['Informe estratégico de Guinea Ecuatorial', { tool: 'strategy', ids: ['gq'] }],
  ['Estrategia de Guinea', { tool: 'strategy', ids: ['gn'] }],
  ['¿Qué tal el ejército de Francia?', { tool: 'strategy', ids: ['fr'] }],
  ['Compara a los jugadores Fer37 y Neo', { tool: 'player-compare', ids: ['p1', 'p2'] }],
  ['Compara Fer37 con Neo', { tool: 'player-compare', ids: ['p1', 'p2'] }],
  ['Unidad «Tercio Viejo»', { tool: 'unit-military', ids: ['u1'] }],
  ['Evolución del jugador Fer37', { tool: 'history', ids: ['p1'], resource: 'players' }],
  ['Histórico del partido Frente Nacional', { tool: 'history', ids: ['pa1'], resource: 'parties' }],
  ['precios del mercado', { tool: 'market-changes' }],
  ['noticias de España', { tool: 'press', ids: ['es'] }],
  ['prensa', { tool: 'press' }],
  ['eventos de hoy', { tool: 'events-24h' }],
  ['cobertura del censo', { tool: 'census' }],
  ['Jugador Twin', null],
  ['elecciones', null],
  ['hola, ¿qué puedes hacer?', null],
];

describe('deterministic Spanish question understanding', () => {
  it.each(BANK)('%s', async (question, expected) => {
    const store = seed();
    try {
      const result = await deterministicPlan(store.db, question);
      if (expected === null) expect(result).toBeNull();
      else expect(result?.plan).toEqual(expected);
    } finally { store.sqlite.close(); }
  });
  it('reports a shared name as ambiguous instead of choosing one', async () => {
    const store = seed();
    try {
      const result = await deterministicPlan(store.db, 'Compara los jugadores Twin y Fer37');
      expect(result?.plan).toEqual({ tool: 'player-compare', ids: ['p1'] });
      expect(result?.notes.join(' ')).toContain('ambiguos');
    } finally { store.sqlite.close(); }
  });
  it('matches the longest country name and keeps question order', async () => {
    const store = seed();
    try {
      expect((await resolveCountries(store.db, 'Guinea Ecuatorial, Guinea y España', 4)).ids).toEqual(['gq', 'gn', 'es']);
    } finally { store.sqlite.close(); }
  });
  it('classifies generated sentences by language', () => {
    expect(looksSpanish('Los datos muestran solo registros observados.')).toBe(true);
    expect(looksSpanish('¿Hay datos?')).toBe(true);
    expect(looksSpanish('The data shows only observed records.')).toBe(false);
  });
});

describe('Spanish answers end to end', () => {
  const env = (store: ReturnType<typeof seed>, replies: unknown[]) => {
    let calls = 0;
    store.sqlite.prepare("UPDATE ai_config SET enabled=1 WHERE id='global'").run();
    return { env: { DB: store.db, AI_ENABLED: 'true', AI_DAILY_BUDGET: '100', AI: { async run() { calls++; return { response: replies.shift() }; } } } as unknown as AiEnv, calls: () => calls };
  };
  it('resolves names without a planning call and retries an English interpretation once in Spanish', async () => {
    const store = seed();
    try {
      const { env: ai, calls } = env(store, [{ insight: 'Both countries have captured records.' }, { insight: 'Ambos países tienen registros capturados.' }]);
      const answer = await runAiQuery(ai, { question: 'Compara España y Francia' }, NOW);
      expect(answer.body).toMatchObject({ tool: 'country-compare', interpretation: 'Ambos países tienen registros capturados.', ai: { available: true } });
      expect((answer.body as { facts: unknown[] }).facts).toHaveLength(2);
      expect((answer.body as { facts: { value: Record<string, unknown> }[] }).facts[0].value).toMatchObject({ code: expect.any(String), players_captured_by_wint: expect.any(Number) });
      expect((answer.body as { assumptions: string[] }).assumptions[0]).toBe('Países reconocidos por nombre: Spain, France.');
      expect(calls()).toBe(2);
    } finally { store.sqlite.close(); }
  });
  it('keeps facts and drops the interpretation when the model insists on English', async () => {
    const store = seed();
    try {
      const { env: ai, calls } = env(store, [{ insight: 'The country has records.' }, { insight: 'The country still has records.' }]);
      const answer = await runAiQuery(ai, { question: 'Elecciones en España' }, NOW);
      expect(answer.body).toMatchObject({ tool: 'politics', interpretation: null, ai: { available: false, reason: 'no-facts' } });
      const compare = await runAiQuery(ai, { question: 'Compara España y Francia' }, NOW);
      expect(compare.body).toMatchObject({ tool: 'country-compare', interpretation: null, ai: { available: false, reason: 'non-spanish-interpretation' } });
      expect((compare.body as { facts: unknown[] }).facts).toHaveLength(2);
      expect(calls()).toBe(2);
    } finally { store.sqlite.close(); }
  });
  it('replaces names a model put in the ID field with collected IDs', async () => {
    const store = seed();
    try {
      const { env: ai } = env(store, [{ tool: 'politics', ids: ['France'] }, { insight: 'No hay elecciones capturadas para ese país.' }]);
      const answer = await runAiQuery(ai, { question: 'Dime qué pasa en France últimamente' }, NOW);
      expect(answer.body).toMatchObject({ tool: 'politics' });
      expect(JSON.stringify((answer.body as { missing: string[] }).missing)).toContain('No hay gobiernos ni elecciones capturados');
      expect((answer.body as { assumptions: string[] }).assumptions[0]).toContain('France');
    } finally { store.sqlite.close(); }
  });
});
