import { useQuery } from "@tanstack/react-query";
import { DREAMDEX_MARKETS_SDK_VERSION } from "@edgelab/domain";
import { Link, useSearchParams } from "react-router-dom";
import { ExecutionLifecycleSummary } from "../components/ExecutionLifecycleSummary.js";
import { apiErrorMessage, fetchExecutionProof, fetchExperimentExecution } from "../data.js";

export default function ProofPage() {
  const [searchParams] = useSearchParams();
  const experimentId = searchParams.get("experimentId");
  const hasCanonicalExperiment = experimentId !== null && /^[0-9a-f-]{36}$/i.test(experimentId);
  const proofQuery = useQuery({
    queryKey: ["proof", "exg-003"],
    queryFn: fetchExecutionProof,
    enabled: !hasCanonicalExperiment
  });
  const canonicalQuery = useQuery({
    queryKey: ["experiment", experimentId, "execution"],
    queryFn: () => fetchExperimentExecution(experimentId ?? ""),
    enabled: hasCanonicalExperiment
  });
  const proof = proofQuery.data?.data.proof ?? null;
  const canonical = canonicalQuery.data?.data.executionLifecycle ?? null;
  const terminalState = proof?.order.terminalEvent.toUpperCase().replace("ORDER", "") ?? "Proof unavailable";
  return (
    <div className="pageStack">
      <section className="routeHero">
        <p className="eyebrow">{hasCanonicalExperiment ? "Strategy-linked execution evidence" : "Captured Shannon no-fill proof"}</p>
        <h1>{canonical?.publicClaim.replaceAll("_", " ") ?? terminalState}</h1>
        <p>
          {hasCanonicalExperiment
            ? "This view reads the experiment's canonical qualification, transaction, order/fill, settlement, and redemption record. Missing evidence stays unknown."
            : "EXG-003 is a protocol-boundary proof: EdgeLab prepared a capped human-approved DreamDEX order, observed its terminal state, and reconciled collateral without turning a no-fill lifecycle into a fake PnL claim."}
        </p>
        {proofQuery.isLoading || canonicalQuery.isLoading ? <div className="stateBox">Loading execution evidence...</div> : null}
        {proofQuery.isError ? (
          <div className="stateBox errorState" role="alert">
            {apiErrorMessage(proofQuery.error)}
          </div>
        ) : null}
        {canonicalQuery.isError ? (
          <div className="stateBox errorState" role="alert">
            {apiErrorMessage(canonicalQuery.error)}
          </div>
        ) : null}
      </section>
      {canonical !== null ? <ExecutionLifecycleSummary lifecycle={canonical} /> : null}
      {hasCanonicalExperiment && canonical === null && !canonicalQuery.isLoading ? (
        <div className="stateBox">No strategy-linked execution intent has been recorded for this experiment.</div>
      ) : null}
      {hasCanonicalExperiment ? null : (
        <>
      <section className="chainProof" aria-label="DreamDEX lifecycle proof">
        <div className="sectionIntro compact">
          <span className="label">Lifecycle</span>
          <h2>Approval to terminal reconciliation, with no claim inflation.</h2>
          <p>
            Mainnet research data is not mixed with Shannon execution evidence. This proof shows
            EdgeLab can handle execution lifecycle reality; it does not pretend the strategy has a
            filled trade.
          </p>
          <div className="actionRow">
            <Link className="secondaryAction" to="/lab/proven-experiment/evidence">
              See Evidence Gate Relationship
            </Link>
            <a className="secondaryAction" href="/api/v2/proven-experiments/proven-experiment/report" target="_blank" rel="noreferrer">
              Export Experiment Report
            </a>
          </div>
        </div>
        {proof === null && !proofQuery.isLoading ? (
          <div className="stateBox statusWarning">Proof source is unavailable; no captured lifecycle is substituted.</div>
        ) : null}
        {proof === null ? null : (
          <ol className="lifecycleRail">
            {proof.lifecycle.map((row) => (
              <li key={row.title}>
                <span>{row.state}</span>
                <div>
                  <strong>{row.title}</strong>
                  <p>{row.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
      <section className="proofSection" aria-label="Technical proof details">
        <div className="sectionIntro compact">
          <span className="label">Public chain references</span>
          <h2>Hashes stay inspectable and claims stay bounded.</h2>
          <p>Explorer links are safe public proof references. They do not imply a fill or PnL.</p>
        </div>
        {proof === null ? null : (
          <div className="stateBox">
            Chain {String(proof.network.chainId)}; order {proof.order.orderId}; fill status {proof.order.fillStatus};
            PnL {proof.reconciliation.pnlStatus}.
          </div>
        )}
        <section className="resultPanel" aria-label="Experiment proof relationship">
          <div className="sectionHeader">
            <div>
              <p className="eyebrow">Relationship to Strategy Evidence</p>
              <h2>The missing filled proof is visible by design.</h2>
            </div>
            <span className="statusPill">SHANNON_EXECUTION</span>
          </div>
          <div className="verdictLadder compactLadder">
            <div className="ladderStep complete">
              <span>Proves</span>
              <strong>Bounded lifecycle control</strong>
              <p>Approval, order submission, expiry, and reconciliation are publicly inspectable.</p>
            </div>
            <div className="ladderStep current">
              <span>Separates</span>
              <strong>Historical strategy evidence</strong>
              <p>The proven experiment remains a qualification artifact, not a live trade result.</p>
            </div>
            <div className="ladderStep blocked">
              <span>Blocks</span>
              <strong>Profit or fill claims</strong>
              <p>A future candidate-specific execution proof requires separate owner-approved authority.</p>
            </div>
          </div>
        </section>
        {proof === null ? (
          <div className="stateBox">Public chain references load only from the proof API.</div>
        ) : (
          <div className="proofGrid">
            {proof.technical.map((row) =>
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
        )}
      </section>
        </>
      )}
    </div>
  );
}
