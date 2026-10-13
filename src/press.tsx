import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { PressResponse, PressTopic } from '../shared/press';
import { request } from './api';
import { Empty, ErrorState, Loading, Panel, SectionTitle } from './components';
import { useRemote } from './hooks';
import type { Collection, Row } from './types';
import { date, displayName, number, safeUrl } from './utils';

type Filters = { country: string; language: string; from: string; to: string; limit: string };
type Result = PressResponse & { query: string };
const initial: Filters = { country: '', language: '', from: '', to: '', limit: '50' };
const topics: Record<PressTopic, string> = { military: 'Militar', politics: 'Política', economy: 'Economía', community: 'Comunidad', other: 'Sin tema identificado' };
const idPattern = /^[A-Za-z0-9_-]{1,100}$/;
const languagePattern = /^[A-Za-z-]{2,16}$/;

async function countries(): Promise<Row[]> {
  const pages = await Promise.all([1, 2, 3, 4].map(page => request<Collection>(`/api/countries?limit=50&page=${page}&sort=name`)));
  return pages.flatMap(result => result.items);
}

function queryOf(filters: Filters): string {
  const query = new URLSearchParams({ limit: filters.limit });
  if (filters.country) query.set('country', filters.country);
  if (filters.language) query.set('language', filters.language);
  if (filters.from) query.set('from', filters.from);
  if (filters.to) query.set('to', filters.to);
  return query.toString();
}

