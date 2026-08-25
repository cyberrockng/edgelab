import { useParams } from "react-router-dom";
import { capturedSummary, minimumSample } from "../data.js";

function normalizeStatus(status: string): string {
  return status.replaceAll(" ", "-").toLowerCase();
}

export default function EvidencePage() {
  const { experimentId } = useParams();
  const summary = capturedSummary;
  const sampleSize = summary.counts.decisions;
  const remainingSamples = Math.max(0, minimumSample - sampleSize);
  const chain = summary.chain;
  const gateRows = [
    {
      label: "Forecast sample",
      status: sampleSize >= minimumSample ? "READY FOR EVALUATION" : "INSUFFICIENT",
      value: `${String(sampleSize)}/${String(minimumSample)} observations`,
      detail: `${String(remainingSamples)} additional pre-outcome observations required before promotion can be considered.`
    },
    {
      label: "Forecast calibration",
      status: "NOT AVAILABLE",
      value: "no server assessment",
      detail: "Calibration will be returned by the evaluation engine, not inferred in the browser."
    },
    {
      label: "DreamDEX tradeability",
      status: chain.tradeabilityStatus === "EVALUATED" ? "VERIFIED" : "NOT EVALUATED",
      value: `${String(chain.submittedOrderCount)} submitted / ${String(chain.terminalOrderCount)} terminal / ${String(chain.openOrderCount)} open`,
      detail: "Tradeability proof is separate from forecast quality and profitability."
    },
    {
      label: "Realized PnL",
      status: "NOT AVAILABLE",
      value: `${String(chain.fillCount)} fills`,
      detail: "No fill means no realized PnL claim."
    }
  ] as const;

  return (
    <div className="pageStack">
      <section className="routeHero">
        <p className="eyebrow">Evidence Gate</p>
        <h1>What evidence caused the strategy decision?</h1>
        <p>The final verdict on this route will be loaded from server evaluation data after EVAL-002.</p>
      </section>
      <section className="evidenceGate" aria-label="Evidence gate">
        <div className="gateCandidate">
          <span>Experiment</span>
          <strong>{experimentId ?? "No experiment selected"}</strong>
          <small>Evidence is provenance-labeled by plane.</small>
        </div>
        <div className="gateBody" role="list" aria-label="Evidence gate dimensions">
          {gateRows.map((row) => (
            <div className={`gateRow status-${normalizeStatus(row.status)}`} key={row.label} role="listitem">
              <div>
                <span className="gateLabel">{row.label}</span>
                <strong>{row.value}</strong>
                <p>{row.detail}</p>
              </div>
              <span className="statusPill">{row.status}</span>
            </div>
          ))}
        </div>
        <div className="gateOutput neutralGate">
          <span>Gate output</span>
          <strong>AWAITING SERVER EVALUATION</strong>
          <p>The browser does not manufacture PROMOTE, HOLD, REJECT, or INSUFFICIENT EVIDENCE.</p>
        </div>
      </section>
    </div>
  );
}
