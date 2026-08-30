import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import {
  apiErrorMessage,
  compactId,
  evaluateExperiment,
  fetchExperimentDetail,
  fetchLatestEvaluation,
  fetchLiveShadowState,
  fetchProvenExperiment,
  fetchReplayRun,
  observeLiveShadow,
  runHistoricalReplay
} from "../data.js";

function validUuid(value: string | undefined): value is string {
  return value !== undefined && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export default function ExperimentWorkspacePage() {
  const { experimentId } = useParams();
  const isProvenExperiment = experimentId === "proven-experiment";
  const canLoad = validUuid(experimentId);
  const queryClient = useQueryClient();
  const provenQuery = useQuery({
    enabled: isProvenExperiment,
    queryKey: ["proven-experiment", "workspace"],
    queryFn: () => fetchProvenExperiment("proven-experiment")
  });
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
  const liveShadowQuery = useQuery({
    enabled: canLoad,
    queryKey: ["experiment", experimentId, "live-shadow"],
    queryFn: () => fetchLiveShadowState(experimentId ?? "")
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
  const liveShadowMutation = useMutation({
    mutationFn: () => observeLiveShadow(experimentId ?? ""),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["experiment", experimentId] });
      await queryClient.invalidateQueries({ queryKey: ["experiment", experimentId, "live-shadow"] });
    }
  });
  const experiment = experimentQuery.data?.data.experiment;
  const replay = replayQuery.data?.data.replay ?? null;
  const liveShadow =
    liveShadowMutation.data?.data.liveShadow ?? liveShadowQuery.data?.data.liveShadow ?? null;
  const assessment =
    evaluationMutation.data?.data.assessment ?? evaluationQuery.data?.data.assessment ?? null;
  const replayReady = replay?.status === "COMPLETED" || replay?.status === "SUCCEEDED";
  const isHistoricalReplay = experiment?.configuration.mode === "HISTORICAL_REPLAY";
  const isLiveShadow = experiment?.configuration.mode === "LIVE_SHADOW";

  if (isProvenExperiment) {
    const proven = provenQuery.data?.data.provenExperiment ?? null;
    return (
      <div className="pageStack">
        <section className="routeHero">
          <p className="eyebrow">Proven Qualification</p>
          <h1>Inspect a captured DreamDEX evidence run.</h1>
          <p>
            This public path is reproducible from sanitized artifacts. It shows how historical
            qualification produces a bounded next action without authorizing capital execution.
          </p>
        </section>
        <section className="routePanel" aria-label="Proven experiment workspace">
          {provenQuery.isLoading ? <div className="stateBox">Loading proven experiment...</div> : null}
          {provenQuery.isError ? (
            <div className="stateBox errorState" role="alert">
              {apiErrorMessage(provenQuery.error)}
            </div>
          ) : null}
          {proven !== null ? (
            <>
              <div className="sourceBar">
                <span className="statusPill">PUBLIC PROVEN</span>
                <span className="statusPill">{proven.source.plane}</span>
                <span className="statusPill">No blockchain write</span>
                {proven.verdict === "INSUFFICIENT_EVIDENCE" ? (
                  <span className="statusPill emphasisPill">Qualification incomplete</span>
                ) : null}
              </div>
              <h2>{proven.title}</h2>
              <p>{proven.selectionDisclosure}</p>
              <div className="progressionHub" aria-label="Proven experiment progression">
                <div>
                  <span className="label">1. Historical qualification</span>
                  <strong>{proven.assessment.verdict.replaceAll("_", " ")}</strong>
                  <p>{proven.sampleSize} scored observations from {proven.replay.processedCount} processed markets.</p>
                </div>
                <div>
                  <span className="label">2. Forward observation</span>
                  <strong>{proven.evidenceGate.decision.nextPermittedAction.replaceAll("_", " ")}</strong>
                  <p>Next phase remains separate from historical evidence and must be collected forward.</p>
                </div>
                <div>
                  <span className="label">3. Execution proof</span>
                  <strong>Verified separately</strong>
                  <p>Shannon execution proof demonstrates protocol write boundaries, not this strategy's PnL.</p>
                </div>
              </div>
              <dl className="factGrid">
                <div>
                  <dt>Strategy</dt>
                  <dd>{proven.experiment.policy}</dd>
                </div>
                <div>
                  <dt>Market</dt>
                  <dd className="monoText">{compactId(proven.market.stableMarketId)}</dd>
                </div>
                <div>
                  <dt>Replay status</dt>
                  <dd>{proven.replay.status}</dd>
                </div>
                <div>
                  <dt>Processed</dt>
                  <dd>{proven.replay.processedCount}</dd>
                </div>
                <div>
                  <dt>Scored</dt>
                  <dd>{proven.replay.scoredCount}</dd>
                </div>
                <div>
                  <dt>Excluded</dt>
                  <dd>{proven.replay.excludedCount}</dd>
                </div>
                <div>
                  <dt>Decision</dt>
                  <dd>{proven.decision.action}</dd>
                </div>
                <div>
                  <dt>Outcome</dt>
                  <dd>{proven.decision.outcomeResult ?? "NOT AVAILABLE"}</dd>
                </div>
                <div>
                  <dt>Verdict</dt>
                  <dd>{proven.assessment.verdict.replaceAll("_", " ")}</dd>
                </div>
                <div>
                  <dt>PnL</dt>
                  <dd>{proven.assessment.pnlStatus}</dd>
                </div>
                <div>
                  <dt>Replay hash</dt>
                  <dd className="monoText">{compactId(proven.replay.outputHash)}</dd>
                </div>
                <div>
                  <dt>Export</dt>
                  <dd>{proven.reproducibility.exportPath}</dd>
                </div>
              </dl>
              <section className="resultPanel" aria-label="Proven anti-lookahead evidence">
                <div className="sectionHeader">
                  <div>
                    <p className="eyebrow">Replay integrity</p>
                    <h2>{proven.antiLookahead.decisionFrames}</h2>
                  </div>
                  <span className="statusPill">Book: {proven.replay.bookReconstruction}</span>
                </div>
                <p>{proven.antiLookahead.outcomeEmbargo}</p>
                <div className="reasonList">
                  {proven.decision.reasonCodes.map((reason) => (
                    <span className="statusPill" key={reason}>
                      {reason.replaceAll("_", " ")}
                    </span>
                  ))}
                </div>
              </section>
              <div className="actionRow">
                <Link className="primaryAction" to="/evidence/proven-experiment">
                  View Evidence Gate
                </Link>
                <Link className="secondaryAction" to="/compare">
                  Compare Evidence
                </Link>
                <Link className="secondaryAction" to="/markets">
                  Explore Markets
                </Link>
                <Link className="secondaryAction" to="/proof">
                  View Shannon Proof
                </Link>
              </div>
            </>
          ) : null}
        </section>
      </div>
    );
  }

  return (
    <div className="pageStack">
      <section className="routeHero">
        <p className="eyebrow">Experiment Workspace</p>
        <h1>Run replay, observe forward decisions, and evaluate evidence.</h1>
        <p>
          The workspace is the product hub: run historical qualification, collect forward evidence,
          evaluate the result, then open the Evidence Gate for the next permitted action.
        </p>
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
            <div className="progressionHub" aria-label="Experiment progression">
              <div>
                <span className="label">1. Historical qualification</span>
                <strong>{replay?.status ?? (isHistoricalReplay ? "READY" : "NOT SELECTED")}</strong>
                <p>{isHistoricalReplay ? "Replay uses bounded mainnet history with pre-outcome frames." : "This experiment is configured for live shadow."}</p>
              </div>
              <div>
                <span className="label">2. Forward observation</span>
                <strong>{isLiveShadow ? `${String(liveShadow?.decisionCount ?? 0)} decisions` : "Available after qualification"}</strong>
                <p>Forward decisions are captured before outcomes and remain separate from historical replay.</p>
              </div>
              <div>
                <span className="label">3. Evidence Gate</span>
                <strong>{assessment === null ? "WAITING FOR EVALUATION" : assessment.verdict.replaceAll("_", " ")}</strong>
                <p>The server-authored verdict decides the next allowed testing step.</p>
              </div>
            </div>
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
                    disabled={!isHistoricalReplay || replayMutation.isPending || replay?.status === "RUNNING"}
                    onClick={() => {
                      replayMutation.mutate();
                    }}
                  >
                    {!isHistoricalReplay
                      ? "Historical replay not selected"
                      : replayMutation.isPending || replay?.status === "RUNNING"
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
            {isLiveShadow ? (
              <section className="resultPanel" aria-label="Live-shadow observation">
                <div className="sectionHeader">
                  <div>
                    <p className="eyebrow">Forward Observation</p>
                    <h2>Live Shadow</h2>
                  </div>
                  <span className="statusPill">SHANNON FORWARD / NO WALLET WRITE</span>
                </div>
                <p>
                  Capture a current DreamDEX market snapshot and persist the strategy decision before
                  the outcome is known. This is an application write only.
                </p>
                <button
                  type="button"
                  disabled={liveShadowMutation.isPending}
                  onClick={() => {
                    liveShadowMutation.mutate();
                  }}
                >
                  {liveShadowMutation.isPending ? "Capturing live shadow..." : "Capture Live Shadow Observation"}
                </button>
                {liveShadowMutation.isError ? (
                  <p className="inlineError" role="alert">
                    {apiErrorMessage(liveShadowMutation.error)}
                  </p>
                ) : null}
                {liveShadowQuery.isError ? (
                  <div className="stateBox errorState" role="alert">
                    {apiErrorMessage(liveShadowQuery.error)}
                  </div>
                ) : null}
                <dl className="factGrid">
                  <div>
                    <dt>Episodes</dt>
                    <dd>{liveShadow?.episodeCount ?? 0}</dd>
                  </div>
                  <div>
                    <dt>Snapshots</dt>
                    <dd>{liveShadow?.snapshotCount ?? 0}</dd>
                  </div>
                  <div>
                    <dt>Decisions</dt>
                    <dd>{liveShadow?.decisionCount ?? 0}</dd>
                  </div>
                  <div>
                    <dt>Latest market</dt>
                    <dd className="monoText">
                      {liveShadow?.latestMarketId === null || liveShadow?.latestMarketId === undefined
                        ? "Not captured"
                        : compactId(liveShadow.latestMarketId)}
                    </dd>
                  </div>
                  <div>
                    <dt>Latest decision</dt>
                    <dd>{liveShadow?.latestDecidedAt ?? "Not captured"}</dd>
                  </div>
                  <div>
                    <dt>Blockchain writes</dt>
                    <dd>NONE</dd>
                  </div>
                </dl>
              </section>
            ) : null}
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
                  <h2>{assessment === null ? "NOT EVALUATED" : assessment.verdict.replaceAll("_", " ")}</h2>
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
