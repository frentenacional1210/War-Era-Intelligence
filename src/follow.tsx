import { Check, RefreshCw, Star, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getDetail } from './api';
import { Badge, Empty, Loading, Panel, SectionTitle } from './components';
import { diffFields, FOLLOW_KEY, FOLLOWABLE, isFollowed, markSeen, MAX_FOLLOWS, readFollows, saveFollows, toggleFollow, trackedFields, type Follow } from './follow-model';
import { useRemote } from './hooks';
import { RESOURCES, type ResourceKey, type Row } from './types';
import { age, date, text } from './utils';

const PATHS: Partial<Record<ResourceKey, string>> = { countries: '/paises', players: '/jugadores', parties: '/partidos', 'military-units': '/unidades',
  battles: '/batallas', companies: '/empresas', elections: '/elecciones', governments: '/gobiernos', regions: '/regiones' };
const LABELS: Record<string, string> = { name: 'Nombre', country_id: 'País', level: 'Nivel', experience: 'Experiencia', party_id: 'Partido',
  military_unit_id: 'Unidad', member_count: 'Miembros', is_active: 'Activo', isActive: 'Activo', status: 'Estado', leader_id: 'Líder',
  president_id: 'Presidencia', vice_president_id: 'Vicepresidencia', votes_count: 'Votos', damagesCount: 'Daño acumulado', currentRound: 'Ronda' };

/** Shared, storage-backed follow list; other tabs update through the storage event. */
function useFollows(): [Follow[], (next: Follow[]) => void] {
  const [list, setList] = useState<Follow[]>(() => readFollows());
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === FOLLOW_KEY) setList(readFollows()); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  return [list, next => { setList(next); saveFollows(next); }];
}

export function FollowButton({ resource, row, name }: { resource: ResourceKey; row: Row; name: string }) {
  const [list, setList] = useFollows();
  if (!FOLLOWABLE.includes(resource)) return null;
  const id = String(row.id ?? ''), followed = isFollowed(list, resource, id), full = !followed && list.length >= MAX_FOLLOWS;
  return <button className={`btn ${followed ? 'primary' : ''}`} aria-pressed={followed} disabled={full}
    title={full ? `Máximo ${MAX_FOLLOWS} registros seguidos` : undefined} onClick={() => setList(toggleFollow(list, resource, row, name))}>
    <Star size={15} fill={followed ? 'currentColor' : 'none'} /> {followed ? 'Siguiendo' : 'Seguir'}</button>;
}

const show = (key: string, value: unknown) => value === undefined || value === null || value === '' ? '—' : key.endsWith('_at') ? date(value) : text(value);

export function FollowPage() {
  const [list, setList] = useFollows();
  const key = list.map(item => `${item.resource}:${item.id}`).join('|');
  const remote = useRemote(() => Promise.all(list.map(item => getDetail(RESOURCES[item.resource].endpoint, item.id).then(detail => detail.item as Row).catch(() => null))), `follows:${key}`);
  const rows = list.map((item, index) => {
    const current = remote.data?.[index] ?? null;
    return { item, current, changes: current ? diffFields(item.seen, trackedFields(current)) : [] };
  }).sort((a, b) => b.changes.length - a.changes.length);
  const changed = rows.filter(row => row.changes.length).length;
  return <>
    <SectionTitle eyebrow="PERSONAL · ESTE NAVEGADOR" title="Seguimiento" description={`Registros que sigues y qué ha cambiado desde tu última visita. Se guardan solo en este navegador (máximo ${MAX_FOLLOWS}).`}
      action={<button className="btn" onClick={remote.reload} disabled={remote.refreshing}><RefreshCw size={15} className={remote.refreshing ? 'spin' : ''} /> Actualizar</button>} />
    {!list.length ? <Panel title="Nada en seguimiento"><Empty title="Aún no sigues ningún registro" detail="Abre la ficha de un país, jugador, partido, unidad, batalla, empresa, elección, gobierno o región y pulsa «Seguir»." /></Panel>
      : remote.loading && !remote.data ? <Loading label="Comprobando cambios…" />
        : <>
          <p className="footnote" role="status">{changed ? `${changed} de ${list.length} registros cambiaron desde que los viste.` : `Sin cambios en los ${list.length} registros seguidos desde tu última visita.`} Se comparan los datos capturados por WINT, no el estado en vivo de WarEra.</p>
          <div className="follow-list">{rows.map(({ item, current, changes }) => {
            const path = PATHS[item.resource];
            return <Panel key={`${item.resource}:${item.id}`} title={`${RESOURCES[item.resource].singular} · ${item.name}`}
              action={<span className="follow-actions">{current && changes.length > 0 && <button className="btn small" onClick={() => setList(markSeen(list, item.resource, current))}><Check size={14} /> Marcar como visto</button>}
                <button className="icon-btn" aria-label={`Dejar de seguir ${item.name}`} title="Dejar de seguir" onClick={() => setList(list.filter(other => other !== item))}><Trash2 size={15} /></button></span>}>
              <div className="follow-body">
                <div className="follow-meta">{current ? changes.length ? <Badge tone="warn">{changes.length} {changes.length === 1 ? 'cambio' : 'cambios'}</Badge> : <Badge tone="good">Sin cambios</Badge> : <Badge tone="bad">No disponible</Badge>}
                  <span>Visto {age(item.seenAt)}</span>{current && <span>Última captura {age(current.updated_at)}</span>}{path && <Link className="text-link" to={`${path}/${encodeURIComponent(item.id)}`}>Abrir ficha</Link>}</div>
                {changes.length > 0 && <table className="data-table follow-changes"><thead><tr><th scope="col">Campo</th><th scope="col">Antes</th><th scope="col">Ahora</th></tr></thead>
                  <tbody>{changes.slice(0, 12).map(change => <tr key={change.key}><td>{LABELS[change.key] ?? change.key.replaceAll('_', ' ')}</td><td>{show(change.key, change.before)}</td><td><strong>{show(change.key, change.after)}</strong></td></tr>)}</tbody></table>}
                {!current && <p className="footnote">No se pudo leer el registro. Puede haber dejado de estar disponible o la API no responde.</p>}
              </div>
            </Panel>;
          })}</div>
        </>}
  </>;
}
