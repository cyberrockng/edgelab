import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { apiErrorMessage, compactId, fetchObservationProof } from "../data.js";

export default function ObservationPage() {
  const proofQuery = useQuery({
    queryKey: ["observation-proof", "observe-001"],
    queryFn: fetchObservationProof
  });
  const proof = proofQuery.data?.data.observationProof ?? null;

  return (
    <div className="pageStack">
      <section className="routeHero">
        <p className="eyebrow">Forward Observation Proof</p>
        <h1>EdgeLab already proves the next phase can run before outcomes exist.</h1>
        <p>
          OBSERVE-001 is the bridge between historical qualification and execution exposure:
          live Shannon markets are discovered, snapshots are persisted, and shadow decisions are
          recorded before settlement without a wallet or transaction.
        </p>
        {proofQuery.isLoading ? <div className="stateBox">Loading OBSERVE-001 proof...</div> : null}
        {proofQuery.isError ? (
          <div className="stateBox errorState" role="alert">
            {apiErrorMessage(proofQuery.error)}
          </div>
        ) : null}
      </section>

      {proof === null ? null : (
        <>
          <section className="routePanel thesisPanel" aria-label="Observation verdict">
            <div className="sectionHeader">
              <div>
                <span className="label">OBSERVE-001</span>
                <h2>{proof.judgeSummary.oneLine}</h2>
              </div>
              <span className="statusPill emphasisPill">{proof.status}</span>
            </div>
            <div className="scoreStrip observationScoreStrip" aria-label="Observation scorecard">
              <div>
                <span>Markets</span>
                <strong>{proof.observedMarketCount}</strong>
              </div>
              <div>
                <span>Decisions</span>
                <strong>{proof.totalShadowDecisions}</strong>
              </div>
              <div>
                <span>Wallet</span>
                <strong>Not required</strong>
              </div>
              <div>
                <span>Transactions</span>
                <strong>None</strong>
              </div>
            </div>
            <div className="verdictLadder">
              <div className="ladderStep complete">
                <span>01</span>
                <strong>Historical candidate can advance</strong>
                <p>The proven experiment earns forward observation, not execution.</p>
              </div>
              <div className="ladderStep complete">
                <span>02</span>
                <strong>Forward pipeline verified</strong>
                <p>OBSERVE-001 captured pre-outcome Shannon snapshots and decisions.</p>
              </div>
              <div className="ladderStep current">
                <span>03</span>
                <strong>Larger linked sample required</strong>
                <p>{proof.judgeSummary.nextMilestone}</p>
              </div>
            </div>
            <div className="actionRow">
              <Link className="primaryAction" to="/lab?mode=live-shadow&asset=BTC&interval=900&name=BTC%20forward%20observation">
                Start New Observation
              </Link>
              <Link className="secondaryAction" to="/evidence/proven-experiment">
                Inspect Evidence Gate
              </Link>
              <a className="secondaryAction" href="/api/v2/observation-proof" target="_blank" rel="noreferrer">
                Export Observation Proof
              </a>
            </div>
          </section>

          <section className="routePanel" aria-label="Observed markets">
            <div className="sectionHeader">
              <div>
                <p className="eyebrow">Captured Shannon Markets</p>
                <h2>Every row is read-only observation evidence.</h2>
              </div>
              <span className="statusPill">Chain {proof.chainId}</span>
            </div>
            <div className="policyMatrix observationMatrix" role="table" aria-label="Observation market table">
              <div role="row">
                <span role="columnheader">Market</span>
                <span role="columnheader">Asset</span>
                <span role="columnheader">Interval</span>
                <span role="columnheader">Expires</span>
                <span role="columnheader">Snapshot</span>
                <span role="columnheader">Decisions</span>
              </div>
              {proof.observedMarkets.map((market) => (
                <div role="row" key={market.snapshotId}>
                  <span role="cell" data-label="Market">{compactId(market.stableMarketId)}</span>
                  <span role="cell" data-label="Asset">{market.asset}</span>
                  <span role="cell" data-label="Interval">{market.intervalSeconds}s</span>
                  <span role="cell" data-label="Expires">{new Date(market.expiresAt).toLocaleString()}</span>
                  <span role="cell" data-label="Snapshot">{compactId(market.snapshotHash)}</span>
                  <span role="cell" data-label="Decisions">{market.decisionCount}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="routePanel" aria-label="Observation controls and boundaries">
            <div className="progressionHub">
              <div>
                <span className="label">Controls</span>
                <strong>{proof.implementedControls.length} implemented</strong>
                <p>{proof.implementedControls.slice(0, 3).join("; ")}.</p>
              </div>
              <div>
                <span className="label">Verification</span>
                <strong>{proof.validation.fullVerification}</strong>
                <p>{proof.validation.integrationTest}; {proof.validation.test}.</p>
              </div>
              <div>
                <span className="label">Blocked claims</span>
                <strong>{proof.judgeSummary.blockedClaims.join(", ")}</strong>
                <p>Observation proof is not fill evidence, PnL evidence, or execution authorization.</p>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
