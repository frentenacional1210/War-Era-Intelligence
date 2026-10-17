import { useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AI_LIMITS, economicReport, type AiAnswer, type AiTool } from '../shared/ai';
import type { EconomicScenario } from '../shared/economics';
import { ApiError, request } from './api';
import { Badge, Empty, ErrorState, Loading, Panel, SectionTitle } from './components';
import { useRemote } from './hooks';
import { date, localizedTitle, number, safeUrl } from './utils';

type ToolStatus = {
  enabled: boolean; configured: boolean; bindingAvailable: boolean; model: string;
  requestCountToday: number; maxCallsPerDay: number;
};
type ToolCatalog = { tools: AiTool[]; resources: string[]; limits: typeof AI_LIMITS; status: ToolStatus };
const toolInfo: Record<AiTool, { title: string; detail: string; hint: string }> = {
  census: { title: 'Cobertura de datos', detail: 'Consulta el estado y el número de registros de las fuentes.', hint: 'Ejemplo: «censo».' },
  'country-compare': { title: 'Comparar países', detail: 'Lee fichas públicas de hasta cuatro países.', hint: 'Incluye sus ID en la pregunta.' },
  'entity-search': { title: 'Buscar registros', detail: 'Busca nombres o ID en un tipo de ficha pública.', hint: 'Indica el nombre y el tipo de registro.' },
  'player-compare': { title: 'Comparar jugadores', detail: 'Compara perfiles capturados, niveles y experiencia.', hint: 'Incluye los ID de los jugadores.' },
  'unit-military': { title: 'Unidades militares', detail: 'Consulta nivel, miembros indicados y país de unidades registradas.', hint: 'Incluye los ID de las unidades.' },
  politics: { title: 'Política', detail: 'Consulta gobiernos y elecciones capturados.', hint: 'Incluye el ID del país.' },
  'events-24h': { title: 'Actividad reciente', detail: 'Lee eventos y alertas capturados durante las últimas 24 horas.', hint: 'Ejemplo: «eventos 24h».' },
  'market-changes': { title: 'Precios globales', detail: 'Lee la cotización global actual y la anterior cuando existen.', hint: 'Ejemplo: «precios».' },
  history: { title: 'Historial observado', detail: 'Lee capturas de una ficha durante un periodo; deja visibles los huecos.', hint: 'Indica tipo de ficha, ID y periodo.' },
  strategy: { title: 'Informe por país', detail: 'Resume capturas públicas por país y permite comparar hasta dos países.', hint: 'Incluye uno o dos ID de países en la pregunta.' },
  press: { title: 'Prensa capturada', detail: 'Consulta títulos y metadatos de la muestra de prensa, sin leer artículos.', hint: 'Opcionalmente, indica el ID de un país. Muestra hasta 20 fichas.' },
  economics: { title: 'Cálculo económico', detail: 'Calcula con cifras aportadas por quien consulta; no presupone reglas del juego.', hint: 'Adjunta un escenario desde el comparador industrial.' },
};
const bytes = (value: string) => new TextEncoder().encode(value).length;
const limited = (value: string) => Array.from(value).reduce((result, character) => bytes(result + character) <= AI_LIMITS.questionBytes ? result + character : result, '');
const citationHref = (value: string | null) => value && value.length <= 500 && /^\/api\/[a-z/?=&0-9%_.-]+$/i.test(value) ? value : safeUrl(value);
type AiScenarios = { base: EconomicScenario; upgrade?: EconomicScenario };
const scenariosFromState = (state: unknown): AiScenarios | null => {
  if (!state || typeof state !== 'object' || Array.isArray(state) || !('scenarios' in state)) return null;
  const value = state.scenarios;
  return economicReport(value) ? value as AiScenarios : null;
};
const valueText = (value: unknown) => value === null || value === undefined ? 'Sin dato' :
  typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