export function PressPage() {
  const [draft, setDraft] = useState<Filters>(initial);
  const [filters, setFilters] = useState<Filters>(initial);
  const countryList = useRemote(countries, 'press:countries:v1', 0);
  const query = queryOf(filters);
  const remote = useRemote(() => request<PressResponse>(`/api/press?${query}`).then(result => ({ ...result, query })), `press:${query}`, 90_000);
  const data: Result | null = remote.data?.query === query ? remote.data : null;
  const invalid = Boolean(draft.from && draft.to && draft.from > draft.to)
    || Boolean(draft.country && !idPattern.test(draft.country))
    || Boolean(draft.language && !languagePattern.test(draft.language));
  const update = (key: keyof Filters, value: string) => setDraft(current => ({ ...current, [key]: value }));
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!invalid) setFilters({ ...draft, language: draft.language.trim() }); };
  const maxDaily = Math.max(1, ...(data?.trends.daily.map(day => day.count) ?? []));
  return <>
    <SectionTitle eyebrow="HEMEROTECA" title="Prensa capturada" description="Explora títulos, fechas y fuentes de los artículos públicos observados." />
    <p className="press-caveat">Esta hemeroteca usa una muestra de hasta 100 fichas recientes. No lee el contenido de los artículos: los temas se infieren de palabras del título y los artículos relacionados comparten una categoría inferida. No son hechos verificados ni un registro completo de publicaciones.</p>
    <Panel title="Filtrar la muestra">
      <form className="press-form" onSubmit={submit}>
        <label className="form-field"><span>País</span><select value={draft.country} onChange={event => update('country', event.target.value)}><option value="">Todos los países</option>{draft.country && !countryList.data?.some(row => String(row.id) === draft.country) && <option value={draft.country}>ID {draft.country}</option>}{countryList.data?.map(row => <option key={String(row.id)} value={String(row.id)}>{displayName(row)}</option>)}</select></label>
        <label className="form-field"><span>Idioma (código)</span><input value={draft.language} onChange={event => update('language', event.target.value.slice(0, 16))} placeholder="es, en, pt…" list="press-languages" autoComplete="off" /><datalist id="press-languages"><option value="es" /><option value="en" /><option value="pt" /><option value="fr" /><option value="de" /></datalist></label>
        <label className="form-field"><span>Desde (UTC)</span><input type="date" value={draft.from} onChange={event => update('from', event.target.value)} /></label>
        <label className="form-field"><span>Hasta (UTC)</span><input type="date" value={draft.to} onChange={event => update('to', event.target.value)} /></label>
        <label className="form-field"><span>Mostrar</span><select value={draft.limit} onChange={event => update('limit', event.target.value)}><option value="25">25 artículos</option><option value="50">50 artículos</option><option value="100">100 artículos</option></select></label>
        <div className="press-form-actions"><button className="btn primary" type="submit" disabled={invalid}>Aplicar filtros</button><button className="btn" type="button" onClick={() => { setDraft(initial); setFilters(initial); }}>Restablecer</button></div>
      </form>
      {invalid && <p className="press-validation" role="alert">Comprueba el código de idioma y las fechas: la fecha inicial debe ser anterior o igual a la final.</p>}
      {countryList.error && <div className="press-country-error"><ErrorState error={countryList.error} onRetry={countryList.reload} /></div>}
    </Panel>
    <Panel title="Tendencias de la muestra" className="section-gap">
      {!data && !remote.error ? <Loading label="Consultando la hemeroteca…" /> : remote.error ? <ErrorState error={remote.error} onRetry={remote.reload} /> : data ? <>
        <p className="press-sample">{number(data.matched)} fichas coinciden dentro de {number(data.sampled)} fichas muestreadas. Los recuentos siguientes corresponden a esa muestra, no a todas las publicaciones. El idioma se filtra dentro de la muestra reciente de país y fechas.</p>
        <div className="press-trends"><section><h3>Por fecha de publicación</h3>{data.trends.daily.length ? <div className="press-daily">{data.trends.daily.map(day => <div key={day.date}><time dateTime={day.date}>{day.date}</time><span className="press-bar-track"><span style={{ width: `${Math.max(3, day.count / maxDaily * 100)}%` }} /></span><strong>{number(day.count)}</strong></div>)}</div> : <p>Sin fechas de publicación conocidas en esta muestra.</p>}{data.trends.unknownDateCount > 0 && <small>{number(data.trends.unknownDateCount)} fichas sin fecha de publicación.</small>}</section><section><h3>Palabras del título por tema</h3><dl>{data.trends.topics.map(topic => <div key={topic.topic}><dt>{topics[topic.topic]}</dt><dd>{number(topic.count)}</dd></div>)}</dl><small>Un título puede aparecer en varios temas.</small></section></div>
      </> : null}
    </Panel>
    <Panel title="Artículos de la muestra" className="section-gap">
      {!data && !remote.error ? <Loading label="Consultando artículos…" /> : remote.error ? <ErrorState error={remote.error} onRetry={remote.reload} /> : data ? <><p className="press-sample">{number(data.items.length)} de {number(data.matched)} fichas coincidentes mostradas. La cobertura disponible es una muestra de los 100 metadatos capturados más recientes para estos filtros.</p>{data.items.length ? <ol className="press-list">{data.items.map(article => { const source = safeUrl(article.sourceUrl); return <li key={article.id}><div className="press-article-head"><Link to={`/articulos/${encodeURIComponent(article.id)}`}>{article.title || `Artículo ID ${article.id}`}</Link><span>{article.language || 'Idioma sin dato'}</span></div><div className="press-meta"><span>Publicado: {article.publishedAt ? <time dateTime={article.publishedAt}>{date(article.publishedAt)}</time> : 'Sin fecha'}</span><span>Capturado: <time dateTime={article.observedAt}>{date(article.observedAt)}</time></span>{article.countryId && <Link to={`/paises/${encodeURIComponent(article.countryId)}`}>País ID {article.countryId}</Link>}{article.authorId && <Link to={`/jugadores/${encodeURIComponent(article.authorId)}`}>Autor ID {article.authorId}</Link>}</div><div className="press-topics">{article.topics.map(topic => <span key={topic}>{topics[topic]}</span>)}</div><div className="press-links">{source && <a href={source} target="_blank" rel="noopener noreferrer">Fuente original ↗</a>}{article.related.length > 0 && <details><summary>Otros títulos con un tema inferido en común ({article.related.length})</summary><ul>{article.related.map(related => <li key={related.id}><Link to={`/articulos/${encodeURIComponent(related.id)}`}>{related.title || `Artículo ID ${related.id}`}</Link><small>{related.sharedTopics.map(topic => topics[topic]).join(', ')}</small></li>)}</ul></details>}</div></li>; })}</ol> : <Empty title="Sin artículos para estos filtros" detail="No hay fichas coincidentes en la muestra capturada." />}</> : null}
    </Panel>
  </>;
}
