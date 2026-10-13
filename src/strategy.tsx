import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge, Empty, ErrorState, Loading, Pagination, Panel, SectionTitle } from './components';
import { request } from './api';
import { HistoryExplorer } from './history';
import { useRemote } from './hooks';
import type { Collection, Row, Source } from './types';
import { date, displayName, number, safeUrl, sourceState } from './utils';

type StrategicReport = {
  country: { id: string; name: string; sourceUrl: string; updatedAt: string };
  coverage: { registeredPlayers: number | null; lastProfileAt: string | null; completedSweeps: number | null; lastScannedAt: string | null };
  politics: { governmentCount: number | null; electionsCaptured: number | null; partiesCaptured: number | null };
  military: { unitsCaptured: number | null; activeBattlesCaptured: number | null };
  industry: { companiesCaptured: number | null; companyCountryAttribution: string };
  events: { id: string; name: string; theme: string; severity: string; updatedAt: string; sourceUrl: string }[];
  press: { id: string; name: string; publishedAt: string | null; sourceUrl: string }[];
  freshness: { id: string; lastSuccess: string | null; status: string }[];
  missing: string[];
  methodology: string;
};
type Found = { id: string; name: string };
const boundedQuery = (value: string) => Array.from(value).reduce((text, character) => {
  const next = text + character, encoder = new TextEncoder();
  return encoder.encode(next).length <= 40 && encoder.encode(next.replace(/[\\%_]/g, '\\$&')).length <= 46 ? next : text;
}, '');
const count = (value: number | null | undefined) => value === null || value === undefined ? 'Sin dato' : number(value);
const original = (url: string | null | undefined, label = 'Fuente original') => safeUrl(url)
  ? <a href={safeUrl(url)!} target="_blank" rel="noopener noreferrer">{label} ↗</a> : null;
const eventThemes: Record<string, string> = { military: 'Militar', territory: 'Territorial', politics: 'Política', economy: 'Economía', community: 'Comunidad', activity: 'Actividad', media: 'Prensa' };
const eventSeverities: Record<string, string> = { info: 'Informativa', notable: 'Destacada', high: 'Alta' };
const missingSpanish: Record<string, string> = {
  'No reliable global player denominator or active-player census.': 'No hay un total mundial fiable de jugadores ni un censo de jugadores activos.',
  'Company country attribution is used only when explicitly supplied.': 'El país de una empresa solo se atribuye cuando su ficha lo indica expresamente.',
  'No measured causal relationship, battle participants, national liquidity or forecast.': 'No se han medido relaciones causales, participantes en batallas, liquidez nacional ni previsiones.',
  'First player sweep for this country is incomplete.': 'El primer recorrido de perfiles de este país aún no está completo.',
  'Government has not been captured for this country.': 'Todavía no se ha capturado un gobierno para este país.',
};
const describeMethod = (value: string) => value.startsWith('Descriptive counts of captured public records;')
  ? 'Recuentos descriptivos de registros públicos capturados. La ausencia de un dato no demuestra que no exista. Las batallas se atribuyen al país defensor en la fuente. Los precios disponibles son globales y no miden liquidez nacional.' : value;

function CountryFinder({ label, selectedId, selectedName, excludedId, onSelect }: {
  label: string; selectedId: string; selectedName?: string; excludedId?: string; onSelect: (item: Found) => void;
}) {
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => { const timer = window.setTimeout(() => { setQuery(draft.trim()); setPage(1); }, 300); return () => window.clearTimeout(timer); }, [draft]);
  const remote = useRemote(() => request<Collection>(`/api/countries?${new URLSearchParams({ q: query, limit: '20', page: String(page), sort: 'name' })}`).then(value => ({ ...value, query, requestedPage: page })), `strategy:countries:${query}:${page}`, 0);
  const current = remote.data?.query === query && remote.data.requestedPage === page ? remote.data : null;
  return <div className="strategy-finder"><label className="form-field"><span>{label}</span><input type="search" value={draft} onChange={event => setDraft(boundedQuery(event.target.value))} placeholder="Buscar país por nombre…" /></label><p className="strategy-finder-current">{selectedId ? <>Seleccionado: <strong>{selectedName ?? `ID ${selectedId}`}</strong></> : 'Elige un país capturado.'}</p>{draft.trim() !== query || !current && !remote.error ? <Loading label="Buscando países…" /> : remote.error ? <ErrorState error={remote.error} onRetry={remote.reload} /> : current?.items.length ? <><div className="strategy-country-results">{current.items.map((row: Row) => { const id = String(row.id ?? ''); return <button key={id} type="button" className={selectedId === id ? 'active' : ''} disabled={id === excludedId} onClick={() => onSelect({ id, name: displayName(row) })}><strong>{displayName(row)}</strong><small>ID {id}{id === excludedId ? ' · Ya seleccionado' : ''}</small></button>; })}</div>{current.total > 20 && <Pagination page={page} total={current.total} limit={20} onPage={setPage} />}</> : <Empty title="Sin países coincidentes" detail="Prueba otro nombre o espera nuevas capturas." />}</div>;
}

