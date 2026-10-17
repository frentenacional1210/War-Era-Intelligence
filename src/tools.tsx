import { ArrowRight, Crosshair, Factory, Info, Landmark, RotateCcw, Swords, Trophy, Vote } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { request } from './api';
import { Badge, Empty, ErrorState, Loading, Panel, SectionTitle } from './components';
import { useRemote } from './hooks';
import { age, date, number } from './utils';
import { skillValue, type GameConfig } from '../shared/game-config';
import { productionPlan, productionTable, type Prices } from '../shared/production';
import { BONUSES, combatEstimate, type Build } from '../shared/combat';
import type { ElectionProjection } from '../shared/election-projection';

/* ---------- shared data ---------- */

const ITEM_NAMES: Record<string, string> = {
  limestone: 'Caliza', grain: 'Grano', livestock: 'Ganado', fish: 'Pescado', iron: 'Hierro', coca: 'Coca', lead: 'Plomo', petroleum: 'Petróleo', wood: 'Madera',
  concrete: 'Hormigón', steel: 'Acero', bread: 'Pan', steak: 'Filete', cookedFish: 'Pescado cocinado', lightAmmo: 'Munición ligera', ammo: 'Munición',
  heavyAmmo: 'Munición pesada', cocain: 'Cocaína', oil: 'Aceite', paper: 'Papel', scraps: 'Chatarra',
  knife: 'Cuchillo', gun: 'Pistola', rifle: 'Rifle', sniper: 'Francotirador', tank: 'Tanque', jet: 'Caza',
};
const itemName = (code: string) => ITEM_NAMES[code] ?? code;
const money = (value: number | null | undefined, digits = 2) => value === null || value === undefined || !Number.isFinite(value) ? '—' : number(value, digits);
const percent = (value: number) => `${number(value * 100, 0)} %`;

type PriceRow = { id?: string; item_id?: string; price?: number | string; captured_at?: string };
function useGameData() {
  const config = useRemote(() => request<GameConfig>('/api/game-config'), 'game-config');
  const prices = useRemote(async () => {
    const data = await request<{ items: PriceRow[] }>('/api/markets/prices?limit=50');
    const map: Prices = {};
    let observedAt: string | null = null;
    for (const row of data.items) {
      const code = String(row.item_id ?? row.id ?? ''), value = Number(row.price);
      if (code && Number.isFinite(value) && value > 0) map[code] = value;
      if (row.captured_at && (!observedAt || row.captured_at > observedAt)) observedAt = row.captured_at;
    }
    return { map, observedAt };
  }, 'tool-prices');
  return { config, prices };
}

function HowItWorks({ children }: { children: ReactNode }) {
  return <details className="tool-method"><summary><Info size={14} aria-hidden="true" /> Cómo se calcula y de dónde salen los datos</summary><div>{children}</div></details>;
}
function Source({ config, pricesAt }: { config?: GameConfig | null; pricesAt?: string | null }) {
  return <p className="tool-source">
    {config && <>Reglas oficiales de WarEra ({config.source === 'live' ? 'consultadas' : 'copia guardada del'} {date(config.fetchedAt)}). </>}
    {pricesAt !== undefined && <>Precios globales observados por WINT {pricesAt ? age(pricesAt) : 'sin fecha'}.</>}
  </p>;
}
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="tool-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

/* ---------- hub ---------- */

export const TOOLS = [
  { path: '/herramientas/produccion', icon: Factory, title: '¿Qué me conviene producir?', text: 'Ranking de rentabilidad con las recetas oficiales y los precios reales del mercado.' },
  { path: '/herramientas/combate', icon: Swords, title: 'Calculadora de combate', text: 'Daño por golpe, por barra de salud y coste por cada 1.000 de daño según tu equipo y habilidades.' },
  { path: '/herramientas/elecciones', icon: Vote, title: 'Predicción electoral', text: 'Recuento en vivo y probabilidad de victoria de cada candidato.' },
  { path: '/estrategia', icon: Landmark, title: 'Comparar países', text: 'Informe de un país o comparación de dos con los datos capturados.' },
];
export function ToolsHub() {
  return <><SectionTitle eyebrow="HERRAMIENTAS" title="Herramientas" description="Respuestas concretas a partir de las reglas oficiales del juego y los datos que capta WINT." />
    <div className="tool-grid">{TOOLS.map(tool => <Link key={tool.path} to={tool.path} className="tool-card"><tool.icon size={22} aria-hidden="true" /><strong>{tool.title}</strong><span>{tool.text}</span><em>Abrir <ArrowRight size={14} /></em></Link>)}</div></>;
}

