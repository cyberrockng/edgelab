import { lazy, Suspense, useEffect, useRef } from "react";
import {
  createBrowserRouter, Link, Navigate, NavLink, Outlet, RouterProvider,
  useLocation, useParams, useSearchParams
} from "react-router-dom";

const HomePage = lazy(() => import("./pages/HomePage.js"));
const MarketsPage = lazy(() => import("./pages/MarketsPage.js"));
const MarketDetailPage = lazy(() => import("./pages/MarketDetailPage.js"));
const LabPage = lazy(() => import("./pages/LabPage.js"));
const ExperimentWorkspacePage = lazy(() => import("./pages/ExperimentWorkspacePage.js"));
const ComparePage = lazy(() => import("./pages/ComparePage.js"));
const EvidencePage = lazy(() => import("./pages/EvidencePage.js"));
const ExecutionCandidatePage = lazy(() => import("./pages/ExecutionCandidatePage.js"));
const ArchivePage = lazy(() => import("./pages/ArchivePage.js"));
const HowItWorksPage = lazy(() => import("./pages/HowItWorksPage.js"));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage.js"));

const navItems = [
  { to: "/", label: "Overview", end: true },
  { to: "/lab", label: "Lab", end: false },
  { to: "/markets", label: "Markets", end: false }
] as const;

function routeTitleFromPath(pathname: string): string {
  if (pathname === "/") return "EdgeLab";
  if (pathname.startsWith("/markets/")) return "Market Detail";
  if (pathname.startsWith("/lab/compare")) return "Compare Assessments";
  if (pathname.startsWith("/lab/")) return "Experiment";
  if (pathname.startsWith("/evidence/archive")) return "Evidence Archive";
  const titles: Record<string, string> = { markets: "Markets", lab: "Lab", "how-it-works": "Methodology" };
  return titles[pathname.split("/").filter(Boolean)[0] ?? ""] ?? "Route Not Found";
}

function MobileNavigation() {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  return (
    <details className="mobileNav" ref={detailsRef}>
      <summary>Menu</summary>
      <nav aria-label="EdgeLab mobile navigation">
        {navItems.map((item) => (
          <NavLink end={item.end} to={item.to} key={item.to} onClick={() => { detailsRef.current?.removeAttribute("open"); }} className={({ isActive }) => (isActive ? "active" : undefined)}>
            {item.label}
          </NavLink>
        ))}
      </nav>
    </details>
  );
}

function RootLayout() {
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const mountedRef = useRef(false);
  const routeTitle = routeTitleFromPath(location.pathname);
  useEffect(() => {
    document.title = routeTitle === "EdgeLab" ? "EdgeLab" : `${routeTitle} - EdgeLab`;
    if (mountedRef.current) mainRef.current?.focus();
    else mountedRef.current = true;
  }, [location.pathname, routeTitle]);
  return (
    <div className="appShell">
      <a className="skipLink" href="#main-content">Skip to content</a>
      <header className="appHeader">
        <Link className="brandLockup" to="/" aria-label="EdgeLab overview">
          <span className="brandMark" aria-hidden="true">EL</span>
          <span className="brandCopy"><strong>EdgeLab</strong><small>Strategy evidence lab</small></span>
        </Link>
        <nav className="topNav" aria-label="EdgeLab product navigation">
          {navItems.map((item) => (
            <NavLink end={item.end} to={item.to} key={item.to} className={({ isActive }) => (isActive ? "active" : undefined)}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <MobileNavigation />
        <span className="environmentBadge">Mainnet research · testnet execution</span>
      </header>
      <main id="main-content" ref={mainRef} tabIndex={-1} className="routeMain">
        <Suspense fallback={<div className="stateBox" role="status">Loading view…</div>}><Outlet /></Suspense>
      </main>
      <footer className="systemStatus" aria-label="System status">
        <nav aria-label="Footer links">
          <Link to="/how-it-works">Methodology</Link>
          <a href="https://github.com/cyberrockng/edgelab/blob/main/docs/SDK_FEEDBACK.md" target="_blank" rel="noreferrer">SDK feedback</a>
          <a href="https://github.com/cyberrockng/edgelab" target="_blank" rel="noreferrer">Source repository</a>
        </nav>
        <details>
          <summary>Technical details</summary>
          <span className="systemMeta">Mainnet 5031 · Shannon 50312 · DreamDEX SDK 0.28.1</span>
        </details>
      </footer>
    </div>
  );
}

function ExperimentFrame() {
  const { experimentId = "" } = useParams();
  const base = `/lab/${encodeURIComponent(experimentId)}`;
  const tabs = ["results", "observations", "evidence", "execution"] as const;
  return (
    <div className="experimentFrame">
      <nav className="experimentTabs" aria-label="Experiment sections">
        {tabs.map((tab) => (
          <NavLink key={tab} to={`${base}/${tab}`} className={({ isActive }) => (isActive ? "active" : undefined)}>
            {tab[0]?.toUpperCase()}{tab.slice(1)}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}

function LegacyEvidenceRedirect() {
  const { experimentId = "" } = useParams();
  return <Navigate replace to={`/lab/${encodeURIComponent(experimentId)}/evidence`} />;
}

function LegacyExecutionRedirect() {
  const [params] = useSearchParams();
  const experimentId = params.get("experimentId");
  if (experimentId === null || !/^[0-9a-f-]{36}$/i.test(experimentId)) return <Navigate replace to="/lab?notice=choose-experiment" />;
  const safe = new URLSearchParams();
  for (const key of ["asset", "intervalSec", "intentId"]) {
    const value = params.get(key);
    if (value !== null) safe.set(key, value);
  }
  return <Navigate replace to={`/lab/${encodeURIComponent(experimentId)}/execution${safe.size > 0 ? `?${safe.toString()}` : ""}`} />;
}

function LegacyComparisonRedirect() {
  const { comparisonId = "" } = useParams();
  return <Navigate replace to={`/lab/compare/${encodeURIComponent(comparisonId)}`} />;
}

export const router = createBrowserRouter([{ path: "/", element: <RootLayout />, children: [
  { index: true, element: <HomePage /> },
  { path: "markets", element: <MarketsPage /> },
  { path: "markets/:marketId", element: <MarketDetailPage /> },
  { path: "lab", element: <LabPage /> },
  { path: "lab/compare", element: <ComparePage /> },
  { path: "lab/compare/:comparisonId", element: <ComparePage /> },
  { path: "lab/:experimentId", element: <ExperimentFrame />, children: [
    { index: true, element: <Navigate replace to="results" /> },
    { path: "results", element: <ExperimentWorkspacePage /> },
    { path: "observations", element: <ExperimentWorkspacePage /> },
    { path: "evidence", element: <EvidencePage /> },
    { path: "execution", element: <ExecutionCandidatePage /> }
  ] },
  { path: "evidence", element: <ArchivePage /> },
  { path: "evidence/archive/:artifactId", element: <ArchivePage /> },
  { path: "evidence/:experimentId", element: <LegacyEvidenceRedirect /> },
  { path: "observation", element: <Navigate replace to="/evidence/archive/observe-001" /> },
  { path: "proof", element: <Navigate replace to="/evidence/archive/exg-003" /> },
  { path: "execution-candidate", element: <LegacyExecutionRedirect /> },
  { path: "compare", element: <Navigate replace to="/lab/compare" /> },
  { path: "compare/:comparisonId", element: <LegacyComparisonRedirect /> },
  { path: "how-it-works", element: <HowItWorksPage /> },
  { path: "*", element: <NotFoundPage /> }
]}]);

export function App() { return <RouterProvider router={router} />; }
