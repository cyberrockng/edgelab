import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { apiErrorMessage, fetchExperimentDetail } from "../data.js";

function validUuid(value: string | undefined): value is string {
  return value !== undefined && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export default function ExperimentWorkspacePage() {
  const { experimentId } = useParams();
  const canLoad = validUuid(experimentId);
  const experimentQuery = useQuery({
    enabled: canLoad,
    queryKey: ["experiment", experimentId],
    queryFn: () => fetchExperimentDetail(experimentId ?? "")
  });
  const experiment = experimentQuery.data?.data.experiment;

  return (
    <div className="pageStack">
      <section className="routeHero">
        <p className="eyebrow">Experiment Workspace</p>
        <h1>Run replay, observe forward decisions, and evaluate evidence.</h1>
        <p>Server state will remain authoritative; this route already supports direct refresh.</p>
      </section>
      <section className="routePanel" aria-label="Experiment workspace state">
        <div className="sourceBar">
          <span className="statusPill">Application state</span>
          <span className="statusPill">Research-session owned</span>
          <span className="statusPill">No wallet write</span>
        </div>
        {!canLoad ? (
          <>
            <h2>Workspace needs a persisted experiment ID.</h2>
            <p className="monoText">{experimentId}</p>
            <p>Create an experiment from Strategy Lab to enter an operational workspace.</p>
          </>
        ) : null}
        {canLoad && experimentQuery.isLoading ? <div className="stateBox">Loading experiment workspace...</div> : null}
        {canLoad && experimentQuery.isError ? (
          <div className="stateBox errorState" role="alert">
            {apiErrorMessage(experimentQuery.error)}
          </div>
        ) : null}
        {experiment !== undefined ? (
          <>
            <h2>{experiment.name}</h2>
            <p className="monoText">{experiment.experimentId}</p>
            <dl className="factGrid">
              <div>
                <dt>Status</dt>
                <dd>{experiment.status}</dd>
              </div>
              <div>
                <dt>Mode</dt>
                <dd>{experiment.configuration.mode}</dd>
              </div>
              <div>
                <dt>Source plane</dt>
                <dd>{experiment.configuration.config.sourcePlane ?? "Not available"}</dd>
              </div>
              <div>
                <dt>Strategy</dt>
                <dd>{experiment.policies[0]?.label ?? "Not available"}</dd>
              </div>
              <div>
                <dt>Assets</dt>
                <dd>{experiment.configuration.assets.join(", ")}</dd>
              </div>
              <div>
                <dt>Intervals</dt>
                <dd>{experiment.configuration.intervals.join(", ")}s</dd>
              </div>
              <div>
                <dt>Config version</dt>
                <dd>v{experiment.configuration.version}</dd>
              </div>
              <div>
                <dt>Replay PnL</dt>
                <dd>{experiment.configuration.config.pnlStatus ?? "NOT_AVAILABLE"}</dd>
              </div>
            </dl>
            <p>
              This workspace is ready for the next handoff tasks: bounded replay, live-shadow capture,
              and server-side evaluation. The saved configuration is immutable and reloadable.
            </p>
          </>
        ) : null}
        <div className="actionRow">
          <Link className="secondaryAction" to={`/evidence/${encodeURIComponent(experimentId ?? "proven-experiment")}`}>
            Open Evidence Gate
          </Link>
          <Link className="secondaryAction" to="/compare">
            Compare
          </Link>
          <Link className="secondaryAction" to="/lab">
            Back to Lab
          </Link>
        </div>
      </section>
    </div>
  );
}
