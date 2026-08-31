import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  apiErrorMessage,
  createComparison,
  fetchAssessments,
  fetchComparison,
  fetchComparisons,
  fetchProvenExperiment,
  type AssessmentSummaryRecord,
  type ComparisonRecord
} from "../data.js";

function metric(value: number | null): string {
  return value === null ? "NOT AVAILABLE" : value.toFixed(4);
}

function signedMetric(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "NOT AVAILABLE";
  }
  return value > 0 ? `+${value.toFixed(4)}` : value.toFixed(4);
}

function AssessmentRow({ item }: { readonly item: AssessmentSummaryRecord & { readonly displayOrder?: number } }) {
  return (
    <div role="row">
      <span role="cell" data-label="Experiment">{item.experimentName}</span>
      <span role="cell" data-label="Verdict" className="mutedCell">{item.verdict.replaceAll("_", " ")}</span>
      <span role="cell" data-label="Observations">{item.sampleSize}</span>
      <span role="cell" data-label="Calibration">{metric(item.calibrationBias)}</span>
      <span role="cell" data-label="Brier">{metric(item.brierScore)}</span>
      <span role="cell" data-label="Evidence plane">{item.evidencePlane}</span>
      <span role="cell" data-label="Linked execution">{item.tradeabilityStatus}</span>
      <span role="cell" data-label="PnL">{item.pnlStatus}</span>
      <span role="cell" data-label="Scope">{item.promotionScope}</span>
    </div>
  );
}

