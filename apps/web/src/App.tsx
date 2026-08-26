import { lazy, Suspense, useEffect, useRef } from "react";
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

const HomePage = lazy(() => import("./pages/HomePage.js"));
const MarketsPage = lazy(() => import("./pages/MarketsPage.js"));
const MarketDetailPage = lazy(() => import("./pages/MarketDetailPage.js"));
const LabPage = lazy(() => import("./pages/LabPage.js"));
const ExperimentWorkspacePage = lazy(() => import("./pages/ExperimentWorkspacePage.js"));
const ComparePage = lazy(() => import("./pages/ComparePage.js"));
const EvidencePage = lazy(() => import("./pages/EvidencePage.js"));
const ProofPage = lazy(() => import("./pages/ProofPage.js"));
const HowItWorksPage = lazy(() => import("./pages/HowItWorksPage.js"));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage.js"));

const navItems = [
  { to: "/markets", label: "Markets" },
  { to: "/lab", label: "Strategy Lab" },
  { to: "/compare", label: "Compare" },
  { to: "/evidence/proven-experiment", label: "Evidence" },
  { to: "/proof", label: "Proof" },
  { to: "/how-it-works", label: "How It Works" }
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
    proof: "DreamDEX Proof",
    "how-it-works": "How It Works"
  };
  return titles[firstSegment] ?? "Route Not Found";
}

function RouteFallback() {
  return (
    <section className="routePanel" aria-label="Loading route">
      <p className="eyebrow">Loading</p>
      <h1>Preparing EdgeLab route.</h1>
      <p>Route code is loading. No evidence is fabricated while the product view initializes.</p>
    </section>
  );
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
        <Link className="brandMark" to="/" aria-label="EdgeLab home">
          EL
        </Link>
        <nav className="topNav" aria-label="EdgeLab product navigation">
          {navItems.map((item) => (
            <NavLink to={item.to} key={item.to} className={({ isActive }) => (isActive ? "active" : undefined)}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="runtimePills" aria-label="Runtime status">
          <span>Mainnet {SOMNIA_MAINNET_CHAIN_ID} read-only</span>
          <span>Shannon {SOMNIA_SHANNON_CHAIN_ID}</span>
          <span>SDK {DREAMDEX_MARKETS_SDK_VERSION}</span>
          <span>{capturedSummarySource}</span>
        </div>
        <Link className="primaryAction" to="/lab">
          Run Strategy Lab
        </Link>
      </header>
      <main id="main-content" ref={mainRef} tabIndex={-1} className="routeMain">
        <Suspense fallback={<RouteFallback />}>
          <Outlet />
        </Suspense>
      </main>
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
