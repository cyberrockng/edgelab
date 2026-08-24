import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { DREAMDEX_MARKETS_SDK_VERSION, SOMNIA_SHANNON_CHAIN_ID } from "@edgelab/domain";
import "./styles.css";

interface EvidenceSummary {
  readonly ok: true;
  readonly counts: {
    readonly experiments: number;
    readonly episodes: number;
    readonly snapshots: number;
    readonly decisions: number;
    readonly settlements: number;
    readonly metricRuns: number;
    readonly assessments: number;
  };
  readonly chain: {
    readonly submittedOrderCount: number;
    readonly fillCount: number;
    readonly terminalOrderCount: number;
    readonly openOrderCount: number;
    readonly latestTerminalState: string | null;
    readonly tradeabilityStatus: "NOT_EVALUATED" | "EVALUATED";
  };
}

const capturedSummary: EvidenceSummary = {
  ok: true,
  counts: {
    experiments: 0,
    episodes: 0,
    snapshots: 0,
    decisions: 0,
    settlements: 0,
    metricRuns: 0,
    assessments: 0
  },
  chain: {
    submittedOrderCount: 1,
    fillCount: 0,
    terminalOrderCount: 1,
    openOrderCount: 0,
    latestTerminalState: "EXPIRED",
    tradeabilityStatus: "EVALUATED"
  }
};

const proofRows = [
  ["Wallet", "0x6b3a...7971"],
  ["Approval", "0xeb2c...5312"],
  ["Order", "0x666d...4196"],
  ["Terminal", "0x9405...02fd"],
  ["Order ID", "110680464442257591736"]
] as const;

