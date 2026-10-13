import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { economicReport } from '../shared/ai';
import { compareInvestment, compareProductionChain, priceSensitivity, type EconomicScenario } from '../shared/economics';
import { request } from './api';
import { Empty, ErrorState, Loading, Panel, SectionTitle } from './components';
import { useRemote } from './hooks';
import { date, number, safeUrl } from './utils';
import type { Source } from './types';

type Quote = { id: string; name: string; price: number; captured_at: string; source_url?: string | null; country_id?: string | null };
type QuotesResponse = { items: Quote[]; total: number; source: Source | null };
type Assumptions = { rawUnits: number; yieldPerRaw: number; processingPerRaw: number; fixedDaily: number; wagesDaily: number; taxPercent: number; investment: number; extraRawUnits: number; extraWagesDaily: number; upgradeCost: number; budget: number };
type Favorite = { id: string; name: string; input: Quote | null; output: Quote | null; assumptions: Assumptions };
const FAVORITES_KEY = 'wint:industry:scenarios:v1';
const initial: Assumptions = { rawUnits: 1, yieldPerRaw: 1, processingPerRaw: 0, fixedDaily: 0, wagesDaily: 0, taxPercent: 0, investment: 0, extraRawUnits: 0, extraWagesDaily: 0, upgradeCost: 0, budget: 0 };
const fields: { key: keyof Assumptions; label: string; help?: string }[] = [
  { key: 'rawUnits', label: 'Materia prima usada al día' }, { key: 'yieldPerRaw', label: 'Producto obtenido por unidad de materia prima', help: 'Rendimiento supuesto; no verificado como regla de WarEra.' },
  { key: 'processingPerRaw', label: 'Coste de transformación por unidad de materia prima' }, { key: 'fixedDaily', label: 'Coste fijo diario' },
  { key: 'wagesDaily', label: 'Salarios diarios' }, { key: 'taxPercent', label: 'Impuesto supuesto sobre ingresos (%)' },
  { key: 'investment', label: 'Inversión inicial' }, { key: 'extraRawUnits', label: 'Materia prima adicional al ampliar' },
  { key: 'extraWagesDaily', label: 'Salarios diarios adicionales' }, { key: 'upgradeCost', label: 'Coste de ampliación' },
  { key: 'budget', label: 'Presupuesto disponible' },
];
const bytes40 = (value: string) => Array.from(value).reduce((text, character) => new TextEncoder().encode(text + character).length <= 40 ? text + character : text, '');
const validQuote = (value: unknown): value is Quote => {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<Quote>;
  return typeof item.id === 'string' && typeof item.name === 'string' && typeof item.price === 'number' && Number.isFinite(item.price) && item.price >= 0 && typeof item.captured_at === 'string';
};
function readFavorites(): Favorite[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 20).filter((item): item is Favorite => {
      if (!item || typeof item !== 'object') return false;
      const favorite = item as Partial<Favorite>;
      return typeof favorite.id === 'string' && typeof favorite.name === 'string' && favorite.assumptions !== undefined && (favorite.input === null || validQuote(favorite.input)) && (favorite.output === null || validQuote(favorite.output));
    });
  } catch { return []; }
}
const restoredAssumptions = (value: Assumptions): Assumptions => Object.fromEntries(fields.map(field => {
  const raw = value[field.key];
  return [field.key, typeof raw === 'number' && Number.isFinite(raw) ? Math.min(field.key === 'taxPercent' ? 100 : 1_000_000_000, Math.max(0, raw)) : initial[field.key]];
})) as unknown as Assumptions;

function QuotePicker({ title, selected, onSelect }: { title: string; selected: Quote | null; onSelect: (quote: Quote) => void }) {
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => { const timer = window.setTimeout(() => setQuery(draft.trim()), 300); return () => window.clearTimeout(timer); }, [draft]);
  const remote = useRemote(() => request<QuotesResponse>(`/api/markets/prices?${new URLSearchParams({ q: query, limit: '50', sort: 'name', order: 'asc' })}`).then(result => ({ ...result, query })), `industry-quotes:${title}:${query}`, 0);
  const current = remote.data?.query === query ? remote.data : null;
  const choices = (current?.items ?? []).filter(quote => validQuote(quote) && quote.country_id == null);
  return <div className="industrial-picker"><label className="form-field"><span>{title}</span><input type="search" value={draft} onChange={event => setDraft(bytes40(event.target.value))} placeholder="Buscar producto…" /></label>
    {selected && <div className="industrial-selected"><strong>{selected.name}</strong><span>Cotización global observada: {number(selected.price, 4)}</span><small>{date(selected.captured_at)}</small>{safeUrl(selected.source_url) && <a href={safeUrl(selected.source_url)!} target="_blank" rel="noopener noreferrer">Fuente original ↗</a>}</div>}
    {draft.trim() !== query || !current && !remote.error ? <Loading label="Buscando cotizaciones…" /> : remote.error ? <ErrorState error={remote.error} onRetry={remote.reload} /> : choices.length ? <div className="industrial-choices" role="group" aria-label={title}>{choices.map(quote => <button type="button" key={quote.id} className={selected?.id === quote.id ? 'active' : ''} onClick={() => onSelect(quote)}><span>{quote.name}<small>{date(quote.captured_at)}</small></span><strong>{number(quote.price, 4)}</strong></button>)}</div> : <Empty title="Sin cotizaciones" detail="Prueba otro nombre o consulta más adelante." />}
  </div>;
}