/* ---------- production ---------- */

export function ProductionTool() {
  const { config, prices } = useGameData();
  const [skill, setSkill] = useState(0);
  const [points, setPoints] = useState<number | null>(null);
  const [chain, setChain] = useState(false);
  const [wage, setWage] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const cfg = config.data, map = prices.data?.map ?? {};
  const barPoints = cfg ? skillValue(cfg, 'production', skill) : 0;
  const usePoints = points ?? barPoints;
  const table = useMemo(() => cfg ? productionTable(cfg, map) : [], [cfg, map]);
  const ranked = table.map(row => {
    const plan = productionPlan(row, usePoints, { produceInputs: chain, wagePerPoint: wage });
    return { row, plan, perPoint: chain ? row.chainValuePerPoint : row.valuePerPoint };
  }).sort((a, b) => (b.plan.profit ?? -Infinity) - (a.plan.profit ?? -Infinity));
  const best = ranked.find(item => item.plan.profit !== null);
  const visible = showAll ? ranked : ranked.slice(0, 8);
  return <><SectionTitle eyebrow="HERRAMIENTA · ECONOMÍA" title="¿Qué me conviene producir?" description="Elige cuántos puntos de producción tienes y te decimos qué fabricar para ganar más con los precios de hoy." />
    {(config.error || prices.error) && <ErrorState error={config.error ?? prices.error ?? ''} onRetry={() => { config.reload(); prices.reload(); }} />}
    {(config.loading && !cfg) || (prices.loading && !prices.data) ? <Loading label="Cargando recetas y precios…" /> : cfg && <div className="tool-layout">
      <Panel title="Tus datos">
        <div className="tool-form">
          <Field label={`Habilidad de producción: nivel ${skill}`} hint={`Barra oficial: ${number(barPoints)} puntos`}>
            <input type="range" min={0} max={10} value={skill} onChange={event => { setSkill(Number(event.target.value)); setPoints(null); }} />
          </Field>
          <Field label="Puntos de producción a usar" hint="Por defecto, una barra completa de tu nivel.">
            <input type="number" min={0} max={100000} value={usePoints} onChange={event => setPoints(Math.max(0, Number(event.target.value) || 0))} />
          </Field>
          <Field label="Salario por punto (opcional)" hint="Si pagas a trabajadores, lo que cuesta cada punto.">
            <input type="number" min={0} step={0.01} value={wage} onChange={event => setWage(Math.max(0, Number(event.target.value) || 0))} />
          </Field>
          <label className="tool-check"><input type="checkbox" checked={chain} onChange={event => setChain(event.target.checked)} /> También produzco yo las materias primas (no las compro)</label>
        </div>
      </Panel>
      <div className="tool-results">
        {best ? <div className="tool-answer" role="status"><Trophy size={22} aria-hidden="true" /><div><span>Lo más rentable ahora</span>
          <strong>{itemName(best.row.code)}</strong>
          <p>Con {number(usePoints)} puntos fabricas {number(best.plan.units, 1)} unidades y ganas <b>{money(best.plan.profit)}</b> ({money(best.perPoint, 4)} por punto).</p></div></div>
          : <Empty title="Sin precios suficientes" detail="Faltan precios de mercado para calcular el beneficio." />}
        <Panel title="Ranking de rentabilidad">
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Ranking de rentabilidad"><table className="data-table tool-table">
            <thead><tr><th scope="col">#</th><th scope="col">Producto</th><th scope="col">Receta oficial</th><th scope="col">Precio</th><th scope="col">Coste insumos</th><th scope="col">Por punto</th><th scope="col">Beneficio</th></tr></thead>
            <tbody>{visible.map(({ row, plan, perPoint }, index) => <tr key={row.code} className={index === 0 && plan.profit !== null ? 'tool-best' : ''}>
              <td>{index + 1}</td><td><strong>{itemName(row.code)}</strong><small>{row.type === 'raw' ? 'Materia prima' : 'Producto'}</small></td>
              <td>{number(row.productionPoints)} {row.productionPoints === 1 ? 'punto' : 'puntos'}{row.needs.length ? ` + ${row.needs.map(need => `${number(need.quantity)} ${itemName(need.code).toLowerCase()}`).join(', ')}` : ''}</td>
              <td>{money(row.price, 3)}</td><td>{chain || !row.needs.length ? '—' : money(row.inputCost, 3)}</td><td>{money(perPoint, 4)}</td>
              <td className={plan.profit !== null && plan.profit < 0 ? 'negative' : 'positive'}>{plan.profit === null ? 'Sin precio' : money(plan.profit)}</td></tr>)}</tbody>
          </table></div>
          {ranked.length > 8 && <button className="btn small tool-more" onClick={() => setShowAll(!showAll)}>{showAll ? 'Ver solo los 8 mejores' : `Ver los ${ranked.length} productos`}</button>}
        </Panel>
        <Source config={cfg} pricesAt={prices.data?.observedAt ?? null} />
        <HowItWorks>
          <p>Para cada producto se usan su <b>receta oficial</b> (puntos de producción e insumos) y el último <b>precio global</b> observado.</p>
          <ul><li>Beneficio = unidades × precio − insumos comprados − salarios.</li><li>Unidades = puntos ÷ puntos por unidad (incluidos los de las materias primas si las produces tú).</li></ul>
          <p>No incluye impuestos, bonificaciones de región, depósitos ni comisiones del mercado; los precios cambian y no reflejan el volumen disponible.</p>
        </HowItWorks>
      </div>
    </div>}
  </>;
}

