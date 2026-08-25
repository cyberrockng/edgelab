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

interface ProofRow {
  readonly label: string;
  readonly value: string;
  readonly href: string | null;
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

const minimumSample = 30;
const explorerBase = "https://shannon-explorer.somnia.network";
const proofWalletAddress = ["0x6b3a87a4bbf7", "d7d324df227d", "640fc42ebf987971"].join("");
const proofRows: readonly ProofRow[] = [
  {
    label: "Wallet",
    value: "0x6b3a...7971",
    href: `${explorerBase}/address/${proofWalletAddress}`
  },
  {
    label: "Approval",
    value: "0xeb2c...5312",
    href: `${explorerBase}/tx/${[
      "0xeb2ce83146e757b",
      "8bb5b204e01b711d2",
      "e9dd479a35fc336d",
      "ef101c722e905312"
    ].join("")}`
  },
  {
    label: "Order",
    value: "0x666d...4196",
    href: `${explorerBase}/tx/${[
      "0x666d5d5a5dc95914",
      "ef6ae14684d96405",
      "5f936bf52c199658",
      "50ed1c773b954196"
    ].join("")}`
  },
  {
    label: "Terminal",
    value: "0x9405...02fd",
    href: `${explorerBase}/tx/${[
      "0x94057033d8cd59cd",
      "1c58a6efa21d25cc",
      "7dc00c4eb0a0a0ea",
      "a2cfefb860ab02fd"
    ].join("")}`
  },
  {
    label: "Order ID",
    value: "110680464442257591736",
    href: null
  }
];

const policyRows = [
  {
    name: "Reference A",
    action: "WATCH_ONLY",
    observations: 0,
    calibration: "NOT AVAILABLE",
    tradeability: "shared probe verified",
    risk: "bounded",
    pnl: "NOT AVAILABLE",
    promotion: "blocked"
  },
  {
    name: "Reference B",
    action: "ABSTAIN",
    observations: 0,
    calibration: "NOT AVAILABLE",
    tradeability: "shared probe verified",
    risk: "bounded",
    pnl: "NOT AVAILABLE",
    promotion: "blocked"
  }
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

function normalizeStatus(status: string): string {
  return status.replaceAll(" ", "-").toLowerCase();
}

function App() {
  const { summary, source, apiState } = useEvidenceSummary();
  const sampleSize = summary.counts.decisions;
  const samplePercent = Math.min(100, Math.round((sampleSize / minimumSample) * 100));
  const chain = summary.chain;
  const verdict = sampleSize >= minimumSample ? "HOLD" : "INSUFFICIENT_EVIDENCE";
  const displayVerdict = verdict.replace("_", " ");
  const remainingSamples = Math.max(0, minimumSample - sampleSize);
  const verdictReasons = useMemo(
    () => [
      "Sample requirement not met",
      "Forecast quality is separate from tradeability",
      "Realized PnL is unavailable without fills and settlement"
    ],
    []
  );
  const gateRows = [
    {
      label: "Forecast sample",
      status: sampleSize >= minimumSample ? "PASS" : "BLOCKED",
      value: `${String(sampleSize)}/${String(minimumSample)} observations`,
      detail:
        sampleSize >= minimumSample
          ? "Minimum sample satisfied"
          : `${String(remainingSamples)} additional pre-outcome observations required`
    },
    {
      label: "Forecast calibration",
      status: "NOT AVAILABLE",
      value: "no settled decision sample",
      detail: "Calibration is not inferred from the integration probe"
    },
    {
      label: "DreamDEX tradeability",
      status: chain.tradeabilityStatus === "EVALUATED" ? "VERIFIED" : "NOT EVALUATED",
      value: `${String(chain.submittedOrderCount)} submitted / ${String(chain.terminalOrderCount)} terminal / ${String(chain.openOrderCount)} open`,
      detail: "A real capped order lifecycle proves integration, not profitability"
    },
    {
      label: "Risk envelope",
      status: chain.openOrderCount === 0 && chain.terminalOrderCount > 0 ? "PASS" : "PENDING",
      value: "0.01 tUSDC cap",
      detail: "Exact approval, no self-trade, no unexpected open order"
    },
    {
      label: "Settlement evidence",
      status: summary.counts.settlements > 0 ? "AVAILABLE" : "NOT AVAILABLE",
      value: `${String(summary.counts.settlements)} settlements`,
      detail: "Settlement evidence remains separate from order submission"
    },
    {
      label: "Realized PnL",
      status: chain.fillCount > 0 ? "PENDING SETTLEMENT" : "NOT AVAILABLE",
      value: `${String(chain.fillCount)} fills verified`,
      detail: "PnL is blocked until an actual fill and terminal settlement exist"
    }
  ] as const;
  const lifecycleRows = [
    {
      state: "VERIFIED",
      title: "Exact approval",
      detail: "0.01 tUSDC approved to the selected DreamDEX pool"
    },
    {
      state: "SUBMITTED",
      title: "POST_ONLY BUY_YES order",
      detail: "Price 0.01, quantity 1; order ID remains inspectable below"
    },
    {
      state: "NO FILL",
      title: "Rested without execution",
      detail: "No fill was observed; no PnL is inferred"
    },
    {
      state: "EXPIRED",
      title: "Owner-approved cancel landed after expiry",
      detail: "DreamDEX emitted OrderExpired, not OrderCancelled"
    },
    {
      state: "RECONCILED",
      title: "Terminal state verified",
      detail: "No open order remains and escrow returned"
    }
  ] as const;

  return (
    <main className="appShell">
      <header className="appHeader">
        <a className="brandMark" href="#overview" aria-label="EdgeLab overview">
          EL
        </a>
        <nav className="topNav" aria-label="EdgeLab workflow">
          <a href="#overview">Overview</a>
          <a href="#comparison">Strategies</a>
          <a href="#evidence">Evidence</a>
          <a href="#chain">DreamDEX proof</a>
          <a href="#proof">Details</a>
        </nav>
        <div className="runtimePills" aria-label="Runtime status">
          <span>{apiState}</span>
          <span>Chain {SOMNIA_SHANNON_CHAIN_ID}</span>
          <span>{source}</span>
        </div>
      </header>

      <section id="overview" className="overviewGrid" aria-label="Decision overview">
        <div className="openingCopy">
          <p className="eyebrow">DreamDEX strategy validation instrument</p>
          <h1>Test a strategy before exposing it to testnet capital.</h1>
          <p>
            EdgeLab separates forecast evidence, real DreamDEX tradeability, risk boundaries, and
            realized PnL. If the evidence has not earned promotion, the correct output is
            insufficiency.
          </p>
        </div>

        <section id="decision" className="verdictPanel" aria-label="Current decision">
          <span className="label">Current verdict</span>
          <strong>{displayVerdict}</strong>
          <p>Promotion blocked. EdgeLab protected this strategy from overconfidence.</p>
          <dl className="verdictFacts">
            <div>
              <dt>Observed sample</dt>
              <dd>{`${String(sampleSize)}/${String(minimumSample)}`}</dd>
            </div>
            <div>
              <dt>Additional required</dt>
              <dd>{remainingSamples}</dd>
            </div>
            <div>
              <dt>Open orders</dt>
              <dd>{chain.openOrderCount}</dd>
            </div>
          </dl>
        </section>
      </section>

      <section id="evidence" className="gateSection" aria-label="Evidence gate">
        <div className="sectionIntro">
          <span className="label">Evidence Gate</span>
          <h2>Evidence must pass through each gate before promotion.</h2>
          <p>
            The verdict is not a scorecard decoration. It is the deterministic result of missing
            and verified evidence dimensions.
          </p>
        </div>

        <div className="evidenceGate">
          <div className="gateCandidate">
            <span>Candidate strategy cohort</span>
            <strong>Reference policies on DreamDEX Event Contracts</strong>
            <small>Forward testing only; no historical CLOB replay</small>
          </div>
          <div className="gateBody" role="list" aria-label="Evidence gate dimensions">
            {gateRows.map((row) => (
              <article className={`gateRow status-${normalizeStatus(row.status)}`} key={row.label} role="listitem">
                <div>
                  <span className="gateLabel">{row.label}</span>
                  <strong>{row.value}</strong>
                  <p>{row.detail}</p>
                </div>
                <span className="statusPill">{row.status}</span>
              </article>
            ))}
          </div>
          <div className="gateOutput">
            <span>Gate output</span>
            <strong>{displayVerdict}</strong>
            <p>{verdictReasons.join(" / ")}</p>
          </div>
        </div>
      </section>

      <section className="evidenceSplit" aria-label="Evidence separation">
        <article>
          <span className="label">Forecast quality</span>
          <strong>{`${String(sampleSize)}/${String(minimumSample)}`}</strong>
          <p>Pre-outcome decisions. Calibration is unavailable until enough settled observations exist.</p>
          <div className="meter" aria-label={`Forecast sample ${String(samplePercent)} percent complete`}>
            <span style={{ inlineSize: `${String(samplePercent)}%` }} />
          </div>
        </article>
        <article>
          <span className="label">Tradeability</span>
          <strong>{chain.tradeabilityStatus}</strong>
          <p>{`${String(chain.submittedOrderCount)} submitted / ${String(chain.terminalOrderCount)} terminal / ${String(chain.openOrderCount)} open`}</p>
          <div className="meter verified" aria-label="Tradeability terminal proof">
            <span style={{ inlineSize: chain.terminalOrderCount > 0 ? "100%" : "0%" }} />
          </div>
        </article>
        <article>
          <span className="label">Realized PnL</span>
          <strong>NOT AVAILABLE</strong>
          <p>{`${String(chain.fillCount)} fills verified. No fill means no realized PnL claim.`}</p>
          <div className="meter muted" aria-label="Realized PnL unavailable">
            <span style={{ inlineSize: chain.fillCount > 0 ? "100%" : "0%" }} />
          </div>
        </article>
      </section>

      <section id="comparison" className="comparison" aria-label="Strategy comparison">
        <div className="sectionIntro compact">
          <span className="label">Strategy comparison</span>
          <h2>Which policy has stronger evidence?</h2>
          <p>
            Neither reference policy can be promoted yet. The interface shows missing evidence
            instead of filling gaps with synthetic performance.
          </p>
        </div>
        <div className="policyMatrix" role="table" aria-label="Policy evidence comparison">
          <div role="row">
            <span role="columnheader">Policy</span>
            <span role="columnheader">Action</span>
            <span role="columnheader">Observations</span>
            <span role="columnheader">Calibration</span>
            <span role="columnheader">Tradeability</span>
            <span role="columnheader">Risk</span>
            <span role="columnheader">PnL</span>
            <span role="columnheader">Promotion</span>
          </div>
          {policyRows.map((row) => (
            <div role="row" key={row.name}>
              <span role="cell" data-label="Policy">{row.name}</span>
              <span role="cell" data-label="Action">{row.action}</span>
              <span role="cell" data-label="Observations">{row.observations}/{minimumSample}</span>
              <span role="cell" data-label="Calibration">{row.calibration}</span>
              <span role="cell" data-label="Tradeability">{row.tradeability}</span>
              <span role="cell" data-label="Risk">{row.risk}</span>
              <span role="cell" data-label="PnL">{row.pnl}</span>
              <span role="cell" data-label="Promotion" className="blockedCell">{row.promotion}</span>
            </div>
          ))}
        </div>
      </section>

      <section id="chain" className="chainProof" aria-label="DreamDEX lifecycle proof">
        <div className="sectionIntro compact">
          <span className="label">Real DreamDEX proof</span>
          <h2>{chain.latestTerminalState ?? "NO TERMINAL STATE"}</h2>
          <p>
            One capped human-approved testnet lifecycle proves EdgeLab can prepare, observe, and
            reconcile a DreamDEX Event Contract order without fabricating a fill.
          </p>
        </div>
        <ol className="lifecycleRail">
          {lifecycleRows.map((row) => (
            <li key={row.title}>
              <span>{row.state}</span>
              <div>
                <strong>{row.title}</strong>
                <p>{row.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section id="proof" className="proofSection" aria-label="Technical proof details">
        <div className="sectionIntro compact">
          <span className="label">Technical proof</span>
          <h2>Public chain evidence remains inspectable.</h2>
          <p>
            Hashes are secondary details, but they stay reachable for audit. SDK and source metadata
            do not override the evidence gate.
          </p>
        </div>
        <div className="proofGrid">
          {proofRows.map((row) =>
            row.href === null ? (
              <div key={row.label}>
                <span>{row.label}</span>
                <strong>{row.value}</strong>
              </div>
            ) : (
              <a href={row.href} target="_blank" rel="noreferrer" key={row.label}>
                <span>{row.label}</span>
                <strong>{row.value}</strong>
              </a>
            )
          )}
          <div>
            <span>SDK</span>
            <strong>{DREAMDEX_MARKETS_SDK_VERSION}</strong>
          </div>
        </div>
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
