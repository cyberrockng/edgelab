import { Link } from "react-router-dom";
import { QualificationJourney, type QualificationJourneyStage } from "../components/QualificationJourney.js";
import { capturedSummary, capturedSummarySource } from "../data.js";

const publicJourney: readonly QualificationJourneyStage[] = [
  {
    title: "Strategy + exact policy",
    status: "RECORDED",
    detail: "Versioned strategy and deterministic promotion rules.",
    state: "complete"
  },
  {
    title: "Forward OOS evidence",
    status: "REQUIRED NEXT",
    detail: "Genuine market generations captured before outcomes.",
    state: "current"
  },
  {
    title: "Strategy qualification",
    status: "GATED",
    detail: "Requires 30 eligible settled observations on one exact track.",
    state: "locked"
  },
  {
    title: "Fresh executable market",
    status: "LOCKED",
    detail: "Only checked after deterministic qualification.",
    state: "locked"
  },
  {
    title: "Wallet receipt + reconciliation",
    status: "UNPROVEN",
    detail: "Approval, IOC order, fill and settlement remain evidence-bound.",
    state: "unproven"
  }
] as const;

export default function HomePage() {
  const summary = capturedSummary;
  return (
    <div className="pageStack">
      <section className="heroGrid" aria-label="EdgeLab product overview">
        <div className="heroCopy">
          <p className="eyebrow">DreamDEX strategy qualification lab</p>
          <h1>EdgeLab decides whether a DreamDEX strategy has earned progression.</h1>
          <p>
            Before a strategy reaches execution exposure, EdgeLab checks the evidence chain:
            historical replay, forward observation, and bounded human-authorized Shannon proof.
            A weak candidate is blocked instead of dressed up as a trading signal.
          </p>
          <div className="actionRow">
            <Link className="primaryAction large" to="/lab/proven-experiment">
              Open Judge Verdict
            </Link>
            <Link className="secondaryAction" to="/lab?mode=live-shadow&asset=BTC&interval=900&name=BTC%20forward%20observation">
              Track Forward Qualification
            </Link>
          </div>
        </div>
        <div className="modelPanel" aria-label="EdgeLab evidence model">
          <div className="verdictCard">
            <span>Current public verdict</span>
            <strong>Promote to forward observation</strong>
            <p>Historical evidence passed the gate. Execution exposure remains closed.</p>
          </div>
          <div className="scoreStrip" aria-label="Current evidence scorecard">
            <div>
              <span>Processed</span>
              <strong>97</strong>
            </div>
            <div>
              <span>Scored</span>
              <strong>36</strong>
            </div>
            <div>
              <span>Brier</span>
              <strong>0.1775</strong>
            </div>
            <div>
              <span>Bias</span>
              <strong>0.0333</strong>
            </div>
          </div>
          <div className="modelInput status-verified">
            <span>1. Historical reality</span>
            <strong>Mainnet read-only passed</strong>
          </div>
          <div className="modelInput status-allowed-next">
            <span>2. Forward evidence</span>
            <strong>Next required observation</strong>
          </div>
          <div className="modelInput status-unlinked-global-proof-available">
            <span>3. Execution reality</span>
            <strong>{`${String(summary.chain.submittedOrderCount)} order / ${String(summary.chain.fillCount)} fills / ${summary.chain.latestTerminalState ?? "no terminal state"}`}</strong>
          </div>
          <div className="modelGate">
            <span>Gate rule</span>
            <strong>No filled strategy proof, no capital claim.</strong>
          </div>
        </div>
      </section>

      <QualificationJourney stages={publicJourney} />

      <section className="routePanel compactPanel thesisPanel" aria-label="Judge mode">
        <div className="sectionHeader">
          <div>
            <span className="label">Judge mode</span>
            <h2>One question, one verdict, every missing proof visible.</h2>
          </div>
          <span className="statusPill emphasisPill">Qualification before execution</span>
        </div>
        <div className="verdictLadder">
          <div className="ladderStep complete">
            <span>01</span>
            <strong>Historical replay passed</strong>
            <p>Authentic DreamDEX mainnet history, strict anti-lookahead, server-authored metrics.</p>
          </div>
          <div className="ladderStep current">
                <span>02</span>
                <strong>Forward observation required</strong>
                <p>Next evidence must be captured before outcomes on Shannon live-shadow mode.</p>
                <Link className="textLink" to="/observation">
                  View OBSERVE-001 proof
                </Link>
              </div>
          <div className="ladderStep blocked">
            <span>03</span>
            <strong>Execution exposure blocked</strong>
            <p>EXG-003 proves protocol lifecycle only; no strategy-linked fill or PnL is claimed.</p>
          </div>
        </div>
        <div className="actionRow judgeActions">
          <Link className="secondaryAction" to="/evidence/proven-experiment">
            Inspect Evidence Gate
          </Link>
          <Link className="textLink" to="/observation">
            Inspect forward observation evidence
          </Link>
        </div>
      </section>

      <section className="threeColumn" aria-label="Core product workflow">
        <article>
          <span className="label">Explore</span>
          <h2>DreamDEX markets become the research source.</h2>
          <p>Browse verified mainnet markets, filter by asset and interval, then open a real market as the evidence source.</p>
          <Link className="textLink" to="/markets?plane=mainnet-history">
            Explore DreamDEX history
          </Link>
        </article>
        <article>
          <span className="label">Operate</span>
          <h2>The workspace is where evidence becomes a decision.</h2>
          <p>Create a strategy experiment, run historical qualification, evaluate the result, then open the Evidence Gate.</p>
          <Link className="textLink" to="/lab">
            Start in Strategy Lab
          </Link>
        </article>
        <article>
          <span className="label">Verify</span>
          <h2>Shannon proof stays separate from mainnet research.</h2>
          <p>{`${String(summary.chain.submittedOrderCount)} submitted testnet order, ${String(
            summary.chain.fillCount
            )} fills, terminal state ${
              summary.chain.latestTerminalState ?? "unavailable"
            }. Source: ${capturedSummarySource}.`}</p>
          <Link className="textLink" to="/proof">
            View captured no-fill lifecycle
          </Link>
        </article>
      </section>

      <section className="routePanel compactPanel" aria-label="Product boundary">
        <span className="label">Integrity boundary</span>
        <h2>Promotion means forward observation, not capital execution.</h2>
        <p>
          Historical replay can only promote a strategy to forward observation. Tradeability,
          execution proof, and PnL stay separate, and bounded Shannon execution remains
          conditional and human-authorized.
        </p>
      </section>
    </div>
  );
}
