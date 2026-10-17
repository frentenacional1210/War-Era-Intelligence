import { ArrowRight, Crosshair, Factory, Globe2, Landmark, Newspaper, Search, Shield, Star, Swords, TrendingUp, UsersRound, Vote } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { request } from './api';
import { Loading } from './components';
import { useRemote } from './hooks';
import { age, localizedTitle, number } from './utils';
import { readFollows } from './follow-model';
import { productionTable } from '../shared/production';
import type { GameConfig } from '../shared/game-config';
import type { TodayDigest } from '../worker/today';

const NAMES: Record<string, string> = { steel: 'Acero', concrete: 'Hormigón', bread: 'Pan', steak: 'Filete', cookedFish: 'Pescado cocinado', ammo: 'Munición',
  lightAmmo: 'Munición ligera', heavyAmmo: 'Munición pesada', oil: 'Aceite', paper: 'Papel', cocain: 'Cocaína', grain: 'Grano', iron: 'Hierro', lead: 'Plomo',
  livestock: 'Ganado', fish: 'Pescado', limestone: 'Caliza', coca: 'Coca', petroleum: 'Petróleo', wood: 'Madera' };

function useTeasers() {
  return useRemote(async () => {
    const [config, prices, elections] = await Promise.all([
      request<GameConfig>('/api/game-config').catch(() => null),
      request<{ items: { item_id?: string; id?: string; price?: number | string }[] }>('/api/markets/prices?limit=50').catch(() => null),
      request<{ elections: { active: boolean }[] }>('/api/elections/live').catch(() => null),
    ]);
    const map = Object.fromEntries((prices?.items ?? []).map(row => [String(row.item_id ?? row.id), Number(row.price)]));
    const best = config ? productionTable(config, map).find(row => row.valuePerPoint !== null) : undefined;
    return { best: best ? { code: best.code, perPoint: best.valuePerPoint! } : null, openElections: elections?.elections.filter(e => e.active).length ?? null };
  }, 'home-teasers', 300_000);
}

export function HomePage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const teasers = useTeasers();
  const today = useRemote(() => request<TodayDigest>('/api/today'), 'today', 300_000);
  const follows = readFollows().length;
  const submit = (event: FormEvent) => { event.preventDefault(); const q = query.trim().slice(0, 40); if (q.length >= 2) navigate(`/buscar?q=${encodeURIComponent(q)}`); };
  const t = teasers.data, c = today.data?.counts ?? {};
  const highlights = today.data ? Object.values(today.data.sections).flat().sort((a, b) => b.observedAt.localeCompare(a.observedAt)).slice(0, 6) : [];
  const tools = [
    { to: '/herramientas/produccion', icon: Factory, title: '¿Qué me conviene producir?', live: t?.best ? <>Ahora: <b>{NAMES[t.best.code] ?? t.best.code}</b> · {number(t.best.perPoint, 4)} por punto</> : 'Ranking con recetas oficiales y precios reales' },
    { to: '/herramientas/combate', icon: Swords, title: 'Calculadora de combate', live: 'Daño por golpe y coste por 1.000 de daño con tu equipo' },
    { to: '/herramientas/elecciones', icon: Vote, title: '¿Quién va a ganar las elecciones?', live: t?.openElections ? <><b>{t.openElections}</b> {t.openElections === 1 ? 'elección abierta' : 'elecciones abiertas'} ahora</> : 'Recuento real y probabilidad por candidato' },
    { to: '/seguimiento', icon: Star, title: 'Lo que sigues', live: follows ? <><b>{follows}</b> {follows === 1 ? 'registro seguido' : 'registros seguidos'}: mira qué ha cambiado</> : 'Sigue países, jugadores o partidos y vigila sus cambios' },
  ];
  return <div className="home">
    <section className="home-hero" aria-labelledby="home-title">
      <span className="eyebrow">WARERA INTELLIGENCE</span>
      <h1 id="home-title">¿Qué quieres saber hoy?</h1>
      <p>Calcula, compara y anticipa con las reglas oficiales del juego y los datos reales que recoge WINT.</p>
      <form className="home-search" role="search" onSubmit={submit}>
        <Search size={18} aria-hidden="true" /><label htmlFor="home-search" className="visually-hidden">Buscar jugador, país, partido o unidad</label>
        <input id="home-search" type="search" placeholder="Busca un jugador, país, partido o unidad…" value={query} onChange={event => setQuery(event.target.value)} maxLength={40} />
        <button className="btn primary" type="submit">Buscar</button>
      </form>
    </section>

    <section aria-labelledby="home-tools"><h2 id="home-tools" className="home-h2">Herramientas</h2>
      <div className="tool-grid">{tools.map(tool => <Link key={tool.to} to={tool.to} className="tool-card"><tool.icon size={22} aria-hidden="true" /><strong>{tool.title}</strong><span>{teasers.loading && !t && tool.to !== '/seguimiento' && tool.to !== '/herramientas/combate' ? 'Calculando…' : tool.live}</span><em>Abrir <ArrowRight size={14} /></em></Link>)}</div>
    </section>

    <section aria-labelledby="home-today" className="home-today">
      <div className="home-section-head"><h2 id="home-today" className="home-h2">Hoy en WarEra</h2><Link to="/hoy" className="text-link">Resumen completo <ArrowRight size={14} /></Link></div>
      {today.loading && !today.data ? <Loading label="Preparando el resumen…" /> : today.data && <>
        <div className="home-stats">
          <Link to="/hoy"><Crosshair size={16} aria-hidden="true" /><strong>{number(c['battle-observed'] ?? 0)}</strong><span>batallas nuevas</span></Link>
          <Link to="/hoy"><Vote size={16} aria-hidden="true" /><strong>{number(c['election-finished'] ?? 0)}</strong><span>elecciones cerradas</span></Link>
          <Link to="/hoy"><TrendingUp size={16} aria-hidden="true" /><strong>{number(c['price-move'] ?? 0)}</strong><span>movimientos de precio</span></Link>
          <Link to="/hoy"><UsersRound size={16} aria-hidden="true" /><strong>{number(today.data.players.newActive)}</strong><span>jugadores activos nuevos</span></Link>
        </div>
        {highlights.length > 0 && <ul className="home-feed">{highlights.map(item => <li key={item.id}><span>{localizedTitle(item.title)}</span>{item.countryId && <Link to={`/paises/${encodeURIComponent(item.countryId)}`}>{item.countryName ?? 'País'}</Link>}<small>{age(item.observedAt)}</small></li>)}</ul>}
      </>}
    </section>

    <section aria-labelledby="home-explore"><h2 id="home-explore" className="home-h2">Explorar</h2>
      <div className="explore-grid">
        {[{ to: '/paises', icon: Globe2, label: 'Países' }, { to: '/jugadores', icon: UsersRound, label: 'Jugadores' }, { to: '/partidos', icon: Landmark, label: 'Partidos' },
          { to: '/unidades', icon: Shield, label: 'Unidades' }, { to: '/batallas', icon: Crosshair, label: 'Batallas' }, { to: '/mercados', icon: TrendingUp, label: 'Mercados' },
          { to: '/prensa', icon: Newspaper, label: 'Prensa' }, { to: '/estrategia', icon: Landmark, label: 'Comparar países' }]
          .map(item => <Link key={item.to} to={item.to}><item.icon size={18} aria-hidden="true" />{item.label}</Link>)}
      </div>
    </section>
  </div>;
}
