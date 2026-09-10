import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { ExecutionLifecycleSummary } from "../components/ExecutionLifecycleSummary.js";
import {
  apiErrorMessage,
  compactId,
  evaluateExperiment,
  evaluateExperimentV4,
  fetchExperimentExecution,
  fetchExperimentDetail,
  fetchLatestEvaluation,
  fetchLatestV4Assessment,
  fetchLiveShadowState,
  fetchProvenExperiment,
  fetchReplayRun,
  minimumSample,
  observeLiveShadow,
  runHistoricalReplay,
  type ReliabilityBinRecord
} from "../data.js";

function validUuid(value: string | undefined): value is string {
  return value !== undefined && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function ReliabilityChart({
  candidate,
  market
}: {
  readonly candidate: readonly ReliabilityBinRecord[];
  readonly market: readonly ReliabilityBinRecord[];
}) {
  const rows = [
    ...candidate.map((bin) => ({ ...bin, series: "Candidate" })),
    ...market.map((bin) => ({ ...bin, series: "Market" }))
  ];
  if (rows.length === 0) return <div className="stateBox">Reliability is unavailable until paired outcomes settle.</div>;
  const point = (value: number) => 24 + value * 252;
  return (
    <section className="reliabilityPanel" aria-labelledby="reliability-heading">
      <h3 id="reliability-heading">Reliability</h3>
      <p>Both series use the same paired observations. Wilson intervals describe observed sample rates.</p>
      <svg className="reliabilityChart" viewBox="0 0 300 300" role="img" aria-label="Predicted probability against observed UP frequency">
        <line x1="24" y1="276" x2="276" y2="24" className="reliabilityReference" />
        {rows.map((bin) => (
          <g key={`${bin.series}-${String(bin.lower)}`}>
            <line x1={point(bin.meanPrediction)} x2={point(bin.meanPrediction)} y1={276 - bin.wilson95[0] * 252} y2={276 - bin.wilson95[1] * 252} className={`reliabilityInterval ${bin.series.toLowerCase()}`} />
            <circle cx={point(bin.meanPrediction)} cy={276 - bin.outcomeRate * 252} r="4" className={`reliabilityPoint ${bin.series.toLowerCase()}`} />
          </g>
        ))}
        <text x="150" y="298" textAnchor="middle">Mean forecast</text>
        <text x="8" y="150" textAnchor="middle" transform="rotate(-90 8 150)">Observed UP rate</text>
      </svg>
      <div className="tableScroll">
        <table className="reliabilityTable">
          <caption>Reliability-bin values and 95% Wilson intervals</caption>
          <thead><tr><th>Series</th><th>Bin</th><th>Count</th><th>Mean forecast</th><th>Observed UP</th><th>95% interval</th></tr></thead>
          <tbody>{rows.map((bin) => <tr key={`table-${bin.series}-${String(bin.lower)}`}>
            <th scope="row">{bin.series}</th><td>{bin.lower.toFixed(1)}–{bin.upper.toFixed(1)}</td><td>{bin.count}</td>
            <td>{(bin.meanPrediction * 100).toFixed(1)}%</td><td>{(bin.outcomeRate * 100).toFixed(1)}%</td>
            <td>{(bin.wilson95[0] * 100).toFixed(1)}%–{(bin.wilson95[1] * 100).toFixed(1)}%</td>
          </tr>)}</tbody>
        </table>
      </div>
    </section>
  );
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
  const v4AssessmentQuery = useQuery({
    enabled: canLoad,
    queryKey: ["experiment", experimentId, "v4-assessment"],
    queryFn: () => fetchLatestV4Assessment(experimentId ?? "")
  });
  const liveShadowQuery = useQuery({
    enabled: canLoad,
    queryKey: ["experiment", experimentId, "live-shadow"],
    queryFn: () => fetchLiveShadowState(experimentId ?? "")
  });
  const executionQuery = useQuery({
    enabled: canLoad,
    queryKey: ["experiment", experimentId, "execution"],
    queryFn: () => fetchExperimentExecution(experimentId ?? "")
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
  const v4EvaluationMutation = useMutation({
    mutationFn: () => evaluateExperimentV4(experimentId ?? ""),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["experiment", experimentId, "v4-assessment"] });
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
  const liveObservation = liveShadowMutation.data?.data.observation ?? null;
  const assessment =
    evaluationMutation.data?.data.assessment ?? evaluationQuery.data?.data.assessment ?? null;
  const v4Assessment = v4EvaluationMutation.data?.data.assessment ?? v4AssessmentQuery.data?.data.assessment ?? null;
  const replayReady = replay?.status === "COMPLETED" || replay?.status === "SUCCEEDED";
  const isHistoricalReplay = experiment?.configuration.mode === "HISTORICAL_REPLAY";
  const isLiveShadow = experiment?.configuration.mode === "LIVE_SHADOW";
  const isV4 = experiment?.configuration.ruleVersion === "edgelab-evaluation-v4";

  if (isProvenExperiment) {
    const proven = provenQuery.data?.data.provenExperiment ?? null;
    return (
      <div className="pageStack">
        <section className="routeHero">
          <p className="eyebrow">Proven Qualification</p>
          <h1>This strategy earned observation, not execution.</h1>
          <p>
            This public path is the judge-facing EdgeLab verdict: historical DreamDEX evidence
            passed the qualification gate, the next allowed step is Shannon forward observation,
            and capital exposure remains blocked until stronger live proof exists.
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
              <div className="sectionHeader">
                <div>
                  <h2>{proven.title}</h2>
                  <p>{proven.selectionDisclosure}</p>
                </div>
                <span className="statusPill emphasisPill">Judge verdict ready</span>
              </div>
              <div className="verdictCard standaloneVerdict" aria-label="Current public verdict">
                <span>EdgeLab public verdict</span>
                <strong>{proven.assessment.verdict.replaceAll("_", " ")}</strong>
                <p>
                  {proven.sampleSize} scored observations, Brier{" "}
                  {proven.assessment.brierScore === null ? "not available" : proven.assessment.brierScore.toFixed(4)},
                  calibration bias{" "}
                  {proven.assessment.calibrationBias === null
                    ? "not available"
                    : proven.assessment.calibrationBias.toFixed(4)}.
                  The strategy advances only to forward observation.
                </p>
              </div>
              <div className="verdictLadder" aria-label="Proven experiment progression">
                <div className="ladderStep complete">
                  <span>01</span>
                  <strong>Historical qualification passed</strong>
                  <p>{proven.sampleSize} scored observations from {proven.replay.processedCount} processed markets.</p>
                </div>
                <div className="ladderStep current">
                  <span>02</span>
                  <strong>{proven.evidenceGate.decision.nextPermittedAction.replaceAll("_", " ")}</strong>
                  <p>Next phase must be collected forward before outcomes on Shannon live-shadow mode.</p>
                  <Link className="textLink" to="/evidence/archive/observe-001">
                    View OBSERVE-001 proof
                  </Link>
                </div>
                <div className="ladderStep blocked">
                  <span>03</span>
                  <strong>Execution exposure blocked</strong>
                  <p>EXG-003 is verified separately and does not count as this strategy's fill or PnL evidence.</p>
                </div>
              </div>
              <section className="resultPanel" aria-label="Evidence expansion path">
                <div className="sectionHeader">
                  <div>
                    <p className="eyebrow">Evidence Expansion</p>
                    <h2>What improves the product from here?</h2>
                  </div>
                  <span className="statusPill">No fabricated runs</span>
                </div>
                <div className="progressionHub">
                  <div>
                    <span className="label">More real experiments</span>
                    <strong>Supported through Lab exports</strong>
                    <p>Create new historical replays from authentic DreamDEX windows, evaluate them, then export reports.</p>
                  </div>
                  <div>
                    <span className="label">Forward observation</span>
                    <strong>Next permitted action</strong>
                    <p>Start a Shannon live-shadow workspace and persist pre-outcome decisions without a wallet signature.</p>
                  </div>
                  <div>
                    <span className="label">Execution linkage</span>
                    <strong>Human gate required</strong>
                    <p>Current EXG-003 proof is global. Linking execution to this candidate requires a future approved wallet action.</p>
                  </div>
                  <div>
                    <span className="label">Reporting</span>
                    <strong>Exportable now</strong>
                    <p>Use sanitized JSON reports for audit, reproducibility, and demo preparation.</p>
                  </div>
                </div>
              </section>
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
                <Link className="primaryAction" to="/lab?mode=live-shadow&asset=BTC&interval=900&name=BTC%20forward%20observation">
                  Start Forward Observation
                </Link>
                <Link className="secondaryAction" to="/evidence/archive/observe-001">
                  View Observation Proof
                </Link>
                <Link className="primaryAction" to="/lab/proven-experiment/evidence">
                  View Evidence Gate
                </Link>
                <a className="secondaryAction" href="/api/v2/proven-experiments/proven-experiment/report" target="_blank" rel="noreferrer">
                  Export Report
                </a>
                <Link className="secondaryAction" to="/lab/compare">
                  Compare Evidence
                </Link>
                <Link className="secondaryAction" to="/markets">
                  Explore Markets
                </Link>
                <Link className="secondaryAction" to="/evidence/archive/exg-003">
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
                    Converts persisted decisions and settled outcomes into a deterministic verdict.
                    Forward qualification and current order executability remain separate.
                  </p>
                  <button
                    type="button"
                    disabled={(!replayReady && !(isLiveShadow && (liveShadow?.decisionCount ?? 0) > 0)) || evaluationMutation.isPending || v4EvaluationMutation.isPending}
                    onClick={() => {
                      if (isV4) v4EvaluationMutation.mutate();
                      else evaluationMutation.mutate();
                    }}
                  >
                    {evaluationMutation.isPending || v4EvaluationMutation.isPending ? "Evaluating evidence..." : isV4 ? "Evaluate paired evidence v4" : "Evaluate Evidence"}
                  </button>
                  {evaluationMutation.isError ? (
                    <p className="inlineError" role="alert">
                      {apiErrorMessage(evaluationMutation.error)}
                    </p>
                  ) : null}
                  {v4EvaluationMutation.isError ? <p className="inlineError" role="alert">{apiErrorMessage(v4EvaluationMutation.error)}</p> : null}
                </div>
              </div>
              <div className="flowStep">
                <span className="stepIndex">3</span>
                <div>
                  <h3>Decision Gate</h3>
                  <p>The verdict is server-authored from persisted evidence, not computed by the browser.</p>
                  {assessment !== null || v4Assessment !== null ? (
                    <div className="actionRow">
                      <Link className="primaryAction" to={`/lab/${encodeURIComponent(experiment.experimentId)}/evidence`}>
                        View Evidence Gate
                      </Link>
                      {assessment?.verdict === "STRATEGY_QUALIFIED" ? (
                        <Link
                          className="primaryAction"
                          to={`/lab/${encodeURIComponent(experiment.experimentId)}/execution`}
                        >
                          Revalidate Execution Candidate
                        </Link>
                      ) : null}
                    </div>
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
                    <dt>Eligible settled decisions</dt>
                    <dd>
                      {liveShadow?.eligibleDecisionCount ?? 0}/{minimumSample} per track
                    </dd>
                  </div>
                  <div>
                    <dt>Remaining to evaluation</dt>
                    <dd>
                      {Math.max(0, minimumSample - (liveShadow?.eligibleDecisionCount ?? 0))}
                    </dd>
                  </div>
                  <div>
                    <dt>Abstentions</dt>
                    <dd>{liveShadow?.abstentionCount ?? 0}</dd>
                  </div>
                  <div>
                    <dt>Pending outcomes</dt>
                    <dd>{liveShadow?.pendingOutcomeCount ?? 0}</dd>
                  </div>
                  <div>
                    <dt>Outside decision window</dt>
                    <dd>{liveShadow?.timingExcludedDecisionCount ?? 0}</dd>
                  </div>
                  <div>
                    <dt>Excluded / data errors</dt>
                    <dd>{liveShadow?.excludedEpisodeCount ?? 0}</dd>
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
                {liveObservation !== null ? (
                  <div className="decisionList" aria-label="Latest live-shadow capture result">
                    <div className="decisionRow">
                      <span>Markets discovered</span>
                      <span>{liveObservation.discoveredMarketCount}</span>
                      <span>Lease</span>
                      <span>{liveObservation.leaseAcquired ? "ACQUIRED" : "REUSED"}</span>
                    </div>
                    {liveObservation.discoveryIssue !== undefined ? (
                      <div className="stateBox" role="status">
                        {liveObservation.discoveryIssue.reasonCode}: {liveObservation.discoveryIssue.message}
                      </div>
                    ) : null}
                    {liveObservation.observed.map((row) => (
                      <div className="decisionRow" key={row.marketId}>
                        <span className="monoText">{compactId(row.marketId)}</span>
                        <span>{row.skipped ? row.reasonCode ?? "SKIPPED" : "OBSERVED"}</span>
                        <span>{row.insertedDecisionCount} inserted</span>
                        <span>{row.reusedDecisionCount} reused</span>
                      </div>
                    ))}
                  </div>
                ) : null}
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
            {isV4 ? <section className="resultPanel" aria-label="V4 paired evaluation result">
              <div className="sectionHeader"><div><p className="eyebrow">Paired evaluation · v4</p><h2>{v4Assessment?.forecastStatus.replaceAll("_", " ") ?? "NOT EVALUATED"}</h2></div><span className="statusPill">Execution: {v4Assessment?.executionEligibility ?? "BLOCKED"}</span></div>
              {v4AssessmentQuery.isLoading ? <div className="stateBox">Loading paired assessment…</div> : null}
              {v4AssessmentQuery.isError ? <div className="stateBox errorState" role="alert">{apiErrorMessage(v4AssessmentQuery.error)}</div> : null}
              {v4Assessment !== null ? <>
                <p>{v4Assessment.forecastStatus === "FORWARD_CRITERIA_MET" ? "Forward forecast criteria met under the frozen rule. Testnet execution still requires separate economic and fresh-review gates." : "The frozen study has not met the formal forward criteria."}</p>
                <p>Captured-book economics: <strong>{v4Assessment.economicsStatus.replaceAll("_", " ")}</strong>. Returns include scheduled no-trade windows and exclude unavailable sources; gas remains disclosed in native units.</p>
                <dl className="factGrid">
                  <div><dt>Candidate Brier</dt><dd>{v4Assessment.pairedMetrics.candidateBrier?.toFixed(4) ?? "Unavailable"}</dd></div>
                  <div><dt>Market Brier</dt><dd>{v4Assessment.pairedMetrics.marketBrier?.toFixed(4) ?? "Unavailable"}</dd></div>
                  <div><dt>Brier skill</dt><dd>{v4Assessment.pairedMetrics.brierSkill === null ? "Unavailable" : `${(v4Assessment.pairedMetrics.brierSkill * 100).toFixed(1)}%`}</dd></div>
                  <div><dt>Paired interval</dt><dd>{v4Assessment.intervals.deltaBrier === null ? "Unavailable" : `${v4Assessment.intervals.deltaBrier.lower.toFixed(4)} to ${v4Assessment.intervals.deltaBrier.upper.toFixed(4)}`}</dd></div>
                  <div><dt>Paired coverage</dt><dd>{(v4Assessment.coverage.paired * 100).toFixed(1)}%</dd></div>
                  <div><dt>Paired observations</dt><dd>{v4Assessment.sampleCounts.paired}/{v4Assessment.sampleCounts.eligibleScheduled}</dd></div>
                  <div><dt>Candidate ECE</dt><dd>{v4Assessment.pairedMetrics.candidateEce?.toFixed(4) ?? "Unavailable"}</dd></div>
                  <div><dt>Market ECE</dt><dd>{v4Assessment.pairedMetrics.marketEce?.toFixed(4) ?? "Unavailable"}</dd></div>
                  <div><dt>Scenario coverage</dt><dd>{v4Assessment.coverage.scenario === undefined ? "Unavailable" : `${(v4Assessment.coverage.scenario * 100).toFixed(1)}%`}</dd></div>
                  <div><dt>Stress return interval</dt><dd>{v4Assessment.intervals.stressMeanPerWindowReturn == null ? "Unavailable" : `${(v4Assessment.intervals.stressMeanPerWindowReturn.lower * 100).toFixed(3)}% to ${(v4Assessment.intervals.stressMeanPerWindowReturn.upper * 100).toFixed(3)}%`}</dd></div>
                  <div><dt>After best week removal</dt><dd>{v4Assessment.economicsMetrics?.meanAfterBestWeekRemoval == null ? "Unavailable" : `${(v4Assessment.economicsMetrics.meanAfterBestWeekRemoval * 100).toFixed(3)}%`}</dd></div>
                  <div><dt>Scenario windows</dt><dd>{v4Assessment.economicsMetrics === undefined ? "Unavailable" : `${String(v4Assessment.economicsMetrics.tradeCount)} trades · ${String(v4Assessment.economicsMetrics.noTradeCount)} no-trades`}</dd></div>
                  <div><dt>Rule version</dt><dd>{v4Assessment.ruleVersion}</dd></div>
                </dl>
                <ReliabilityChart
                  candidate={v4Assessment.pairedMetrics.candidateReliability}
                  market={v4Assessment.pairedMetrics.marketReliability}
                />
              </> : <div className="stateBox">Collect paired settled observations, then run the v4 evaluation.</div>}
            </section> : null}
            {!isV4 ? <section className="resultPanel" aria-label="Evaluation result">
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
                  <div className="actionRow">
                    {assessment.verdict === "PROMOTE_TO_FORWARD_OBSERVATION" ? (
                      <Link
                        className="primaryAction"
                        to={`/lab?mode=live-shadow&asset=${encodeURIComponent(experiment.configuration.assets[0] ?? "BTC")}&interval=${encodeURIComponent(String(experiment.configuration.intervals[0] ?? 3600))}&name=${encodeURIComponent(`${experiment.name} forward observation`)}`}
                      >
                        Start Forward Observation
                      </Link>
                    ) : null}
                    <a
                      className="secondaryAction"
                      href={`/api/v2/experiments/${encodeURIComponent(experiment.experimentId)}/report`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Export Report
                    </a>
                    <Link className="secondaryAction" to="/evidence/archive/exg-003">
                      Review Execution Proof Boundary
                    </Link>
                  </div>
                </>
              ) : (
                <div className="stateBox">Run replay, then evaluate evidence to produce a verdict.</div>
              )}
            </section> : null}
            {executionQuery.isError ? (
              <div className="stateBox errorState" role="alert">
                {apiErrorMessage(executionQuery.error)}
              </div>
            ) : null}
            {executionQuery.data?.data.executionLifecycle !== null &&
            executionQuery.data?.data.executionLifecycle !== undefined ? (
              <ExecutionLifecycleSummary lifecycle={executionQuery.data.data.executionLifecycle} />
            ) : null}
          </>
        ) : null}
        <div className="actionRow">
          <Link className="secondaryAction" to={`/lab/${encodeURIComponent(experimentId ?? "proven-experiment")}/evidence`}>
            Open Evidence Gate
          </Link>
          <Link className="secondaryAction" to="/lab/compare">
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