function useEvidenceSummary(): { summary: EvidenceSummary; source: "API" | "CAPTURED"; apiState: string } {
  const [summary, setSummary] = useState<EvidenceSummary>(capturedSummary);
  const [source, setSource] = useState<"API" | "CAPTURED">("CAPTURED");
  const [apiState, setApiState] = useState("CAPTURED");

  useEffect(() => {
    let active = true;
    fetch("/api/v1/evidence/summary", { headers: { accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${String(response.status)}`);
        }
        return (await response.json()) as EvidenceSummary;
      })
      .then((data) => {
        if (!active) {
          return;
        }
        setSummary(data);
        setSource("API");
        setApiState("LIVE");
      })
      .catch(() => {
        if (!active) {
          return;
        }
        setApiState("CAPTURED");
      });
    return () => {
      active = false;
    };
  }, []);

  return { summary, source, apiState };
}

function App() {
  const { summary, source, apiState } = useEvidenceSummary();
  const sampleSize = summary.counts.decisions;
  const minimumSample = 30;
  const samplePercent = Math.min(100, Math.round((sampleSize / minimumSample) * 100));
  const chain = summary.chain;
  const verdict = sampleSize >= minimumSample ? "HOLD" : "INSUFFICIENT_EVIDENCE";
  const verdictReasons = useMemo(
    () => ["MIN_SAMPLE_NOT_MET", "PNL_SEPARATE_FROM_FORECAST", "TRADEABILITY_SEPARATE"],
    []
  );

  return (
    <main className="appShell">
      <aside className="rail" aria-label="EdgeLab sections">
        <div className="brandMark" aria-hidden="true">
          EL
        </div>
        <nav>
          <a href="#decision">Decision</a>
          <a href="#evidence">Evidence</a>
          <a href="#chain">Chain</a>
          <a href="#proof">Proof</a>
        </nav>
        <div className="railMeta">
          <span>Chain</span>
          <strong>{SOMNIA_SHANNON_CHAIN_ID}</strong>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">EdgeLab</p>
            <h1>DreamDEX evidence lab</h1>
          </div>
          <div className="runtimePills" aria-label="Runtime status">
            <span>{apiState}</span>
            <span>SDK {DREAMDEX_MARKETS_SDK_VERSION}</span>
            <span>{source}</span>
          </div>
        </header>

        <section id="decision" className="decisionBand" aria-label="Current decision">
          <div>
            <span className="label">Current verdict</span>
            <strong>{verdict}</strong>
            <p>{verdictReasons.join(" / ")}</p>
          </div>
          <div className="sampleGauge" aria-label={`${String(sampleSize)} of ${String(minimumSample)} samples`}>
            <svg viewBox="0 0 120 120" role="img" aria-label="Sample sufficiency gauge">
              <circle cx="60" cy="60" r="48" />
              <circle
                className="gaugeValue"
                cx="60"
                cy="60"
                r="48"
                pathLength="100"
                strokeDasharray={`${String(samplePercent)} 100`}
              />
            </svg>
            <div>
              <strong>{sampleSize}/{minimumSample}</strong>
              <span>samples</span>
            </div>
          </div>
        </section>

        <section id="evidence" className="gridThree" aria-label="Evidence separation">
          <article className="panel">
            <span className="label">Forecast</span>
            <strong>{summary.counts.decisions}</strong>
            <p>pre-outcome decisions</p>
            <div className="meter">
              <span style={{ inlineSize: `${String(samplePercent)}%` }} />
            </div>
          </article>
          <article className="panel accent">
            <span className="label">Tradeability</span>
            <strong>{chain.tradeabilityStatus}</strong>
            <p>
              {chain.submittedOrderCount} submitted / {chain.terminalOrderCount} terminal / {chain.openOrderCount} open
            </p>
            <div className="meter">
              <span style={{ inlineSize: chain.terminalOrderCount > 0 ? "100%" : "0%" }} />
            </div>
          </article>
          <article className="panel">
            <span className="label">Realized PnL</span>
            <strong>NOT_AVAILABLE</strong>
            <p>{chain.fillCount} fills verified</p>
            <div className="meter muted">
              <span style={{ inlineSize: chain.fillCount > 0 ? "100%" : "0%" }} />
            </div>
          </article>
        </section>

        <section className="comparison" aria-label="Policy comparison">
          <div className="sectionHeader">
            <span className="label">Reference policies</span>
            <strong>Calibration before promotion</strong>
          </div>
          <div className="policyTable" role="table" aria-label="Policy evidence comparison">
            <div role="row">
              <span role="columnheader">Policy</span>
              <span role="columnheader">Action</span>
              <span role="columnheader">Evidence</span>
              <span role="columnheader">Promotion</span>
            </div>
            <div role="row">
              <span role="cell">Reference A</span>
              <span role="cell">WATCH_ONLY</span>
              <span role="cell">insufficient sample</span>
              <span role="cell">blocked</span>
            </div>
            <div role="row">
              <span role="cell">Reference B</span>
              <span role="cell">ABSTAIN</span>
              <span role="cell">risk envelope respected</span>
              <span role="cell">blocked</span>
            </div>
          </div>
        </section>

        <section id="chain" className="chainPanel" aria-label="DreamDEX lifecycle proof">
          <div className="sectionHeader">
            <span className="label">DreamDEX lifecycle</span>
            <strong>{chain.latestTerminalState ?? "NO_TERMINAL_STATE"}</strong>
          </div>
          <ol className="timeline">
            <li>
              <span />
              <div>
                <strong>Exact approval</strong>
                <p>0.01 tUSDC to selected pool</p>
              </div>
            </li>
            <li>
              <span />
              <div>
                <strong>POST_ONLY order</strong>
                <p>BUY_YES at 0.01, quantity 1</p>
              </div>
            </li>
            <li>
              <span />
              <div>
                <strong>Terminal reconciliation</strong>
                <p>no open order, escrow returned</p>
              </div>
            </li>
          </ol>
        </section>

        <section id="proof" className="proofGrid" aria-label="Public proof references">
          {proofRows.map(([label, value]) => (
            <div key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </section>
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Missing root element");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