const failureText = (cause: unknown) => cause instanceof ApiError && cause.status === 429
  ? 'Se ha agotado el presupuesto diario de consultas de IA. Prueba más adelante.'
  : cause instanceof ApiError && cause.status === 503
    ? 'La interpretación por IA no está disponible ahora. Los datos públicos siguen accesibles en los directorios.'
    : cause instanceof Error ? cause.message : 'No se pudo completar la consulta.';

export function IntelligenceAIPage() {
  const location = useLocation();
  const catalog = useRemote(() => request<ToolCatalog>('/api/ai/tools'), 'ai:tools', 90_000);
  const [scenarios, setScenarios] = useState<AiScenarios | null>(() => scenariosFromState(location.state));
  const [question, setQuestion] = useState('');
  const [asked, setAsked] = useState('');
  const [answer, setAnswer] = useState<AiAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (!text || bytes(text) > AI_LIMITS.questionBytes || busy || !catalog.data?.status.enabled) return;
    setBusy(true); setAnswer(null); setError(null); setAsked(text);
    try {
      setAnswer(await request<AiAnswer>('/api/ai/query', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WINT-CSRF': '1' }, body: JSON.stringify(scenarios ? { question: text, scenarios } : { question: text }) }));
    } catch (cause) { setError(failureText(cause)); }
    finally { setBusy(false); }
  };
  const status = catalog.data?.status;
  return <>
    <SectionTitle eyebrow="INTELIGENCIA ARTIFICIAL" title="Informes de IA" description="Pregunta por registros públicos. Distingue los hechos observados de la interpretación automática." />
    <p className="ai-caveat">La IA consulta herramientas de solo lectura sobre datos capturados. Una respuesta puede estar incompleta o no disponer de interpretación. Comprueba siempre la fecha y la fuente de cada hecho.</p>
    <Panel title="Disponibilidad del servicio">
      {catalog.loading && !catalog.data ? <Loading label="Consultando servicio…" /> : catalog.error ? <ErrorState error={catalog.error} onRetry={catalog.reload} /> : status ? <div className="ai-status"><Badge tone={status.enabled ? 'good' : 'warn'}>{status.enabled ? 'IA disponible' : 'IA no disponible'}</Badge><span>{status.enabled ? `${number(status.requestCountToday)} consultas realizadas hoy de hasta ${number(status.maxCallsPerDay)} permitidas.` : 'La generación está desactivada o no dispone de conexión con el modelo. Puedes seguir consultando los datos públicos.'}</span><Link to="/buscar">Buscar registros sin IA ↗</Link></div> : null}
    </Panel>
    <Panel title="Tu pregunta" className="section-gap">{scenarios && <div className="ai-scenario-attached" role="status"><div><strong>Escenario industrial adjunto</strong><span>{number(scenarios.base.unitsPerDay, 2)} unidades/día · Precio supuesto de venta {number(scenarios.base.salePricePerUnit, 4)} · Comparación con ampliación incluida.</span><small>Estas cifras proceden del comparador industrial y son supuestos editables; la pregunta usará la herramienta económica.</small></div><button className="btn small" type="button" onClick={() => { setScenarios(null); setAnswer(null); }}>Quitar escenario</button></div>}<form className="ai-question" onSubmit={submit}><label htmlFor="ai-question">Pregunta sobre datos observados</label><textarea id="ai-question" value={question} onChange={event => setQuestion(limited(event.target.value))} rows={4} placeholder={scenarios ? 'Por ejemplo: ¿Cómo cambia el resultado al ampliar?' : 'Por ejemplo: ¿Qué datos recientes hay sobre el censo?'} disabled={busy} /><div><small>{number(bytes(question))} de {number(AI_LIMITS.questionBytes)} bytes · No incluyas contraseñas ni información privada.</small><button className="btn primary" type="submit" disabled={busy || !status?.enabled || !question.trim()}>{busy ? 'Consultando…' : 'Consultar'}</button></div></form><p className="ai-hint">Para cálculos económicos, <Link to="/industria">prepara y adjunta un escenario en el comparador industrial ↗</Link>.</p>{!status?.enabled && !catalog.loading && <p className="ai-hint">La consulta estará disponible cuando el servicio de IA figure como activo. <Link to="/cobertura">La cobertura pública se puede explorar ahora.</Link></p>}</Panel>
    {busy && <Loading label="Consultando hechos y preparando informe…" />}
    {error && <div className="section-gap"><ErrorState error={error} /></div>}
    {answer && <div className="ai-answer section-gap" aria-live="polite"><Panel title="Informe consultado" action={<Badge tone={answer.ai.available ? 'good' : 'warn'}>{answer.ai.available ? 'Interpretación disponible' : 'Solo hechos verificados'}</Badge>}><div className="ai-answer-head"><p><strong>Pregunta:</strong> {asked}</p><span>Herramienta: {toolInfo[answer.tool]?.title ?? answer.tool} · Última observación: {date(answer.observedAt)}{answer.cached ? ' · Respuesta reutilizada' : ''}</span></div></Panel>
      <Panel title={`Hechos observados (${number(answer.facts.length)})`} className="section-gap">{answer.facts.length ? <ul className="ai-facts">{answer.facts.map((fact, index) => { const href = citationHref(fact.citation); return <li key={`${localizedTitle(fact.label)}:${index}`}><div><strong>{localizedTitle(fact.label)}</strong><span>Captura: {date(fact.observedAt)}</span></div><pre>{valueText(fact.value)}</pre>{href ? <a href={href} target="_blank" rel="noopener noreferrer">Consultar fuente ↗</a> : <small>Sin enlace de fuente para este cálculo o resumen.</small>}</li>; })}</ul> : <Empty title="Sin hechos disponibles" detail="La herramienta no ha encontrado observaciones para esta consulta." />}</Panel>
      <div className="ai-evidence-grid"><Panel title="Datos faltantes">{answer.missing.length ? <ul className="ai-note-list">{answer.missing.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className="ai-empty-note">La herramienta no comunicó ausencias adicionales; la cobertura puede seguir siendo parcial.</p>}</Panel><Panel title="Supuestos y límites">{answer.assumptions.length ? <ul className="ai-note-list">{answer.assumptions.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className="ai-empty-note">El informe se limita a las capturas que aparecen arriba.</p>}</Panel></div>
      <Panel title="Interpretación automática" className="section-gap">{answer.interpretation ? <p className="ai-interpretation">{answer.interpretation}</p> : <p className="ai-empty-note">No hay una interpretación fiable disponible para esta respuesta. Consulta los hechos y fuentes anteriores.</p>}<p className="ai-explanation">Este texto procede del modelo y puede equivocarse; los hechos y sus fechas se presentan por separado.</p></Panel>
      {answer.citations.length > 0 && <Panel title="Fuentes del informe" className="section-gap"><ul className="ai-citations">{answer.citations.map((citation, index) => { const href = citationHref(citation); return href ? <li key={`${citation}:${index}`}><a href={href} target="_blank" rel="noopener noreferrer">Fuente {index + 1} ↗</a><small>{citation}</small></li> : null; })}</ul></Panel>}
    </div>}
    <Panel title="Herramientas de consulta" className="section-gap"><p className="ai-tools-intro">El servicio elige una herramienta de lectura para cada pregunta. Indica los ID de las fichas cuando quieras una comparación o un historial; no inventa fichas ausentes.</p>{catalog.data ? <div className="ai-tool-grid">{catalog.data.tools.map(tool => { const info = toolInfo[tool]; return <article key={tool}><strong>{info?.title ?? tool}</strong><p>{info?.detail ?? 'Consulta de registros públicos.'}</p><small>{info?.hint ?? ''}</small></article>; })}</div> : catalog.loading ? <Loading /> : null}</Panel>
  </>;
}
