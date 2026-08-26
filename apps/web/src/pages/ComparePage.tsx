import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  apiErrorMessage,
  createComparison,
  fetchAssessments,
  fetchComparison,
  fetchComparisons,
  type AssessmentSummaryRecord,
  type ComparisonRecord
} from "../data.js";

function metric(value: number | null): string {
  return value === null ? "NOT AVAILABLE" : value.toFixed(4);
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
  const comparisonDetailQuery = useQuery({
    enabled: comparisonId !== undefined,
    queryKey: ["comparison", comparisonId],
    queryFn: () => fetchComparison(comparisonId ?? "")
  });
  const comparisonMutation = useMutation({
    mutationFn: () =>
      createComparison({
        name: "Judge evidence comparison",
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
        <p>Choose two to four persisted assessments. EdgeLab preserves source plane, sample size, forecast metrics, linked execution state, and PnL availability.</p>
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
            No server assessments exist for this research session yet. Run and evaluate at least two experiments to save a comparison.
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
    </div>
  );
}
