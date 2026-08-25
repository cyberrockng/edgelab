import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import {
  apiErrorMessage,
  compactId,
  evaluateExperiment,
  fetchExperimentDetail,
  fetchLatestEvaluation,
  fetchReplayRun,
  runHistoricalReplay
} from "../data.js";

function validUuid(value: string | undefined): value is string {
  return value !== undefined && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export default function ExperimentWorkspacePage() {
  const { experimentId } = useParams();
  const canLoad = validUuid(experimentId);
  const queryClient = useQueryClient();
  const experimentQuery = useQuery({
    enabled: canLoad,
    queryKey: ["experiment", experimentId],
    queryFn: () => fetchExperimentDetail(experimentId ?? "")
  });
  const replayQuery = useQuery({
    enabled: canLoad,
    queryKey: ["experiment", experimentId, "replay"],
    queryFn: () => fetchReplayRun(experimentId ?? "")
  });
  const evaluationQuery = useQuery({
    enabled: canLoad,
    queryKey: ["experiment", experimentId, "evaluation"],
    queryFn: () => fetchLatestEvaluation(experimentId ?? "")
  });
  const replayMutation = useMutation({
    mutationFn: () => runHistoricalReplay(experimentId ?? ""),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["experiment", experimentId] });
      await queryClient.invalidateQueries({ queryKey: ["experiment", experimentId, "replay"] });
      await queryClient.invalidateQueries({ queryKey: ["experiment", experimentId, "evaluation"] });
    }
  });
  const evaluationMutation = useMutation({
    mutationFn: () => evaluateExperiment(experimentId ?? ""),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["experiment", experimentId] });
      await queryClient.invalidateQueries({ queryKey: ["experiment", experimentId, "evaluation"] });
    }
  });
  const experiment = experimentQuery.data?.data.experiment;
  const replay = replayQuery.data?.data.replay ?? null;
  const assessment =
    evaluationMutation.data?.data.assessment ?? evaluationQuery.data?.data.assessment ?? null;
  const replayReady = replay?.status === "SUCCEEDED";

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
            <div className="workspaceFlow" aria-label="Historical qualification workflow">
              <div className="flowStep">
                <span className="stepIndex">1</span>
                <div>
                  <h3>Historical Qualification</h3>
                  <p>
                    Runs the selected immutable policy against bounded DreamDEX mainnet history using
                    pre-outcome replay frames.
                  </p>
                  <button
                    type="button"
                    disabled={replayMutation.isPending || replay?.status === "RUNNING"}
                    onClick={() => {
                      replayMutation.mutate();
                    }}
                  >
                    {replayMutation.isPending || replay?.status === "RUNNING"
                      ? "Running qualification..."
                      : replayReady
                        ? "Replay Already Completed"
                        : "Run Historical Qualification"}
                  </button>
                  {replayMutation.isError ? (
                    <p className="inlineError" role="alert">
                      {apiErrorMessage(replayMutation.error)}
                    </p>
                  ) : null}
                </div>
              </div>
              <div className="flowStep">
                <span className="stepIndex">2</span>
                <div>
                  <h3>Evidence Evaluation</h3>
                  <p>
                    Converts persisted replay decisions into an evidence-gated verdict. Forecast quality,
                    tradeability, sufficiency, and PnL remain separate.
                  </p>
                  <button
                    type="button"
                    disabled={!replayReady || evaluationMutation.isPending}
                    onClick={() => {
                      evaluationMutation.mutate();
                    }}
                  >
                    {evaluationMutation.isPending ? "Evaluating evidence..." : "Evaluate Evidence"}
                  </button>
                  {evaluationMutation.isError ? (
                    <p className="inlineError" role="alert">
                      {apiErrorMessage(evaluationMutation.error)}
                    </p>
                  ) : null}
                </div>
              </div>
              <div className="flowStep">
                <span className="stepIndex">3</span>
                <div>
                  <h3>Decision Gate</h3>
                  <p>The verdict is server-authored from persisted evidence, not computed by the browser.</p>
                  {assessment !== null ? (
                    <Link className="primaryAction" to={`/evidence/${encodeURIComponent(experiment.experimentId)}`}>
                      View Evidence Gate
                    </Link>
                  ) : (
                    <span className="statusPill">Waiting for evaluation</span>
                  )}
                </div>
              </div>
            </div>
            <section className="resultPanel" aria-label="Replay result">
              <div className="sectionHeader">
                <div>
                  <p className="eyebrow">Replay State</p>
                  <h2>{replay?.status ?? "READY"}</h2>
                </div>
                <span className="statusPill">MAINNET HISTORICAL / READ ONLY</span>
              </div>
              {replayQuery.isLoading ? <div className="stateBox">Loading replay state...</div> : null}
              {replayQuery.isError ? (
                <div className="stateBox errorState" role="alert">
                  {apiErrorMessage(replayQuery.error)}
                </div>
              ) : null}
              {replay !== null ? (
                <>
                  <dl className="factGrid">
                    <div>
                      <dt>Markets selected</dt>
                      <dd>{replay.selectedCount}</dd>
                    </div>
                    <div>
                      <dt>Markets processed</dt>
                      <dd>{replay.processedCount}</dd>
                    </div>
                    <div>
                      <dt>Decisions</dt>
                      <dd>{replay.decisions?.length ?? replay.processedCount}</dd>
                    </div>
                    <div>
                      <dt>Scored decisions</dt>
                      <dd>{replay.scoredCount}</dd>
                    </div>
                    <div>
                      <dt>Abstentions / unusable</dt>
                      <dd>{replay.excludedCount}</dd>
                    </div>
                    <div>
                      <dt>Frame provenance</dt>
                      <dd className="monoText">{replay.outputHash === null ? "Pending" : compactId(replay.outputHash)}</dd>
                    </div>
                  </dl>
                  <div className="decisionList" aria-label="Replay decisions">
                    {(replay.decisions ?? []).slice(0, 6).map((decision) => (
                      <div className="decisionRow" key={decision.id}>
                        <span className="monoText">{compactId(decision.marketId)}</span>
                        <span>{decision.action}</span>
                        <span>{decision.forecastPUp === null ? "ABSTAIN" : decision.forecastPUp.toFixed(3)}</span>
                        <span>{decision.outcomeResult ?? "Outcome unavailable"}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="stateBox">No replay has been run for this experiment yet.</div>
              )}
            </section>
            <section className="resultPanel" aria-label="Evaluation result">
              <div className="sectionHeader">
                <div>
                  <p className="eyebrow">Evaluation</p>
                  <h2>{assessment === null ? "NOT EVALUATED" : assessment.verdict.replace("_", " ")}</h2>
                </div>
                <span className="statusPill">PnL: {assessment?.pnlStatus ?? "NOT_AVAILABLE"}</span>
              </div>
              {evaluationQuery.isLoading ? <div className="stateBox">Loading evaluation...</div> : null}
              {evaluationQuery.isError ? (
                <div className="stateBox errorState" role="alert">
                  {apiErrorMessage(evaluationQuery.error)}
                </div>
              ) : null}
              {assessment !== null ? (
                <>
                  <dl className="factGrid">
                    <div>
                      <dt>Sample size</dt>
                      <dd>{assessment.sampleSize}</dd>
                    </div>
                    <div>
                      <dt>Excluded</dt>
                      <dd>{assessment.exclusionCount}</dd>
                    </div>
                    <div>
                      <dt>Brier score</dt>
                      <dd>{assessment.brierScore === null ? "NOT AVAILABLE" : assessment.brierScore.toFixed(4)}</dd>
                    </div>
                    <div>
                      <dt>Calibration bias</dt>
                      <dd>{assessment.calibrationBias === null ? "NOT AVAILABLE" : assessment.calibrationBias.toFixed(4)}</dd>
                    </div>
                    <div>
                      <dt>Promotion scope</dt>
                      <dd>{assessment.promotionScope}</dd>
                    </div>
                    <div>
                      <dt>Evidence plane</dt>
                      <dd>{assessment.evidencePlane}</dd>
                    </div>
                  </dl>
                  <div className="reasonList">
                    {assessment.reasonCodes.map((reason) => (
                      <span className="statusPill" key={reason}>
                        {reason.replaceAll("_", " ")}
                      </span>
                    ))}
                  </div>
                </>
              ) : (
                <div className="stateBox">Run replay, then evaluate evidence to produce a verdict.</div>
              )}
            </section>
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