/* ---------- combat ---------- */

const SKILLS: [keyof Build['skills'], string][] = [['attack', 'Ataque'], ['precision', 'Precisión'], ['criticalChance', 'Prob. crítico'], ['criticalDamages', 'Daño crítico'], ['health', 'Salud']];
const STAT_LABEL: Record<keyof Build['skills'], string> = { attack: '', precision: '%', criticalChance: '%', criticalDamages: '%', health: ' salud' };
const initialBuild: Build = { skills: { attack: 3, precision: 3, criticalChance: 2, criticalDamages: 2, health: 3 }, weapon: 'rifle', ammo: 'ammo', food: 'bread',
  helmetCritDamages: 0, glovesPrecision: 0, bonuses: [], enemyArmor: 0, enemyDodge: 0 };

export function CombatTool() {
  const { config, prices } = useGameData();
  const [build, setBuild] = useState<Build>(initialBuild);
  const [reference, setReference] = useState<ReturnType<typeof combatEstimate> | null>(null);
  const cfg = config.data;
  const update = (patch: Partial<Build>) => setBuild(current => ({ ...current, ...patch }));
  const result = cfg ? combatEstimate(cfg, build, prices.data?.map ?? {}) : null;
  const weapons = cfg?.items.filter(item => item.type === 'weapon') ?? [];
  const ammo = cfg?.items.filter(item => item.usage === 'ammo') ?? [];
  const foods = cfg?.items.filter(item => item.isConsumable && item.flatStats.healthRegenPercent) ?? [];
  const weapon = weapons.find(item => item.code === build.weapon);
  const delta = (now: number | null, before: number | null | undefined) => reference && now !== null && before ? <small className={now >= before ? 'positive' : 'negative'}> ({now >= before ? '+' : ''}{number((now / before - 1) * 100, 1)} %)</small> : null;
  return <><SectionTitle eyebrow="HERRAMIENTA · GUERRA" title="Calculadora de combate" description="Configura tus habilidades, arma y munición: verás cuánto daño haces y cuánto te cuesta cada 1.000 de daño." />
    {config.error && <ErrorState error={config.error} onRetry={config.reload} />}
    {config.loading && !cfg ? <Loading label="Cargando reglas oficiales…" /> : cfg && result && <div className="tool-layout">
      <Panel title="Tu configuración">
        <div className="tool-form">
          <fieldset><legend>Habilidades (nivel 0–10)</legend>{SKILLS.map(([key, label]) => <Field key={key} label={`${label}: nivel ${build.skills[key]} → ${number(skillValue(cfg, key, build.skills[key]))}${STAT_LABEL[key]}`}>
            <input type="range" min={0} max={10} value={build.skills[key]} onChange={event => update({ skills: { ...build.skills, [key]: Number(event.target.value) } })} /></Field>)}</fieldset>
          <fieldset><legend>Equipo</legend>
            <Field label="Arma" hint={weapon ? `Ataque oficial ${weapon.dynamicStats.attack?.join('–')}, crítico ${weapon.dynamicStats.criticalChance?.join('–')} %` : 'Sin arma'}>
              <select value={build.weapon ?? ''} onChange={event => update({ weapon: event.target.value || null, weaponAttack: undefined })}><option value="">Sin arma</option>{weapons.map(item => <option key={item.code} value={item.code}>{itemName(item.code)}</option>)}</select></Field>
            {weapon?.dynamicStats.attack && <Field label={`Ataque de tu arma: ${number(build.weaponAttack ?? (weapon.dynamicStats.attack[0] + weapon.dynamicStats.attack[1]) / 2, 1)}`}>
              <input type="range" min={weapon.dynamicStats.attack[0]} max={weapon.dynamicStats.attack[1]} value={build.weaponAttack ?? Math.round((weapon.dynamicStats.attack[0] + weapon.dynamicStats.attack[1]) / 2)} onChange={event => update({ weaponAttack: Number(event.target.value) })} /></Field>}
            <Field label="Munición"><select value={build.ammo ?? ''} onChange={event => update({ ammo: event.target.value || null })}><option value="">Sin munición</option>{ammo.map(item => <option key={item.code} value={item.code}>{itemName(item.code)} (+{item.flatStats.percentAttack} % ataque)</option>)}</select></Field>
            <Field label="Comida"><select value={build.food ?? ''} onChange={event => update({ food: event.target.value || null })}><option value="">Sin comida</option>{foods.map(item => <option key={item.code} value={item.code}>{itemName(item.code)} (+{item.flatStats.healthRegenPercent} % salud)</option>)}</select></Field>
            <Field label="Daño crítico del casco (%)"><input type="number" min={0} max={150} value={build.helmetCritDamages} onChange={event => update({ helmetCritDamages: Math.max(0, Number(event.target.value) || 0) })} /></Field>
            <Field label="Precisión de los guantes (%)"><input type="number" min={0} max={60} value={build.glovesPrecision} onChange={event => update({ glovesPrecision: Math.max(0, Number(event.target.value) || 0) })} /></Field>
          </fieldset>
          <fieldset><legend>Bonificaciones de la batalla</legend>{Object.entries(BONUSES).map(([key, bonus]) => <label key={key} className="tool-check">
            <input type="checkbox" checked={build.bonuses.includes(key)} onChange={event => update({ bonuses: event.target.checked ? [...build.bonuses, key] : build.bonuses.filter(item => item !== key) })} />
            {bonus.label} ({(cfg.battle[bonus.key] ?? 0) > 0 ? '+' : ''}{number(cfg.battle[bonus.key] ?? 0)} %)</label>)}</fieldset>
          <fieldset><legend>Enemigo</legend>
            <Field label={`Armadura enemiga: ${build.enemyArmor} %`} hint={`Tope oficial ${cfg.skills.armor?.softCap ?? '—'} %`}><input type="range" min={0} max={70} value={build.enemyArmor} onChange={event => update({ enemyArmor: Number(event.target.value) })} /></Field>
            <Field label={`Esquiva enemiga: ${build.enemyDodge} %`} hint={`Tope oficial ${cfg.skills.dodge?.softCap ?? '—'} %`}><input type="range" min={0} max={60} value={build.enemyDodge} onChange={event => update({ enemyDodge: Number(event.target.value) })} /></Field>
          </fieldset>
          <button className="btn small" onClick={() => { setBuild(initialBuild); setReference(null); }}><RotateCcw size={14} /> Restablecer</button>
        </div>
      </Panel>
      <div className="tool-results">
        <div className="tool-answer" role="status"><Crosshair size={22} aria-hidden="true" /><div><span>Daño esperado por golpe</span><strong>{number(result.expectedHit, 0)}{delta(result.expectedHit, reference?.expectedHit)}</strong>
          <p>{number(result.hitsPerBar)} golpes por barra de salud → <b>{number(result.damagePerBar, 0)}</b> de daño{delta(result.damagePerBar, reference?.damagePerBar)}.</p></div></div>
        <div className="tool-kpis">
          <div><span>Coste por 1.000 de daño</span><strong>{money(result.costPer1kDamage, 3)}</strong>{delta(result.costPer1kDamage, reference?.costPer1kDamage)}</div>
          <div><span>Coste por golpe</span><strong>{money(result.costPerHit, 3)}</strong></div>
          <div><span>Golpes por comida</span><strong>{result.hitsPerFood === null ? '—' : number(result.hitsPerFood, 1)}</strong></div>
          <div><span>Puntos de habilidad usados</span><strong>{number(result.skillPoints)}</strong></div>
        </div>
        <Panel title="Desglose">
          <div className="tool-breakdown">
            <div><span>Ataque total</span><strong>{number(result.attack, 1)}</strong></div>
            <div><span>Munición</span><strong>+{number(result.ammoPercent)} %</strong></div>
            <div><span>Bonificaciones</span><strong>{result.bonusPercent >= 0 ? '+' : ''}{number(result.bonusPercent)} %</strong></div>
            <div><span>Probabilidad de acierto</span><strong>{percent(result.hitChance)}</strong></div>
            <div><span>Probabilidad de crítico</span><strong>{percent(result.critChance)}</strong></div>
            <div><span>Daño crítico extra</span><strong>+{number(result.critDamages)} %</strong></div>
            <div><span>Defensa enemiga</span><strong>× {number(result.enemyFactor, 2)}</strong></div>
          </div>
          <div className="tool-actions"><button className="btn small" onClick={() => setReference(result)}>{reference ? 'Actualizar referencia' : 'Fijar como referencia para comparar'}</button>
            {reference && <button className="btn small" onClick={() => setReference(null)}>Quitar referencia</button>}</div>
        </Panel>
        <Source config={cfg} pricesAt={prices.data?.observedAt ?? null} />
        <HowItWorks>
          <p>Los <b>parámetros son oficiales</b> (tablas de habilidades, rangos de armas, munición, comida, bonificaciones, topes y coste de salud por golpe). WarEra no publica cómo se combinan en un golpe; WINT usa este modelo:</p>
          <ul><li>Ataque = habilidad + arma (+4 por cada punto de precisión sobre 100).</li><li>Golpe = ataque × (1 + munición) × (1 + bonificaciones) × acierto × (1 + prob. crítico × daño crítico) × (1 − armadura) × (1 − esquiva).</li>
            <li>Cada golpe cuesta {cfg.user.healthCost ?? 10} de salud; la comida devuelve su % oficial de la salud máxima. Se supone una munición por golpe.</li></ul>
          <p>Úsalo para <b>comparar configuraciones</b> («¿me compensa la munición pesada?»); el valor absoluto puede diferir del juego.</p>
        </HowItWorks>
      </div>
    </div>}
  </>;
}

