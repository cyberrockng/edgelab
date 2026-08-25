import { Link, useParams } from "react-router-dom";

export default function ExperimentWorkspacePage() {
  const { experimentId } = useParams();
  return (
    <div className="pageStack">
      <section className="routeHero">
        <p className="eyebrow">Experiment Workspace</p>
        <h1>Run replay, observe forward decisions, and evaluate evidence.</h1>
        <p>Server state will remain authoritative; this route already supports direct refresh.</p>
      </section>
      <section className="routePanel" aria-label="Experiment workspace state">
        <span className="statusPill">Workspace route ready</span>
        <h2>Experiment state pending API integration</h2>
        <p className="monoText">{experimentId ?? "No experiment selected"}</p>
        <p>
          Replay jobs, live-shadow observations, evaluation actions, and timelines will attach here
          after EXP-002, REPLAY-002, LIVE-002, and EVAL-002.
        </p>
        <div className="actionRow">
          <Link className="secondaryAction" to={`/evidence/${encodeURIComponent(experimentId ?? "proven-experiment")}`}>
            Open Evidence Gate
          </Link>
          <Link className="secondaryAction" to="/compare">
            Compare
          </Link>
        </div>
      </section>
    </div>
  );
}
