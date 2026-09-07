import { useEffect, useRef } from "react";
import {
  createBrowserRouter,
  Link,
  NavLink,
  Outlet,
  RouterProvider,
  useLocation
} from "react-router-dom";
import { DREAMDEX_MARKETS_SDK_VERSION, SOMNIA_MAINNET_CHAIN_ID, SOMNIA_SHANNON_CHAIN_ID } from "@edgelab/domain";
import { capturedSummarySource } from "./data.js";
import HomePage from "./pages/HomePage.js";
import MarketsPage from "./pages/MarketsPage.js";
import MarketDetailPage from "./pages/MarketDetailPage.js";
import LabPage from "./pages/LabPage.js";
import ExperimentWorkspacePage from "./pages/ExperimentWorkspacePage.js";
import ComparePage from "./pages/ComparePage.js";
import EvidencePage from "./pages/EvidencePage.js";
import ObservationPage from "./pages/ObservationPage.js";
import ExecutionCandidatePage from "./pages/ExecutionCandidatePage.js";
import ProofPage from "./pages/ProofPage.js";
import HowItWorksPage from "./pages/HowItWorksPage.js";
import NotFoundPage from "./pages/NotFoundPage.js";

const navItems = [
  { to: "/markets", label: "Markets" },
  { to: "/lab", label: "Lab" },
  { to: "/observation", label: "Observation" },
  { to: "/execution-candidate", label: "Execution" },
  { to: "/compare", label: "Compare" },
  { to: "/how-it-works", label: "Methodology" }
] as const;

function routeTitleFromPath(pathname: string): string {
  if (pathname === "/") {
    return "EdgeLab";
  }
  if (pathname.startsWith("/markets/")) {
    return "Market Detail";
  }
  if (pathname.startsWith("/lab/")) {
    return "Experiment Workspace";
  }
  if (pathname.startsWith("/evidence")) {
    return "Evidence Gate";
  }
  const firstSegment = pathname.split("/").filter(Boolean)[0] ?? "";
  const titles: Record<string, string> = {
    markets: "Markets",
    lab: "Strategy Lab",
    compare: "Compare",
    observation: "Observation Proof",
    "execution-candidate": "Execution Candidate",
    proof: "DreamDEX Proof",
    "how-it-works": "How It Works"
  };
  return titles[firstSegment] ?? "Route Not Found";
}

function RootLayout() {
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const mountedRef = useRef(false);
  const routeTitle = routeTitleFromPath(location.pathname);

  useEffect(() => {
    document.title = routeTitle === "EdgeLab" ? "EdgeLab" : `${routeTitle} - EdgeLab`;
    if (mountedRef.current) {
      mainRef.current?.focus();
    } else {
      mountedRef.current = true;
    }
  }, [location.pathname, routeTitle]);

  return (
    <div className="appShell">
      <a className="skipLink" href="#main-content">
        Skip to content
      </a>
      <header className="appHeader">
        <Link className="brandLockup" to="/" aria-label="EdgeLab home">
          <span className="brandMark" aria-hidden="true">EL</span>
          <span className="brandCopy">
            <strong>EdgeLab</strong>
            <small>Strategy qualification</small>
          </span>
        </Link>
        <nav className="topNav" aria-label="EdgeLab product navigation">
          {navItems.map((item) => (
            <NavLink to={item.to} key={item.to} className={({ isActive }) => (isActive ? "active" : undefined)}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <details className="mobileNav">
          <summary>Menu</summary>
          <nav aria-label="EdgeLab mobile navigation">
            {navItems.map((item) => (
              <NavLink to={item.to} key={item.to} className={({ isActive }) => (isActive ? "active" : undefined)}>
                {item.label}
              </NavLink>
            ))}
          </nav>
        </details>
        <div className="headerAction">
          <span className="environmentBadge">Shannon 50312 · human approval</span>
          <Link className="primaryAction" to="/lab">
            Open Lab
          </Link>
        </div>
      </header>
      <main id="main-content" ref={mainRef} tabIndex={-1} className="routeMain">
        <Outlet />
      </main>
      <footer className="systemStatus" aria-label="System status">
        <div className="statusAssurance">
          <strong>Evidence before exposure</strong>
          <span>Mainnet {SOMNIA_MAINNET_CHAIN_ID} research · Shannon {SOMNIA_SHANNON_CHAIN_ID} human-authorized execution</span>
        </div>
        <nav aria-label="Evidence and system links">
          <Link to="/observation">Observation proof</Link>
          <Link to="/execution-candidate">Execution gate</Link>
          <Link to="/proof">Shannon proof</Link>
        </nav>
        <span className="systemMeta">DreamDEX SDK {DREAMDEX_MARKETS_SDK_VERSION} · {capturedSummarySource}</span>
      </footer>
    </div>
  );
}

export const router = createBrowserRouter([
  {
    path: "/",
    element: <RootLayout />,
    handle: { title: "EdgeLab" },
    children: [
      { index: true, element: <HomePage />, handle: { title: "EdgeLab" } },
      { path: "markets", element: <MarketsPage />, handle: { title: "Markets" } },
      { path: "markets/:marketId", element: <MarketDetailPage />, handle: { title: "Market Detail" } },
      { path: "lab", element: <LabPage />, handle: { title: "Strategy Lab" } },
      { path: "lab/:experimentId", element: <ExperimentWorkspacePage />, handle: { title: "Experiment Workspace" } },
      { path: "compare", element: <ComparePage />, handle: { title: "Compare" } },
      { path: "compare/:comparisonId", element: <ComparePage />, handle: { title: "Compare" } },
      { path: "observation", element: <ObservationPage />, handle: { title: "Observation Proof" } },
      { path: "execution-candidate", element: <ExecutionCandidatePage />, handle: { title: "Execution Candidate" } },
      { path: "evidence", element: <EvidencePage />, handle: { title: "Evidence Gate" } },
      { path: "evidence/:experimentId", element: <EvidencePage />, handle: { title: "Evidence Gate" } },
      { path: "proof", element: <ProofPage />, handle: { title: "DreamDEX Proof" } },
      { path: "how-it-works", element: <HowItWorksPage />, handle: { title: "How It Works" } },
      { path: "*", element: <NotFoundPage />, handle: { title: "Route Not Found" } }
    ]
  }
]);

export function App() {
  return <RouterProvider router={router} />;
}