/* ---------- elections ---------- */

type OpenElection = { id: string; countryId: string; countryName: string | null; type: string | null; votesEndAt: string | null; active: boolean };
type LiveElection = { id: string; type: string | null; status: string | null; votesStartAt: string | null; votesEndAt: string | null; votesCount: number | null; voteSource: string; sourceUrl: string; projection: ElectionProjection };
type LiveResponse = { country: { id: string; name: string | null }; observedAt: string; elections: LiveElection[]; names: { players: Record<string, { name: string; level: number | null }>; parties: Record<string, string> } };
const TYPE_LABEL: Record<string, string> = { president: 'Presidenciales', congress: 'Congreso' };
const CONFIDENCE: Record<ElectionProjection['confidence'], { label: string; tone: 'good' | 'warn' | 'bad' | 'muted' }> = {
  final: { label: 'Resultado final', tone: 'good' }, high: { label: 'Fiabilidad alta', tone: 'good' }, medium: { label: 'Fiabilidad media', tone: 'warn' },
  low: { label: 'Fiabilidad baja', tone: 'warn' }, none: { label: 'Sin datos suficientes', tone: 'muted' },
};
const remaining = (end: string | null) => {
  const ms = Date.parse(end ?? '') - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const hours = Math.floor(ms / 3_600_000), minutes = Math.floor(ms % 3_600_000 / 60_000);
  return hours ? `${hours} h ${minutes} min` : `${minutes} min`;
};

