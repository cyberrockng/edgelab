import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { apiErrorMessage, capturedSummary, fetchEvidenceGate, fetchProvenExperiment, minimumSample } from "../data.js";

function normalizeStatus(status: string): string {
  return status.replaceAll("_", "-").replaceAll(" ", "-").toLowerCase();
}

function validUuid(value: string | undefined): value is string {
  return value !== undefined && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export default function EvidencePage() {
  const { experimentId } = useParams();
  const isProvenExperiment = experimentId === "proven-experiment";
  const canLoadEvidence = validUuid(experimentId);
  const evidenceQuery = useQuery({
    enabled: canLoadEvidence,
    queryKey: ["experiment", experimentId, "evaluation"],
    queryFn: () => fetchEvidenceGate(experimentId ?? "")
  });
  const provenQuery = useQuery({
    enabled: isProvenExperiment,
    queryKey: ["proven-experiment", experimentId],
    queryFn: () => fetchProvenExperiment("proven-experiment")
  });
  const evidence = evidenceQuery.data?.data.evidence ?? provenQuery.data?.data.provenExperiment.evidenceGate ?? null;
  const summary = capturedSummary;
  const sampleSize = summary.counts.decisions;
  const remainingSamples = Math.max(0, minimumSample - sampleSize);
  const chain = summary.chain;
  const placeholderRows = [
    {
      dimension: "Forecast sample",
      status: sampleSize >= minimumSample ? "READY FOR EVALUATION" : "INSUFFICIENT",
      value: `${String(sampleSize)}/${String(minimumSample)} observations`,
      detail: `${String(remainingSamples)} additional pre-outcome observations required before promotion can be considered.`
    },
    {
      dimension: "Forecast calibration",
      status: "NOT AVAILABLE",
      value: "no server assessment",
      detail: "Calibration is returned by the evaluation engine, not inferred in the browser."
    },
    {
      dimension: "DreamDEX tradeability",
      status: chain.tradeabilityStatus === "EVALUATED" ? "VERIFIED" : "NOT EVALUATED",
      value: `${String(chain.submittedOrderCount)} submitted / ${String(chain.terminalOrderCount)} terminal / ${String(chain.openOrderCount)} open`,
      detail: "Tradeability proof is separate from forecast quality and profitability."
    },
    {
      dimension: "Realized PnL",
      status: "NOT AVAILABLE",
      value: `${String(chain.fillCount)} fills`,
      detail: "Replay PnL and realized wallet PnL remain separate; no fill means no realized PnL claim."
    }
  ] as const;
  const gateRows = evidence?.gateRows ?? placeholderRows;
  const gateVerdict = evidence?.assessment.verdict.replaceAll("_", " ") ?? "AWAITING SERVER EVALUATION";
  const gateDetail =
    evidence === null
      ? "The browser does not manufacture PROMOTE, HOLD, REJECT, or INSUFFICIENT EVIDENCE."
      : evidence.verdictReasons.map((reason) => reason.replaceAll("_", " ")).join(" / ");

  return (
    <div className="pageStack">
      <section className="routeHero">
        <p className="eyebrow">Evidence Gate</p>
        <h1>What evidence caused the strategy decision?</h1>
        <p>Server evaluation data drives the verdict. The browser renders the result and reasons only.</p>
      </section>
      <section className="evidenceGate" aria-label="Evidence gate">
        <div className="gateCandidate">
          <span>Experiment</span>
          <strong>{evidence?.assessment.experimentName ?? experimentId ?? "No experiment selected"}</strong>
          <small>
            {evidence === null
              ? "Evidence is provenance-labeled by plane."
              : `${evidence.assessment.evidencePlane}; ${evidence.assessment.promotionScope}.`}
          </small>
        </div>
        <div className="gateBody" role="list" aria-label="Evidence gate dimensions">
          {evidenceQuery.isLoading || provenQuery.isLoading ? <div className="stateBox">Loading server Evidence Gate...</div> : null}
          {evidenceQuery.isError ? (
            <div className="stateBox errorState" role="alert">
              {apiErrorMessage(evidenceQuery.error)}
            </div>
          ) : null}
          {provenQuery.isError ? (
            <div className="stateBox errorState" role="alert">
              {apiErrorMessage(provenQuery.error)}
            </div>
          ) : null}
          {evidenceQuery.data?.data.state === "EVALUATION_REQUIRED" ? (
            <div className="stateBox">{evidenceQuery.data.data.message}</div>
          ) : null}
          {gateRows.map((row) => (
            <div className={`gateRow status-${normalizeStatus(row.status)}`} key={row.dimension} role="listitem">
              <div>
                <span className="gateLabel">{row.dimension}</span>
                <strong>{row.value}</strong>
                <p>{row.detail}</p>
              </div>
              <span className="statusPill">{row.status}</span>
            </div>
          ))}
        </div>
        <div className={`gateOutput ${evidence === null ? "neutralGate" : "verifiedGate"}`}>
          <span>Gate output</span>
          <strong>{gateVerdict}</strong>
          <p>{gateDetail}</p>
        </div>
      </section>
    </div>
  );
}
