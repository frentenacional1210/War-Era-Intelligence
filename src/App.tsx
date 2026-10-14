import { Activity, Bell, Bot, ChartNoAxesCombined, ChevronDown, Crosshair, DatabaseZap, Factory, Globe2, House, Landmark, LockKeyhole, Map, Menu, Newspaper, PanelLeftClose, Search, Shield, UsersRound, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { getStatus } from './api';
import { useRemote } from './hooks';
import { Badge, Loading } from './components';
import { age, sourceState } from './utils';
import type { ResourceKey } from './types';

const Dashboard = lazy(() => import('./pages').then(module => ({ default: module.Dashboard })));
const Directory = lazy(() => import('./pages').then(module => ({ default: module.Directory })));
const DetailPage = lazy(() => import('./pages').then(module => ({ default: module.DetailPage })));
const MarketPage = lazy(() => import('./pages').then(module => ({ default: module.MarketPage })));
const IndustryPage = lazy(() => import('./pages').then(module => ({ default: module.IndustryPage })));
const StatusPage = lazy(() => import('./pages').then(module => ({ default: module.StatusPage })));
const AdminPage = lazy(() => import('./pages').then(module => ({ default: module.AdminPage })));
const NotFound = lazy(() => import('./pages').then(module => ({ default: module.NotFound })));
const AnalysisPage = lazy(() => import('./analysis').then(module => ({ default: module.AnalysisPage })));
const HistoriesPage = lazy(() => import('./histories'));
const CoveragePage = lazy(() => import('./coverage').then(module => ({ default: module.CoveragePage })));
const GlobalSearchPage = lazy(() => import('./search').then(module => ({ default: module.GlobalSearchPage })));
const WorldExplorerPage = lazy(() => import('./world').then(module => ({ default: module.WorldExplorerPage })));
const PoliticalPage = lazy(() => import('./intelligence').then(module => ({ default: module.PoliticalPage })));
const MilitaryPage = lazy(() => import('./intelligence').then(module => ({ default: module.MilitaryPage })));
const IndustrialPage = lazy(() => import('./industrial').then(module => ({ default: module.IndustrialPage })));
const IntelligenceAIPage = lazy(() => import('./ai').then(module => ({ default: module.IntelligenceAIPage })));
const AlertFeedPage = lazy(() => import('./alerts').then(module => ({ default: module.AlertFeedPage })));
const StrategyPage = lazy(() => import('./strategy').then(module => ({ default: module.StrategyPage })));
const OrderbookPage = lazy(() => import('./orderbook').then(module => ({ default: module.OrderbookPage })));
const PressPage = lazy(() => import('./press').then(module => ({ default: module.PressPage })));

const navigation = [
  { path: '/', label: 'Centro de mando', icon: House },
  { path: '/mundo', label: 'Mundo', icon: Map },
  { path: '/paises', label: 'Países', icon: Globe2 },
  { path: '/jugadores', label: 'Jugadores', icon: UsersRound },
  { path: '/partidos', label: 'Partidos y elecciones', icon: Landmark },
  { path: '/politica', label: 'Gobiernos y elecciones', icon: Landmark },
  { path: '/unidades', label: 'Unidades militares', icon: Shield },
  { path: '/militar', label: 'Análisis militar', icon: Shield },
  { path: '/batallas', label: 'Batallas', icon: Crosshair },
  { path: '/mercados', label: 'Economía y mercados', icon: ChartNoAxesCombined },
  { path: '/industria', label: 'Empresas e industria', icon: Factory },
  { path: '/articulos', label: 'Prensa y artículos', icon: Newspaper },
  { path: '/prensa', label: 'Hemeroteca y temas', icon: Newspaper },
  { path: '/analisis', label: 'Comparadores e históricos', icon: Activity },
  { path: '/historicos', label: 'Históricos', icon: ChartNoAxesCombined },
  { path: '/estrategia', label: 'Informe por país', icon: Activity },
  { path: '/cobertura', label: 'Cobertura del censo', icon: DatabaseZap },
  { path: '/buscar', label: 'Búsqueda global', icon: Search },
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
    <div className="main-column"><header className="topbar"><div className="topbar-left"><button className="mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Abrir menú"><Menu size={21} /></button><span className="topbar-breadcrumb">WINT <span>/</span> {navigation.find(x => location.pathname === x.path || (x.path !== '/' && location.pathname.startsWith(x.path + '/')))?.label ?? (location.pathname === '/estado' ? 'Estado de datos' : 'Explorador')}</span></div><div className="topbar-right"><Link to="/buscar" className="topbar-search"><Search size={15} /> Explorar registros</Link><Link to="/estado" className="topbar-status"><Badge tone={tone}>{label}</Badge></Link><span className="topbar-time" title={status.data?.timestamp}>{status.data ? age(status.data.timestamp) : '—'}</span></div></header><main className="content">{children}</main><footer className="footer"><span>WINT · Plataforma independiente de análisis de WarEra</span><a className="source-link" href="https://github.com/frentenacional1210/War-Era-Intelligence" target="_blank" rel="noopener noreferrer">Código fuente · AGPL-3.0</a><span>Los datos proceden de fuentes públicas indicadas en cada registro.</span></footer></div>
  </div>;
}

function ResourceRoute({ resource }: { resource: ResourceKey }) { return <Directory resource={resource} />; }
function DetailRoute({ resource }: { resource: ResourceKey }) { return <DetailPage resource={resource} />; }

export default function App() {
  return <Shell><Suspense fallback={<Loading label="Abriendo vista…" />}><Routes>
    <Route path="/" element={<Dashboard />} />
    <Route path="/mundo" element={<WorldExplorerPage />} />
    <Route path="/politica" element={<PoliticalPage />} /><Route path="/militar" element={<MilitaryPage />} />
    <Route path="/paises" element={<ResourceRoute resource="countries" />} /><Route path="/paises/:id" element={<DetailRoute resource="countries" />} />
    <Route path="/jugadores" element={<ResourceRoute resource="players" />} /><Route path="/jugadores/:id" element={<DetailRoute resource="players" />} />
    <Route path="/partidos" element={<ResourceRoute resource="parties" />} /><Route path="/partidos/:id" element={<DetailRoute resource="parties" />} />
    <Route path="/unidades" element={<ResourceRoute resource="military-units" />} /><Route path="/unidades/:id" element={<DetailRoute resource="military-units" />} />
    <Route path="/batallas" element={<ResourceRoute resource="battles" />} /><Route path="/batallas/:id" element={<DetailRoute resource="battles" />} />
    <Route path="/mercados" element={<MarketPage />} />
    <Route path="/mercados/ordenes" element={<OrderbookPage />} />
    <Route path="/analisis" element={<AnalysisPage />} />
    <Route path="/historicos" element={<HistoriesPage />} />
    <Route path="/estrategia" element={<StrategyPage />} />
    <Route path="/cobertura" element={<CoveragePage />} /><Route path="/buscar" element={<GlobalSearchPage />} />
    <Route path="/regiones/:id" element={<DetailRoute resource="regions" />} />
    <Route path="/industria" element={<IndustrialPage />} /><Route path="/simulador" element={<IndustryPage />} /><Route path="/empresas" element={<ResourceRoute resource="companies" />} /><Route path="/empresas/:id" element={<DetailRoute resource="companies" />} />
    <Route path="/elecciones" element={<ResourceRoute resource="elections" />} /><Route path="/elecciones/:id" element={<DetailRoute resource="elections" />} />
    <Route path="/gobiernos" element={<ResourceRoute resource="governments" />} /><Route path="/gobiernos/:id" element={<DetailRoute resource="governments" />} />
    <Route path="/articulos" element={<ResourceRoute resource="articles" />} /><Route path="/articulos/:id" element={<DetailRoute resource="articles" />} />
    <Route path="/prensa" element={<PressPage />} />
    <Route path="/ia" element={<IntelligenceAIPage />} />
    <Route path="/alertas" element={<AlertFeedPage />} /><Route path="/alertas/:id" element={<DetailRoute resource="alerts" />} />
    <Route path="/estado" element={<StatusPage />} /><Route path="/admin" element={<AdminPage />} />
    <Route path="/dashboard" element={<Navigate to="/" replace />} /><Route path="*" element={<NotFound />} />
  </Routes></Suspense></Shell>;
}
