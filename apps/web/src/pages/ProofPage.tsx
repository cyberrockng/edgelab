import { useQuery } from "@tanstack/react-query";
import { DREAMDEX_MARKETS_SDK_VERSION } from "@edgelab/domain";
import { apiErrorMessage, capturedSummary, fetchExecutionProof, proofRows } from "../data.js";

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

export default function ProofPage() {
  const proofQuery = useQuery({
    queryKey: ["proof", "exg-003"],
    queryFn: fetchExecutionProof
  });
  const proof = proofQuery.data?.data.proof ?? null;
  const summary = capturedSummary;
  const renderedLifecycle = proof?.lifecycle ?? lifecycleRows;
  const renderedTechnical = proof?.technical ?? proofRows;
  const terminalState = proof?.order.terminalEvent.toUpperCase().replace("ORDER", "") ?? summary.chain.latestTerminalState ?? "Terminal proof unavailable";
  return (
    <div className="pageStack">
      <section className="routeHero">
        <p className="eyebrow">Verified Shannon execution proof</p>
        <h1>{terminalState}</h1>
        <p>
          A capped human-approved testnet lifecycle proves EdgeLab can prepare, observe, and
          reconcile DreamDEX Event Contract execution without requiring a fill.
        </p>
        {proofQuery.isLoading ? <div className="stateBox">Loading verified EXG-003 proof...</div> : null}
        {proofQuery.isError ? (
          <div className="stateBox errorState" role="alert">
            {apiErrorMessage(proofQuery.error)}
          </div>
        ) : null}
      </section>
      <section className="chainProof" aria-label="DreamDEX lifecycle proof">
        <div className="sectionIntro compact">
          <span className="label">Lifecycle</span>
          <h2>Approval to terminal reconciliation.</h2>
          <p>Mainnet research data is not mixed with Shannon execution evidence.</p>
        </div>
        <ol className="lifecycleRail">
          {renderedLifecycle.map((row) => (
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
      <section className="proofSection" aria-label="Technical proof details">
        <div className="sectionIntro compact">
          <span className="label">Public chain references</span>
          <h2>Hashes stay secondary but inspectable.</h2>
          <p>Explorer links are safe public proof references. They do not imply a fill or PnL.</p>
        </div>
        {proof === null ? null : (
          <div className="stateBox">
            Chain {String(proof.network.chainId)}; order {proof.order.orderId}; fill status {proof.order.fillStatus};
            PnL {proof.reconciliation.pnlStatus}.
          </div>
        )}
        <div className="proofGrid">
          {renderedTechnical.map((row) =>
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
    </div>
  );
}
