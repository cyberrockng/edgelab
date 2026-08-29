import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { apiErrorMessage, fetchEvidenceGate, fetchProvenExperiment, minimumSample } from "../data.js";

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
  const sampleSize = 0;
  const remainingSamples = Math.max(0, minimumSample - sampleSize);
  const placeholderRows = [
    {
      dimension: "Forecast sample",
      status: "INSUFFICIENT",
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
      dimension: "Linked DreamDEX execution proof",
      status: "NOT AVAILABLE",
      value: "no experiment-linked proof",
      detail: "Global EXG-003 proof remains available on the Proof route, but it is not counted as this experiment's tradeability evidence."
    },
    {
      dimension: "Realized PnL",
      status: "NOT AVAILABLE",
      value: "no experiment-linked fills",
      detail: "Replay PnL and realized wallet PnL remain separate; no fill means no realized PnL claim."
    }
  ] as const;
  const gateRows = evidence?.gateRows ?? placeholderRows;
  const gateVerdict = evidence?.assessment.verdict.replaceAll("_", " ") ?? "AWAITING SERVER EVALUATION";
  const qualificationIncomplete = evidence?.assessment.verdict === "INSUFFICIENT_EVIDENCE";
  const gateDetail =
    evidence === null
      ? "The browser does not manufacture PROMOTE TO FORWARD OBSERVATION, HOLD, REJECT, or INSUFFICIENT EVIDENCE."
      : evidence.decision.reason;

  return (
    <div className="pageStack">
      <section className="routeHero">
        <p className="eyebrow">Evidence Gate</p>
        <h1>What evidence caused the strategy decision?</h1>
        <p>
          Start from an Experiment Workspace, then use this gate to inspect the server-authored
          verdict, missing evidence, next action, and boundaries.
        </p>
      </section>
      <section className="evidenceGate" aria-label="Evidence gate">
        <div className="gateCandidate">
          <span>Experiment</span>
          <strong>{evidence?.assessment.experimentName ?? experimentId ?? "No experiment selected"}</strong>
          <small>
            {evidence === null
              ? "Evidence is provenance-labeled by plane."
              : `${evidence.decision.sourcePlane}; scope ${evidence.decision.promotionScope}.`}
          </small>
        </div>
        <div className={`gateDecision status-${normalizeStatus(evidence?.assessment.verdict ?? "pending")}`}>
          <span>{qualificationIncomplete ? "Qualification incomplete" : "Decision"}</span>
          <strong>{gateVerdict}</strong>
          <p>{gateDetail}</p>
          {qualificationIncomplete ? (
            <p className="decisionNote">
              EdgeLab found real DreamDEX evidence and evaluated it. Advancement remains closed
              because the support set is not yet strong enough.
            </p>
          ) : null}
          {evidence !== null ? (
            <dl className="factGrid compactFacts">
              <div>
                <dt>Next allowed action</dt>
                <dd>{evidence.decision.nextPermittedAction.replaceAll("_", " ")}</dd>
              </div>
              <div>
                <dt>Missing evidence</dt>
                <dd>{evidence.decision.missingEvidence.length === 0 ? "None" : evidence.decision.missingEvidence.join(", ")}</dd>
              </div>
              <div>
                <dt>Reason codes</dt>
                <dd>{evidence.verdictReasons.join(", ")}</dd>
              </div>
              <div>
                <dt>Does not authorize</dt>
                <dd>{evidence.decision.doesNotAuthorize.join(", ")}</dd>
              </div>
              <div>
                <dt>Decided at</dt>
                <dd>{new Date(evidence.decision.decidedAt).toLocaleString()}</dd>
              </div>
            </dl>
          ) : null}
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
        {evidence !== null ? (
          <div className="stageRail" aria-label="Evidence progression">
            {evidence.progression.stages.map((stage) => (
              <div className={`stageNode status-${normalizeStatus(stage.status)}`} key={stage.stage}>
                <span>{stage.stage}</span>
                <strong>{stage.status.replaceAll("_", " ")}</strong>
                <p>{stage.plane}</p>
                <small>{stage.detail}</small>
              </div>
            ))}
          </div>
        ) : null}
        <div className={`gateOutput ${evidence === null ? "neutralGate" : "verifiedGate"}`}>
          <span>Gate output</span>
          <strong>{gateVerdict}</strong>
          <p>
            {qualificationIncomplete
              ? "Advancement remains unavailable until missing evidence is collected and a new server evaluation permits progression."
              : gateDetail}
          </p>
        </div>
      </section>
    </div>
  );
}