export function IndustrialPage() {
  const [input, setInput] = useState<Quote | null>(null);
  const [output, setOutput] = useState<Quote | null>(null);
  const [savedQuote, setSavedQuote] = useState(false);
  const [assumptions, setAssumptions] = useState<Assumptions>(initial);
  const [favoriteName, setFavoriteName] = useState('');
  const [favorites, setFavorites] = useState<Favorite[]>(readFavorites);
  const update = (key: keyof Assumptions, raw: string) => setAssumptions(current => ({ ...current, [key]: Math.min(key === 'taxPercent' ? 100 : 1_000_000_000, Math.max(0, Number(raw) || 0)) }));
  const calculate = useMemo(() => {
    if (!input || !output || assumptions.yieldPerRaw <= 0) return null;
    const a = assumptions, taxRate = a.taxPercent / 100;
    const outputUnits = a.rawUnits * a.yieldPerRaw;
    const base: EconomicScenario = { unitsPerDay: outputUnits, salePricePerUnit: output.price, materialsCostPerUnit: (input.price + a.processingPerRaw) / a.yieldPerRaw, wagesPerDay: a.wagesDaily, fixedCostPerDay: a.fixedDaily, taxRate, investment: a.investment };
    const upgrade: EconomicScenario = { ...base, unitsPerDay: (a.rawUnits + a.extraRawUnits) * a.yieldPerRaw, wagesPerDay: a.wagesDaily + a.extraWagesDaily, investment: a.investment + a.upgradeCost };
    const investment = compareInvestment(base, upgrade);
    const chain = compareProductionChain({ rawUnits: a.rawUnits, rawSalePrice: input.price, outputUnitsPerRawUnit: a.yieldPerRaw, outputSalePrice: output.price, processingCostPerRawUnit: a.processingPerRaw, extraFixedCost: a.fixedDaily + a.wagesDaily, taxRate });
    const produceCost = a.rawUnits * (input.price + a.processingPerRaw) + a.fixedDaily + a.wagesDaily;
    const buyCost = outputUnits * output.price;
    const variableRaw = input.price + a.processingPerRaw;
    const maxRaw = variableRaw > 0 ? Math.floor(Math.max(0, a.budget - a.fixedDaily - a.wagesDaily) / variableRaw) : null;
    const maxBuyOutput = output.price > 0 ? Math.floor(a.budget / output.price) : null;
    return { outputUnits, investment, chain, produceCost, buyCost, maxRaw, maxBuyOutput, sensitivity: priceSensitivity(base, [-0.1, 0, 0.1]), base, upgrade };
  }, [input, output, assumptions]);
  const persist = (next: Favorite[]) => { setFavorites(next); try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(next)); } catch { /* storage may be unavailable */ } };
  const save = () => {
    const name = favoriteName.trim().slice(0, 60) || `Escenario ${new Date().toLocaleDateString('es-ES')}`;
    const favorite: Favorite = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, input, output, assumptions };
    persist([favorite, ...favorites].slice(0, 20)); setFavoriteName('');
  };
  const restore = (favorite: Favorite) => { setInput(favorite.input); setOutput(favorite.output); setAssumptions(restoredAssumptions(favorite.assumptions)); setSavedQuote(Boolean(favorite.input || favorite.output)); };
  const aiScenarios = calculate ? { base: calculate.base, upgrade: calculate.upgrade } : null;
  const aiReady = aiScenarios && economicReport(aiScenarios);
  return <><SectionTitle eyebrow="ANÁLISIS INDUSTRIAL" title="Comparador industrial" description="Contrasta cotizaciones globales observadas con un escenario de costes e inversión que puedes editar." />
    <p className="industrial-caveat">Los precios son cotizaciones globales capturadas, sin volumen ni liquidez verificados. Se usa la misma cotización como precio supuesto de compra y venta. Rendimiento, salarios, costes e impuestos son hipótesis; ninguna fórmula se presenta como mecánica oficial de WarEra.</p>
    <Panel title="Elegir cotizaciones reales"><div className="industrial-pickers"><QuotePicker title="Materia prima" selected={input} onSelect={quote => { setInput(quote); setSavedQuote(false); }} /><QuotePicker title="Producto final" selected={output} onSelect={quote => { setOutput(quote); setSavedQuote(false); }} /></div>{savedQuote && <p className="industrial-saved-note">Has recuperado cotizaciones guardadas en este navegador. Sus precios pueden haber cambiado; selecciona productos de nuevo para usar capturas más recientes.</p>}</Panel>
    <Panel title="Supuestos editables" className="section-gap"><div className="industrial-fields">{fields.map(field => <label className="form-field" key={field.key}><span>{field.label}</span><input type="number" inputMode="decimal" min="0" max={field.key === 'taxPercent' ? 100 : undefined} step="any" value={assumptions[field.key]} onChange={event => update(field.key, event.target.value)} />{field.help && <small>{field.help}</small>}</label>)}</div></Panel>
    <Panel title="Resultados del escenario" className="section-gap">{!input || !output ? <Empty title="Elige dos cotizaciones" detail="Selecciona materia prima y producto final para comparar con precios observados." /> : !calculate ? <Empty title="Indica un rendimiento positivo" detail="El producto obtenido por unidad debe ser mayor que cero." /> : <><div className="industrial-results"><div><span>Producir {number(calculate.outputUnits, 2)} unidades</span><strong data-testid="industrial-produce-cost">{number(calculate.produceCost, 2)}</strong></div><div><span>Comprar la misma cantidad</span><strong data-testid="industrial-buy-cost">{number(calculate.buyCost, 2)}</strong></div><div><span>Diferencia: compra − producción</span><strong className={calculate.buyCost - calculate.produceCost >= 0 ? 'positive' : 'negative'}>{number(calculate.buyCost - calculate.produceCost, 2)}</strong></div><div><span>Beneficio hipotético al vender producto final</span><strong>{number(calculate.investment.base.netProfitPerDay, 2)}</strong></div><div><span>Vender materia prima sin transformar</span><strong>{number(calculate.chain.sellRawProfit, 2)}</strong></div><div><span>Transformar y vender materia prima poseída</span><strong>{number(calculate.chain.transformProfit, 2)}</strong></div><div><span>Beneficio adicional al ampliar</span><strong>{number(calculate.investment.marginalProfitPerDay, 2)}</strong></div><div><span>Recuperación de ampliación</span><strong>{calculate.investment.marginalPaybackDays === null ? 'No calculable' : `${number(calculate.investment.marginalPaybackDays, 1)} días`}</strong></div></div><p className="industrial-formula">Coste de producir = unidades de materia prima × (cotización de materia prima + transformación) + salarios + coste fijo. Comprar = unidades obtenidas × cotización del producto final. Beneficio al vender = ingresos − materia prima − transformación − salarios − coste fijo − impuesto supuesto sobre ingresos. La comparación de vender materia prima frente a transformarla supone que ya la posees: el valor de la materia prima es una oportunidad de venta, no una segunda compra.</p><div className="industrial-sensitivity"><strong>Sensibilidad al precio del producto final</strong>{calculate.sensitivity.map(item => <div key={item.change}><span>{item.change < 0 ? '−10 %' : item.change > 0 ? '+10 %' : 'Precio observado'}</span><span>{number(item.price, 4)}</span><strong>{number(item.profitPerDay, 2)}</strong></div>)}</div><div className="industrial-budget"><strong>Con un presupuesto de {number(assumptions.budget, 2)}</strong><p>Materia prima asequible para producir: {calculate.maxRaw === null ? 'No calculable con coste unitario cero' : `${number(calculate.maxRaw)} unidades (hasta ${number(calculate.maxRaw * assumptions.yieldPerRaw, 2)} de producto)`}. Producto final comprable: {calculate.maxBuyOutput === null ? 'No calculable con precio cero' : `${number(calculate.maxBuyOutput)} unidades`}.</p><small>El presupuesto de producción descuenta primero salarios y coste fijo; después materia prima y transformación. No incluye disponibilidad real ni tarifas de mercado.</small></div>{aiReady && aiScenarios ? <div className="industrial-ai-handoff"><Link className="btn" to="/ia" state={{ scenarios: aiScenarios }}>Llevar este escenario a IA ↗</Link><span>La herramienta económica usará estas cifras como supuestos explícitos. Podrás revisar el escenario antes de consultar.</span></div> : <p className="industrial-ai-handoff">El escenario supera el límite de la herramienta económica de IA; reduce las cifras para llevarlo allí.</p>}</>}</Panel>
    <Panel title="Escenarios guardados en este navegador" className="section-gap"><div className="industrial-favorites"><div className="industrial-save"><label className="form-field"><span>Nombre del escenario</span><input value={favoriteName} maxLength={60} onChange={event => setFavoriteName(event.target.value)} placeholder="Mi escenario" /></label><button className="btn primary" type="button" onClick={save}>Guardar escenario</button></div>{favorites.length ? <ul>{favorites.map(favorite => <li key={favorite.id}><button type="button" onClick={() => restore(favorite)}><strong>{favorite.name}</strong><small>{favorite.input?.name ?? 'Sin materia prima'} → {favorite.output?.name ?? 'Sin producto final'}</small></button><button className="industrial-delete" type="button" onClick={() => persist(favorites.filter(item => item.id !== favorite.id))} aria-label={`Eliminar ${favorite.name}`}>Eliminar</button></li>)}</ul> : <p>Aún no hay escenarios guardados.</p>}</div></Panel>
  </>;
}