export default function ComparePage() {
  const navigate = useNavigate();
  const { comparisonId } = useParams();
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const assessmentsQuery = useQuery({
    queryKey: ["assessments"],
    queryFn: fetchAssessments
  });
  const comparisonsQuery = useQuery({
    queryKey: ["comparisons"],
    queryFn: fetchComparisons
  });
  const provenQuery = useQuery({
    queryKey: ["proven-experiment", "compare"],
    queryFn: () => fetchProvenExperiment("proven-experiment")
  });
  const comparisonDetailQuery = useQuery({
    enabled: comparisonId !== undefined,
    queryKey: ["comparison", comparisonId],
    queryFn: () => fetchComparison(comparisonId ?? "")
  });
  const comparisonMutation = useMutation({
    mutationFn: () =>
      createComparison({
        name: "Evidence comparison",
        assessmentIds: selectedIds
      }),
    onSuccess: async (response) => {
      const id = response.data.comparison?.comparisonId;
      if (id !== undefined) {
        await navigate(`/compare/${id}`);
      }
    }
  });
  const assessments = assessmentsQuery.data?.data.assessments ?? [];
  const savedComparison: ComparisonRecord | null =
    comparisonDetailQuery.data?.data.comparison ?? comparisonMutation.data?.data.comparison ?? null;
  const canSave = selectedIds.length >= 2 && selectedIds.length <= 4;
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  function toggle(id: string) {
    setSelectedIds((current) => {
      if (current.includes(id)) {
        return current.filter((item) => item !== id);
      }
      if (current.length >= 4) {
        return current;
      }
      return [...current, id];
    });
  }

  return (
    <div className="pageStack">
      <section className="routeHero">
        <p className="eyebrow">Strategy Comparison</p>
        <h1>Compare evidence dimensions, not vanity scores.</h1>
        <p>
          Choose two to four persisted assessments. EdgeLab preserves source plane, sample size,
          forecast metrics, linked execution state, and PnL availability so a candidate cannot win
          by collapsing evidence into a single score.
        </p>
      </section>
      <section className="routePanel" aria-label="Strategy comparison">
        {comparisonsQuery.isLoading ? <div className="stateBox">Loading saved comparisons...</div> : null}
        {comparisonsQuery.isError ? (
          <div className="stateBox errorState" role="alert">
            {apiErrorMessage(comparisonsQuery.error)}
          </div>
        ) : null}
        {comparisonsQuery.data?.data.comparisons.length ? (
          <div className="selectionList" aria-label="Saved comparison list">
            {comparisonsQuery.data.data.comparisons.map((comparison) => (
              <Link className="checkRow savedComparisonRow" to={`/compare/${comparison.comparisonId}`} key={comparison.comparisonId}>
                <span>{comparison.name}</span>
                <span className="statusPill">{comparison.itemCount} assessments</span>
              </Link>
            ))}
          </div>
        ) : null}
        {assessmentsQuery.isLoading ? <div className="stateBox">Loading persisted assessments...</div> : null}
        {assessmentsQuery.isError ? (
          <div className="stateBox errorState" role="alert">
            {apiErrorMessage(assessmentsQuery.error)}
          </div>
        ) : null}
        {assessments.length === 0 ? (
          <div className="stateBox">
            No private assessments exist for this research session yet. The public comparison below shows how EdgeLab
            separates historical qualification, forward observation, and execution proof; run and evaluate at least two
            experiments to save your own comparison.
          </div>
        ) : (
          <>
            <div className="selectionList" aria-label="Assessment selector">
              {assessments.map((assessment) => (
                <label className="checkRow" key={assessment.assessmentId}>
                  <input
                    type="checkbox"
                    checked={selectedSet.has(assessment.assessmentId)}
                    onChange={() => {
                      toggle(assessment.assessmentId);
                    }}
                  />
                  <span>{assessment.experimentName}</span>
                  <span className="statusPill">{assessment.verdict.replaceAll("_", " ")}</span>
                </label>
              ))}
            </div>
            <div className="actionRow">
              <button
                type="button"
                disabled={!canSave || comparisonMutation.isPending}
                onClick={() => {
                  comparisonMutation.mutate();
                }}
              >
                {comparisonMutation.isPending ? "Saving comparison..." : "Save Comparison"}
              </button>
              <span className="statusPill">{selectedIds.length}/4 selected</span>
            </div>
            {comparisonMutation.isError ? (
              <p className="inlineError" role="alert">
                {apiErrorMessage(comparisonMutation.error)}
              </p>
            ) : null}
          </>
        )}
      </section>
      <section className="routePanel" aria-label="Saved comparison">
        <div className="sectionHeader">
          <div>
            <p className="eyebrow">Immutable Comparison</p>
            <h2>{savedComparison?.name ?? "Latest selected evidence"}</h2>
          </div>
          <span className="statusPill">{comparisonDetailQuery.isFetching ? "Reloading" : "No composite score"}</span>
        </div>
        {comparisonDetailQuery.isError ? (
          <div className="stateBox errorState" role="alert">
            {apiErrorMessage(comparisonDetailQuery.error)}
          </div>
        ) : null}
        <div className="policyMatrix" role="table" aria-label="Policy evidence comparison">
          <div role="row">
            <span role="columnheader">Experiment</span>
            <span role="columnheader">Verdict</span>
            <span role="columnheader">Observations</span>
            <span role="columnheader">Calibration</span>
            <span role="columnheader">Brier</span>
            <span role="columnheader">Evidence plane</span>
            <span role="columnheader">Linked execution</span>
            <span role="columnheader">PnL</span>
            <span role="columnheader">Scope</span>
          </div>
          {(savedComparison?.items ?? assessments.filter((item) => selectedSet.has(item.assessmentId))).map((item) => (
            <AssessmentRow item={item} key={item.assessmentId} />
          ))}
        </div>
      </section>
      {assessments.length === 0 ? (
        <section className="routePanel" aria-label="Public comparison">
          <div className="sectionHeader">
            <div>
              <p className="eyebrow">Public Read-Only Comparison</p>
              <h2>One proven experiment, three maturity gaps.</h2>
            </div>
            <span className="statusPill">Qualification evidence; no capital authorization</span>
          </div>
          <div className="progressionHub" aria-label="Decision-useful public comparison">
            <div>
              <span className="label">Historical signal</span>
              <strong>{provenQuery.data?.data.provenExperiment.assessment.verdict.replaceAll("_", " ") ?? "Loading"}</strong>
              <p>
                {provenQuery.data?.data.provenExperiment.sampleSize ?? "Loading"} scored observations;
                neutral delta {signedMetric(provenQuery.data?.data.provenExperiment.assessment.neutralBaselineDelta)}.
              </p>
            </div>
            <div>
              <span className="label">Forward evidence</span>
              <strong>Not yet linked</strong>
              <p>Use the Strategy Lab forward-observation starter to collect pre-outcome Shannon decisions.</p>
            </div>
            <div>
              <span className="label">Execution evidence</span>
              <strong>Global proof only</strong>
              <p>EXG-003 verifies DreamDEX order lifecycle behavior but is not counted as this experiment's PnL.</p>
            </div>
          </div>
          {provenQuery.isError ? (
            <div className="stateBox errorState" role="alert">
              {apiErrorMessage(provenQuery.error)}
            </div>
          ) : null}
          <div className="policyMatrix publicMatrix" role="table" aria-label="Public evidence comparison">
            <div role="row">
              <span role="columnheader">Evidence phase</span>
              <span role="columnheader">Evidence plane</span>
              <span role="columnheader">Observations</span>
              <span role="columnheader">Supports</span>
              <span role="columnheader">Missing evidence</span>
              <span role="columnheader">Does not authorize</span>
            </div>
            <div role="row">
              <span role="cell" data-label="Evidence phase">Historical qualification</span>
              <span role="cell" data-label="Evidence plane">MAINNET_HISTORICAL</span>
              <span role="cell" data-label="Observations">
                {provenQuery.data?.data.provenExperiment.sampleSize ?? "Loading"}
              </span>
              <span role="cell" data-label="Supports">
                {provenQuery.data?.data.provenExperiment.evidenceGate.decision.promotionScope ?? "NOT_APPLICABLE"}
              </span>
              <span role="cell" data-label="Missing evidence">
                {provenQuery.data?.data.provenExperiment.evidenceGate.missingEvidence.join(", ") ?? "Loading"}
              </span>
              <span role="cell" data-label="Does not authorize">mainnet trading, autonomous execution, profit claims</span>
            </div>
            <div role="row">
              <span role="cell" data-label="Evidence phase">Forward observation</span>
              <span role="cell" data-label="Evidence plane">SHANNON_FORWARD</span>
              <span role="cell" data-label="Observations">Collect through live-shadow workspace</span>
              <span role="cell" data-label="Supports">continued observation only</span>
              <span role="cell" data-label="Missing evidence">experiment-linked forward sample</span>
              <span role="cell" data-label="Does not authorize">testnet order placement or capital claims</span>
            </div>
            <div role="row">
              <span role="cell" data-label="Evidence phase">Execution proof</span>
              <span role="cell" data-label="Evidence plane">SHANNON_EXECUTION</span>
              <span role="cell" data-label="Observations">one verified no-fill lifecycle</span>
              <span role="cell" data-label="Supports">DreamDEX write/cancel boundary proof</span>
              <span role="cell" data-label="Missing evidence">experiment-linked fills and realized PnL</span>
              <span role="cell" data-label="Does not authorize">mainnet trading or autonomous execution</span>
            </div>
          </div>
          <div className="actionRow">
            <Link className="primaryAction" to="/lab/proven-experiment">
              Inspect Proven Experiment
            </Link>
            <Link className="secondaryAction" to="/evidence/proven-experiment">
              Open Evidence Gate
            </Link>
            <Link className="secondaryAction" to="/lab?mode=live-shadow&asset=BTC&interval=900&name=BTC%20forward%20observation">
              Start Forward Observation
            </Link>
          </div>
        </section>
      ) : null}
    </div>
  );
}