function ElectionCard({ election, names }: { election: LiveElection; names: LiveResponse['names'] }) {
  const p = election.projection, confidence = CONFIDENCE[p.confidence], left = remaining(election.votesEndAt);
  const [all, setAll] = useState(false);
  const shown = all ? p.candidates : p.candidates.slice(0, p.seats + 5);
  return <Panel title={`${TYPE_LABEL[election.type ?? ''] ?? 'Elección'} · ${p.phase === 'live' ? 'votación abierta' : p.phase === 'final' ? 'cerrada' : p.phase === 'not-started' ? 'aún no empieza' : 'estado desconocido'}`} action={<Badge tone={confidence.tone}>{confidence.label}</Badge>}>
    <div className="election-head">
      <div><span>Votos emitidos</span><strong>{number(p.totalVotes)}</strong></div>
      {p.phase === 'live' && <div><span>Proyección al cierre</span><strong>{number(p.projectedTotal)}</strong></div>}
      <div><span>{p.phase === 'live' ? 'Cierra en' : 'Cierre'}</span><strong>{left ?? date(election.votesEndAt)}</strong></div>
      <div><span>{p.seats === 1 ? 'Plaza' : 'Escaños'}</span><strong>{number(p.seats)}</strong></div>
    </div>
    {p.elapsedFraction !== null && p.phase === 'live' && <div className="election-progress" role="progressbar" aria-valuenow={Math.round(p.elapsedFraction * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Tiempo de votación transcurrido"><span style={{ width: `${p.elapsedFraction * 100}%` }} /></div>}
    {p.candidates.length ? <div className="table-scroll" tabIndex={0} role="region" aria-label="Candidatos"><table className="data-table tool-table">
      <thead><tr><th scope="col">#</th><th scope="col">Candidato</th><th scope="col">Votos</th><th scope="col">Porcentaje</th>{p.phase === 'live' && <th scope="col">Proyección</th>}<th scope="col">{p.phase === 'final' ? 'Elegido' : p.seats === 1 ? 'Prob. de ganar' : 'Prob. de escaño'}</th></tr></thead>
      <tbody>{shown.map(c => { const player = names.players[c.user]; const elected = c.rank <= p.seats;
        return <tr key={c.user} className={elected ? 'tool-best' : ''}><td>{c.rank}</td>
          <td><Link className="table-name" to={`/jugadores/${encodeURIComponent(c.user)}`}>{player?.name ?? `Jugador ${c.user.slice(-6)}`}</Link><small>{c.party ? names.parties[c.party] ?? 'Partido sin capturar' : 'Independiente'}{player?.level ? ` · nivel ${player.level}` : ''}</small></td>
          <td>{number(c.votes)}</td><td><span className="share-bar" aria-hidden="true"><span style={{ width: `${c.share * 100}%` }} /></span>{number(c.share * 100, 1)} %</td>
          {p.phase === 'live' && <td>{number(c.projectedVotes)}</td>}
          <td><strong>{p.phase === 'final' ? (elected ? 'Sí' : 'No') : Number.isNaN(c.electedProbability) ? '—' : `${number(c.electedProbability * 100, c.electedProbability > 0.99 || c.electedProbability < 0.01 ? 1 : 0)} %`}</strong></td></tr>; })}</tbody>
    </table></div> : <Empty detail="Sin candidatos publicados." />}
    {p.candidates.length > shown.length || all ? <button className="btn small tool-more" onClick={() => setAll(!all)}>{all ? 'Ver solo los primeros puestos' : `Ver los ${p.candidates.length} candidatos`}</button> : null}
    {p.notes.length > 0 && <ul className="footnote tool-notes">{p.notes.map(note => <li key={note}>{note}</li>)}</ul>}
  </Panel>;
}

export function ElectionTool() {
  const open = useRemote(() => request<{ elections: OpenElection[] }>('/api/elections/live'), 'open-elections');
  const config = useRemote(() => request<GameConfig>('/api/game-config'), 'game-config');
  const countries = useMemo(() => {
    const seen = new Map<string, { id: string; name: string; active: boolean; types: string[] }>();
    for (const e of open.data?.elections ?? []) {
      const current = seen.get(e.countryId) ?? { id: e.countryId, name: e.countryName ?? e.countryId, active: false, types: [] };
      current.active ||= e.active; if (e.type && !current.types.includes(e.type)) current.types.push(e.type);
      seen.set(e.countryId, current);
    }
    return [...seen.values()].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  }, [open.data]);
  const [country, setCountry] = useState<string | null>(null);
  const allCountries = useRemote(async () => (await Promise.all([1, 2, 3, 4].map(page => request<{ items: { id: string; name: string }[] }>(`/api/countries?limit=50&page=${page}&sort=name&order=asc`).catch(() => ({ items: [] })))))
    .flatMap(page => page.items), 'all-countries');
  const chosen = country ?? countries[0]?.id ?? null;
  const live = useRemote(() => chosen ? request<LiveResponse>(`/api/elections/live?country=${encodeURIComponent(chosen)}`) : Promise.resolve(null), `live-elections:${chosen ?? 'none'}`, 120_000);
  const rules = config.data?.election;
  return <><SectionTitle eyebrow="HERRAMIENTA · POLÍTICA" title="Predicción electoral" description="Recuento real de WarEra y probabilidad de cada candidato si se mantiene el ritmo de votación." />
    {open.error && <ErrorState error={open.error} onRetry={open.reload} />}
    <div className="election-picker" role="group" aria-label="Elegir país">
      {open.loading && !open.data ? <Loading label="Buscando elecciones…" /> : countries.length ? countries.map(c => <button key={c.id} className={`chip ${c.id === chosen ? 'active' : ''}`} aria-pressed={c.id === chosen} onClick={() => setCountry(c.id)}>
        {c.active && <span className="live-dot" aria-hidden="true" />}{c.name}<small>{c.types.map(t => TYPE_LABEL[t] ?? t).join(' · ')}{c.active ? ' · en curso' : ''}</small></button>)
        : <p className="tool-source">No hay elecciones abiertas ni cerradas en las últimas 48 horas. Elige un país para ver sus últimas elecciones.</p>}
      <label className="tool-field election-country"><span>Ver otro país</span>
        <select value={chosen ?? ''} onChange={event => setCountry(event.target.value || null)}><option value="">Elige un país…</option>{(allCountries.data ?? []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
    </div>
    {chosen && (live.loading && !live.data ? <Loading label="Consultando el recuento en WarEra…" /> : live.error ? <ErrorState error={live.error} onRetry={live.reload} /> : live.data && <>
      <p className="tool-source">{live.data.country.name ?? 'País'} · recuento consultado a WarEra {age(live.data.observedAt)}. Se actualiza cada 2 minutos.</p>
      <div className="election-list">{live.data.elections.map(e => <ElectionCard key={e.id} election={e} names={live.data!.names} />)}</div>
    </>)}
    <HowItWorks>
      <p>Los votos por candidato son los <b>publicados por WarEra</b> en cada elección. Mientras la votación está abierta, WINT supone que el ritmo de votos se mantiene hasta el cierre y reparte los votos restantes según los porcentajes actuales con incertidumbre (2.000 simulaciones).</p>
      <p>No conoce campañas, coaliciones ni votos de última hora: con pocos votos o al principio, la fiabilidad es baja y así se indica.</p>
      {rules && <p>Reglas oficiales: votación de {rules.electionVoteDurationHours} h; votar exige nivel {rules.voteMinLevel} y {rules.voteMinDaysSinceCitizenshipChange} días de ciudadanía; presentarse, nivel {rules.candidateMinLevel}.</p>}
    </HowItWorks>
  </>;
}

