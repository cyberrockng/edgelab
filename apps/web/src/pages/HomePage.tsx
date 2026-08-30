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
            EdgeLab is the promotion layer before trading terminals and autonomous agents. It
            combines authentic DreamDEX history, forward/live-shadow validation, and bounded
            Shannon execution proof to decide the next safe testing step.
          </p>
          <div className="actionRow">
            <Link className="primaryAction large" to="/lab">
              Open Strategy Lab
            </Link>
            <Link className="secondaryAction" to="/lab/proven-experiment">
              See Proven Experiment
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
            <strong>advance only when evidence earns it</strong>
          </div>
        </div>
      </section>

      <section className="routePanel compactPanel thesisPanel" aria-label="Why EdgeLab exists">
        <span className="label">Why EdgeLab exists</span>
        <h2>A strategy does not graduate because it looks promising once.</h2>
        <p>
          EdgeLab forces every candidate through the same evidence chain: historical reality,
          forward observation, execution proof, and a server-authored verdict. If the evidence is
          thin, the product blocks advancement instead of manufacturing confidence.
        </p>
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
            View verified execution
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
