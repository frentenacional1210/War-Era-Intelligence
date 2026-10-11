import { AlertCircle, ArrowDownRight, ArrowRight, ArrowUpRight, ChevronLeft, ChevronRight, Clock3, ExternalLink, LoaderCircle, RefreshCw, Search, Star } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { Row, Source } from './types';
import { age, date, displayName, number, safeUrl, sourceState, text } from './utils';

export function Panel({ title, action, children, className = '' }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}><div className="panel-head"><h2>{title}</h2>{action}</div>{children}</section>;
}
export function SectionTitle({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return <div className="section-title"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>;
}
export function Badge({ children, tone = 'muted' }: { children: ReactNode; tone?: 'good' | 'warn' | 'bad' | 'muted' | 'accent' }) {
  return <span className={`badge ${tone}`}><span className="badge-dot" />{children}</span>;
}
export function SourceMeta({ source, updatedAt, sourceUrl }: { source?: Source | null; updatedAt?: unknown; sourceUrl?: unknown }) {
  const state = sourceState(source);
  const url = safeUrl(sourceUrl);
  return <div className="source-meta"><Badge tone={state.tone}>{state.label}</Badge><span><Clock3 size={13} /> {date(updatedAt ?? source?.last_success)} · {age(updatedAt ?? source?.last_success)}</span>{url && <a href={url} target="_blank" rel="noopener noreferrer">Fuente original <ExternalLink size={12} /></a>}</div>;
}
export function Loading({ label = 'Consultando datos de WINT…' }: { label?: string }) {
  return <div className="state"><LoaderCircle className="spin" size={23} /><strong>{label}</strong></div>;
}
export function ErrorState({ error, onRetry, hasData = false }: { error: string; onRetry?: () => void; hasData?: boolean }) {
  return <div className={`state ${hasData ? 'state-inline' : 'state-error'}`}><AlertCircle size={20} /><div><strong>{hasData ? 'No se pudo actualizar; se muestra la última respuesta.' : 'No se pudo cargar la información.'}</strong><span>{error}</span></div>{onRetry && <button className="btn small" onClick={onRetry}><RefreshCw size={14} /> Reintentar</button>}</div>;
}
export function Empty({ title = 'Sin registros disponibles', detail = 'Todavía no hay datos capturados para esta vista.', children }: { title?: string; detail?: string; children?: ReactNode }) {
  return <div className="state state-empty"><div className="empty-graphic">∅</div><strong>{title}</strong><span>{detail}</span>{children}</div>;
}
export function Metric({ label, value, hint, icon }: { label: string; value: ReactNode; hint?: string; icon?: ReactNode }) {
  return <div className="metric"><div className="metric-label">{label}{icon}</div><div className="metric-value">{value}</div>{hint && <div className="metric-hint">{hint}</div>}</div>;
}
export function SearchBox({ value, onChange, placeholder = 'Buscar por nombre o ID…' }: { value: string; onChange: (value: string) => void; placeholder?: string }) {
  return <label className="search-box"><Search size={16} /><input value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} aria-label={placeholder} /></label>;
}
export function Pagination({ page, total, limit, onPage }: { page: number; total: number; limit: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  return <div className="pagination"><span>{number(total)} registros · Página {page} de {pages}</span><div><button className="icon-btn" onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Página anterior"><ChevronLeft size={17} /></button><button className="icon-btn" onClick={() => onPage(page + 1)} disabled={page >= pages} aria-label="Página siguiente"><ChevronRight size={17} /></button></div></div>;
}
export function RowLink({ row, base, subtitle, end }: { row: Row; base: string; subtitle?: string; end?: ReactNode }) {
  const id = text(row.id, '');
  return <Link className="row-link" to={`${base}/${encodeURIComponent(id)}`}><span className="row-icon">{displayName(row).slice(0, 1).toUpperCase()}</span><span className="row-primary"><strong>{displayName(row)}</strong><small>{subtitle ?? `ID ${id}`}</small></span>{end}<ArrowRight size={16} className="row-arrow" /></Link>;
}
export function ChangeValue({ current, previous, unit = '' }: { current: unknown; previous: unknown; unit?: string }) {
  if (current === null || current === undefined || current === '' || previous === null || previous === undefined || previous === '') return <span className="muted">—</span>;
  const a = Number(current), b = Number(previous);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return <span className="muted">—</span>;
  const delta = (a - b) / b * 100;
  return <span className={`change ${delta >= 0 ? 'positive' : 'negative'}`}>{delta >= 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}{number(Math.abs(delta), 1)}%{unit}</span>;
}
export function FavoriteButton({ selected, onClick }: { selected: boolean; onClick: () => void }) {
  return <button className={`icon-btn ${selected ? 'selected' : ''}`} onClick={onClick} aria-label={selected ? 'Quitar de favoritos' : 'Guardar favorito'} title={selected ? 'Quitar de favoritos' : 'Guardar favorito'}><Star size={17} fill={selected ? 'currentColor' : 'none'} /></button>;
}
