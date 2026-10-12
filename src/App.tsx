import { Activity, Bell, Bot, ChartNoAxesCombined, ChevronDown, Crosshair, DatabaseZap, Factory, Globe2, House, Landmark, LockKeyhole, Map, Menu, Newspaper, PanelLeftClose, Search, Shield, UsersRound, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { getStatus } from './api';
import { useRemote } from './hooks';
import { Badge } from './components';
import { age, sourceState } from './utils';
import { Dashboard, Directory, DetailPage, WorldPage, MarketPage, IndustryPage, AIPage, AlertsPage, StatusPage, AdminPage, NotFound } from './pages';
import type { ResourceKey } from './types';
import { AnalysisPage } from './analysis';

const navigation = [
  { path: '/', label: 'Centro de mando', icon: House },
  { path: '/mundo', label: 'Mundo', icon: Map },
  { path: '/paises', label: 'Países', icon: Globe2 },
  { path: '/jugadores', label: 'Jugadores', icon: UsersRound },
  { path: '/partidos', label: 'Partidos y elecciones', icon: Landmark },
  { path: '/unidades', label: 'Unidades militares', icon: Shield },
  { path: '/batallas', label: 'Batallas', icon: Crosshair },
  { path: '/mercados', label: 'Economía y mercados', icon: ChartNoAxesCombined },
  { path: '/industria', label: 'Empresas e industria', icon: Factory },
  { path: '/articulos', label: 'Prensa y artículos', icon: Newspaper },
  { path: '/analisis', label: 'Comparadores e históricos', icon: Activity },
  { path: '/ia', label: 'Informes de IA', icon: Bot },
  { path: '/alertas', label: 'Alertas', icon: Bell },
  { path: '/admin', label: 'Administración', icon: LockKeyhole },
];

function Shell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  const status = useRemote(getStatus, 'global-status', 90_000);
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);
  const sourceStates = status.data?.sources.map(sourceState) ?? [];
  const badSources = sourceStates.filter(x => x.tone === 'bad').length;
  const goodSources = sourceStates.filter(x => x.tone === 'good').length;
  const label = status.loading ? 'Consultando fuentes' : status.error ? 'API no disponible' : badSources ? `${badSources} fuentes con error` : goodSources ? `${goodSources} fuentes activas` : 'Sin capturas confirmadas';
  const tone = status.error || badSources ? 'bad' : goodSources ? 'good' : 'warn';
  return <div className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
    {mobileOpen && <button className="mobile-scrim" onClick={() => setMobileOpen(false)} aria-label="Cerrar navegación" />}
    <aside className={`sidebar ${mobileOpen ? 'mobile-open' : ''}`}>
      <div className="brand"><Link to="/" className="brand-link"><span className="brand-symbol"><Activity size={24} strokeWidth={2.4} /></span><span className="brand-word"><strong>WINT<span>.</span></strong><small>WARERA INTELLIGENCE</small></span></Link><button className="collapse-btn" onClick={() => setCollapsed(!collapsed)} aria-label="Contraer navegación"><PanelLeftClose size={17} /></button><button className="mobile-close" onClick={() => setMobileOpen(false)} aria-label="Cerrar menú"><X size={19} /></button></div>
      <div className="sidebar-body"><div className="nav-caption">PLATAFORMA <ChevronDown size={12} /></div><nav aria-label="Navegación principal">{navigation.map(item => <NavLink key={item.path} to={item.path} end={item.path === '/'} title={item.label} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><item.icon size={18} strokeWidth={1.8} /><span>{item.label}</span></NavLink>)}</nav></div>
      <Link to="/estado" className="sidebar-status"><DatabaseZap size={17} /><span><strong>Estado de datos</strong><small>{label}</small></span><span className={`status-led ${tone}`} /></Link>
    </aside>
    <div className="main-column"><header className="topbar"><div className="topbar-left"><button className="mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Abrir menú"><Menu size={21} /></button><span className="topbar-breadcrumb">WINT <span>/</span> {navigation.find(x => location.pathname === x.path || (x.path !== '/' && location.pathname.startsWith(x.path + '/')))?.label ?? (location.pathname === '/estado' ? 'Estado de datos' : 'Explorador')}</span></div><div className="topbar-right"><Link to="/jugadores" className="topbar-search"><Search size={15} /> Explorar registros</Link><Link to="/estado" className="topbar-status"><Badge tone={tone}>{label}</Badge></Link><span className="topbar-time" title={status.data?.timestamp}>{status.data ? age(status.data.timestamp) : '—'}</span></div></header><main className="content">{children}</main><footer className="footer"><span>WINT · Plataforma independiente de análisis de WarEra</span><a className="source-link" href="https://github.com/frentenacional1210/War-Era-Intelligence" target="_blank" rel="noopener noreferrer">Código fuente · AGPL-3.0</a><span>Los datos proceden de fuentes públicas indicadas en cada registro.</span></footer></div>
  </div>;
}

function ResourceRoute({ resource }: { resource: ResourceKey }) { return <Directory resource={resource} />; }
function DetailRoute({ resource }: { resource: ResourceKey }) { return <DetailPage resource={resource} />; }

export default function App() {
  return <Shell><Routes>
    <Route path="/" element={<Dashboard />} />
    <Route path="/mundo" element={<WorldPage />} />
    <Route path="/paises" element={<ResourceRoute resource="countries" />} /><Route path="/paises/:id" element={<DetailRoute resource="countries" />} />
    <Route path="/jugadores" element={<ResourceRoute resource="players" />} /><Route path="/jugadores/:id" element={<DetailRoute resource="players" />} />
    <Route path="/partidos" element={<ResourceRoute resource="parties" />} /><Route path="/partidos/:id" element={<DetailRoute resource="parties" />} />
    <Route path="/unidades" element={<ResourceRoute resource="military-units" />} /><Route path="/unidades/:id" element={<DetailRoute resource="military-units" />} />
    <Route path="/batallas" element={<ResourceRoute resource="battles" />} /><Route path="/batallas/:id" element={<DetailRoute resource="battles" />} />
    <Route path="/mercados" element={<MarketPage />} />
    <Route path="/analisis" element={<AnalysisPage />} />
    <Route path="/industria" element={<IndustryPage />} /><Route path="/empresas/:id" element={<DetailRoute resource="companies" />} />
    <Route path="/articulos" element={<ResourceRoute resource="articles" />} /><Route path="/articulos/:id" element={<DetailRoute resource="articles" />} />
    <Route path="/ia" element={<AIPage />} />
    <Route path="/alertas" element={<AlertsPage />} /><Route path="/alertas/:id" element={<DetailRoute resource="alerts" />} />
    <Route path="/estado" element={<StatusPage />} /><Route path="/admin" element={<AdminPage />} />
    <Route path="/dashboard" element={<Navigate to="/" replace />} /><Route path="*" element={<NotFound />} />
  </Routes></Shell>;
}