function LatestItems({ report }: { report: StrategicReport }) {
  return <div className="strategy-latest"><Panel title="Acontecimientos observados">{report.events.length ? <ul>{report.events.map(item => <li key={item.id}><strong>{item.name}</strong><span>{date(item.updatedAt)} · {(eventThemes[item.theme] ?? item.theme) || 'Tema sin dato'} · {(eventSeverities[item.severity] ?? item.severity) || 'Importancia sin dato'}</span>{original(item.sourceUrl)}</li>)}</ul> : <Empty title="Sin acontecimientos capturados" detail="No hay señales recientes disponibles en este informe." />}</Panel><Panel title="Prensa capturada">{report.press.length ? <ul>{report.press.map(item => <li key={item.id}><Link to={`/articulos/${encodeURIComponent(item.id)}`}>{item.name}</Link><span>Publicación: {date(item.publishedAt)}</span>{original(item.sourceUrl)}</li>)}</ul> : <Empty title="Sin artículos capturados" detail="No hay artículos relacionados disponibles en este informe." />}</Panel></div>;
}

function Report({ report }: { report: StrategicReport }) {
  return <div className="strategy-report"><Panel title={report.country.name} action={<Link to={`/paises/${encodeURIComponent(report.country.id)}`}>Abrir ficha del país ↗</Link>}><div className="strategy-report-head"><span>ID {report.country.id} · Captura de la ficha: {date(report.country.updatedAt)}</span>{original(report.country.sourceUrl)}</div></Panel>
    <div className="strategy-groups"><Panel title="Cobertura del censo"><dl><div><dt>Perfiles de jugadores registrados</dt><dd>{count(report.coverage.registeredPlayers)}</dd></div><div><dt>Recorridos completos</dt><dd>{count(report.coverage.completedSweeps)}</dd></div><div><dt>Último perfil capturado</dt><dd>{date(report.coverage.lastProfileAt)}</dd></div><div><dt>Último recorrido</dt><dd>{date(report.coverage.lastScannedAt)}</dd></div></dl><p>Son perfiles observados por WINT, no la población total ni los jugadores activos.</p></Panel>
      <Panel title="Política registrada"><dl><div><dt>Fichas de gobierno</dt><dd>{count(report.politics.governmentCount)}</dd></div><div><dt>Elecciones capturadas</dt><dd>{count(report.politics.electionsCaptured)}</dd></div><div><dt>Partidos capturados</dt><dd>{count(report.politics.partiesCaptured)}</dd></div></dl><Link to={`/politica?country=${encodeURIComponent(report.country.id)}`}>Explorar cargos y elecciones ↗</Link></Panel>
      <Panel title="Actividad militar capturada"><dl><div><dt>Unidades registradas</dt><dd>{count(report.military.unitsCaptured)}</dd></div><div><dt>Batallas activas capturadas</dt><dd>{count(report.military.activeBattlesCaptured)}</dd></div></dl><p>Estos recuentos no miden fuerza, control territorial ni participación efectiva.</p></Panel>
      <Panel title="Industria atribuida"><dl><div><dt>Empresas con país indicado</dt><dd>{count(report.industry.companiesCaptured)}</dd></div></dl><p>Solo se incluyen empresas cuya ficha declara este país. La atribución no prueba propiedad nacional ni volumen de producción.</p><Link to="/industria">Explorar industria ↗</Link></Panel></div>
    <LatestItems report={report} />
    <Panel title="Fuentes y lagunas" className="section-gap"><div className="strategy-freshness">{report.freshness.map(item => { const state = sourceState({ id: item.id, status: item.status, last_success: item.lastSuccess } as Source); return <div key={item.id}><strong>{item.id}</strong><Badge tone={state.tone}>{state.label}</Badge><span>Última captura: {date(item.lastSuccess)}</span></div>; })}</div>{report.missing.length ? <div className="strategy-missing"><strong>Datos que faltan o no se pueden verificar</strong><ul>{report.missing.map((item, index) => <li key={index}>{missingSpanish[item] ?? item}</li>)}</ul></div> : <p className="strategy-method">El informe no indicó lagunas adicionales; la cobertura sigue limitada a las fuentes capturadas.</p>}<p className="strategy-method">{describeMethod(report.methodology)}</p></Panel>
  </div>;
}

const comparisonRows: { label: string; value: (report: StrategicReport) => number | null | undefined }[] = [
  { label: 'Perfiles registrados', value: report => report.coverage.registeredPlayers },
  { label: 'Recorridos completos', value: report => report.coverage.completedSweeps },
  { label: 'Gobiernos capturados', value: report => report.politics.governmentCount },
  { label: 'Elecciones capturadas', value: report => report.politics.electionsCaptured },
  { label: 'Partidos capturados', value: report => report.politics.partiesCaptured },
  { label: 'Unidades registradas', value: report => report.military.unitsCaptured },
  { label: 'Batallas activas capturadas', value: report => report.military.activeBattlesCaptured },
  { label: 'Empresas atribuidas', value: report => report.industry.companiesCaptured },
];

