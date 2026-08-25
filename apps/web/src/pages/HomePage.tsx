import { Link } from "react-router-dom";
import { capturedSummary, capturedSummarySource } from "../data.js";

export default function HomePage() {
  const summary = capturedSummary;
  return (
    <div className="pageStack">
      <section className="heroGrid" aria-label="EdgeLab product overview">
        <div className="heroCopy">
          <p className="eyebrow">DreamDEX strategy qualification lab</p>
          <h1>Test a DreamDEX strategy before putting capital behind it.</h1>
          <p>
            EdgeLab combines authentic DreamDEX historical evidence, forward/live-shadow validation,
            and bounded Shannon execution proof to decide whether a strategy deserves promotion.
          </p>
          <div className="actionRow">
            <Link className="primaryAction large" to="/lab">
              Open Strategy Lab
            </Link>
            <Link className="secondaryAction" to="/markets?plane=historical">
              Explore DreamDEX History
            </Link>
            <Link className="secondaryAction" to="/lab/proven-experiment">
              Open Proven Experiment
            </Link>
            <Link className="secondaryAction" to="/proof">
              View Verified Execution
            </Link>
          </div>
        </div>
        <div className="modelPanel" aria-label="EdgeLab evidence model">
          <div className="modelInput">
            <span>Historical Reality</span>
            <strong>Mainnet read-only</strong>
          </div>
          <div className="modelInput">
            <span>Forward Evidence</span>
            <strong>Shannon observation</strong>
          </div>
          <div className="modelInput">
            <span>Execution Reality</span>
            <strong>Human-authorized proof</strong>
          </div>
          <div className="modelGate">
            <span>Evidence Gate</span>
            <strong>PROMOTE / HOLD / REJECT / INSUFFICIENT</strong>
          </div>
        </div>
      </section>

      <section className="threeColumn" aria-label="What judges can inspect">
        <article>
          <span className="label">Explore</span>
          <h2>DreamDEX markets become the research source.</h2>
          <p>Historical market routes are ready for verified mainnet data, filters, provenance, and detail views.</p>
        </article>
        <article>
          <span className="label">Operate</span>
          <h2>Experiments are application state.</h2>
          <p>Strategy Lab routes let judges create a fresh run or inspect a captured public replay with real evidence.</p>
        </article>
        <article>
          <span className="label">Verify</span>
          <h2>Shannon proof stays separate from mainnet research.</h2>
          <p>{`${String(summary.chain.submittedOrderCount)} submitted testnet order, ${String(
            summary.chain.fillCount
            )} fills, terminal state ${
              summary.chain.latestTerminalState ?? "unavailable"
            }. Source: ${capturedSummarySource}.`}</p>
        </article>
      </section>

      <section className="routePanel compactPanel" aria-label="Product boundary">
        <span className="label">Integrity boundary</span>
        <h2>Insufficient evidence is a protection mechanism, not the homepage outcome.</h2>
        <p>
          EdgeLab refuses promotion when forecast quality, tradeability, risk, settlement evidence,
          or PnL support is missing. The Evidence Gate route shows that reasoning after a real
          experiment has an evaluation result.
        </p>
      </section>
    </div>
  );
}