export function StrategyPage() {
  const [params, setParams] = useSearchParams();
  const country = params.get('country') ?? '';
  const compareRaw = params.get('compare') ?? '';
  const compare = compareRaw !== country ? compareRaw : '';
  const primary = useRemote(() => country ? request<StrategicReport>(`/api/strategy?${new URLSearchParams({ country })}`) : Promise.resolve(null), `strategy:primary:${country}`, 0);
  const secondary = useRemote(() => compare ? request<StrategicReport>(`/api/strategy?${new URLSearchParams({ country: compare })}`) : Promise.resolve(null), `strategy:compare:${compare}`, 0);
  const primaryReport = primary.data?.country.id === country ? primary.data : null;
  const secondaryReport = secondary.data?.country.id === compare ? secondary.data : null;
  const choosePrimary = (item: Found) => setParams(current => { const next = new URLSearchParams(current); next.set('country', item.id); if (next.get('compare') === item.id) next.delete('compare'); return next; });
  const chooseSecondary = (item: Found) => setParams(current => { const next = new URLSearchParams(current); next.set('compare', item.id); return next; });
  return <><SectionTitle eyebrow="INFORMES ESTRATÉGICOS" title="Situación por país" description="Lectura conjunta de cobertura, política, actividad militar, industria y señales públicas capturadas." />
    <p className="strategy-caveat">Cada cifra describe registros disponibles, no el estado completo del juego. Comparar recuentos no demuestra superioridad ni causa de los cambios; la cobertura y las fechas pueden diferir entre países.</p>
    <div className="strategy-selectors"><Panel title="País principal"><CountryFinder label="Buscar país principal" selectedId={country} selectedName={primaryReport?.country.name} excludedId={compare} onSelect={choosePrimary} /></Panel><Panel title="Comparar con otro país"><CountryFinder label="Buscar país para comparar" selectedId={compare} selectedName={secondaryReport?.country.name} excludedId={country} onSelect={chooseSecondary} />{compare && <button type="button" className="btn small strategy-clear" onClick={() => setParams(current => { const next = new URLSearchParams(current); next.delete('compare'); return next; })}>Quitar comparación</button>}</Panel></div>
    {!country ? <div className="section-gap"><Empty title="Elige un país" detail="Selecciona una ficha capturada para preparar el informe." /></div> : <div className="section-gap">{!primaryReport && !primary.error ? <Loading label="Preparando informe…" /> : primary.error ? <ErrorState error={primary.error} onRetry={primary.reload} /> : primaryReport ? <Report report={primaryReport} /> : null}</div>}
    {compare && <div className="section-gap">{!secondaryReport && !secondary.error ? <Loading label="Consultando segundo país…" /> : secondary.error ? <ErrorState error={secondary.error} onRetry={secondary.reload} /> : primaryReport && secondaryReport ? <Panel title="Comparación de registros observados"><p className="strategy-method">Las columnas muestran capturas disponibles por país. Las diferencias pueden reflejar cobertura o fechas distintas; no se calcula una clasificación.</p><div className="strategy-compare-wrap"><table className="strategy-compare"><thead><tr><th scope="col">Medida</th><th scope="col">{primaryReport.country.name}</th><th scope="col">{secondaryReport.country.name}</th></tr></thead><tbody>{comparisonRows.map(row => <tr key={row.label}><th scope="row">{row.label}</th><td>{count(row.value(primaryReport))}</td><td>{count(row.value(secondaryReport))}</td></tr>)}<tr><th scope="row">Ficha del país capturada</th><td>{date(primaryReport.country.updatedAt)}</td><td>{date(secondaryReport.country.updatedAt)}</td></tr><tr><th scope="row">Último perfil observado</th><td>{date(primaryReport.coverage.lastProfileAt)}</td><td>{date(secondaryReport.coverage.lastProfileAt)}</td></tr></tbody></table></div><div className="strategy-compare-links"><Link to={`/paises/${encodeURIComponent(primaryReport.country.id)}`}>Ficha de {primaryReport.country.name} ↗</Link><Link to={`/paises/${encodeURIComponent(secondaryReport.country.id)}`}>Ficha de {secondaryReport.country.name} ↗</Link></div></Panel> : null}</div>}
    {primaryReport && <div className="section-gap"><p className="strategy-history-note">El historial representa capturas de las fichas de país. Los huecos permanecen sin rellenar y la secuencia no atribuye causas a los cambios.</p><HistoryExplorer resource="countries" entities={[{ id: primaryReport.country.id, name: primaryReport.country.name }, ...(secondaryReport ? [{ id: secondaryReport.country.id, name: secondaryReport.country.name }] : [])]} title="Historial observado de países" /></div>}
  </>;
}
