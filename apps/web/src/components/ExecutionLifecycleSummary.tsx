import { Link } from "react-router-dom";
import { compactId, type ExecutionLifecycleResponse } from "../data.js";

type Lifecycle = NonNullable<ExecutionLifecycleResponse["executionLifecycle"]>;

export function ExecutionLifecycleSummary({ lifecycle }: { readonly lifecycle: Lifecycle }) {
  return (
    <section className="resultPanel" aria-label="Canonical strategy execution lifecycle">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Canonical Execution Result</p>
          <h2>{lifecycle.publicClaim.replaceAll("_", " ")}</h2>
        </div>
        <span className="statusPill">{lifecycle.state.replaceAll("_", " ")}</span>
      </div>
      <p>
        This is the same strategy-linked server record used by the workspace, Evidence Gate, and
        proof view. A confirmed transaction is not described as a fill unless order evidence proves it.
      </p>
      <dl className="factGrid">
        <div>
          <dt>Qualification</dt>
          <dd>{lifecycle.qualification.verdict.replaceAll("_", " ")}</dd>
        </div>
        <div>
          <dt>Assessment</dt>
          <dd className="monoText">{compactId(lifecycle.qualification.assessmentHash)}</dd>
        </div>
        <div>
          <dt>Order transaction</dt>
          <dd>{lifecycle.transactions.order?.state ?? "NOT SUBMITTED"}</dd>
        </div>
        <div>
          <dt>DreamDEX order</dt>
          <dd>{lifecycle.order?.orderId ?? "NOT EMITTED"}</dd>
        </div>
        <div>
          <dt>Fill state</dt>
          <dd>{lifecycle.order?.fillState.replaceAll("_", " ") ?? "UNKNOWN"}</dd>
        </div>
        <div>
          <dt>Filled / requested</dt>
          <dd>
            {lifecycle.order === null
              ? `0 / ${lifecycle.candidate.requestedQuantityRaw}`
              : `${lifecycle.order.filledQuantityRaw} / ${lifecycle.order.requestedQuantityRaw}`}
          </dd>
        </div>
        <div>
          <dt>Settlement</dt>
          <dd>{lifecycle.settlement.state.replaceAll("_", " ")}</dd>
        </div>
        <div>
          <dt>Redemption</dt>
          <dd>{lifecycle.redemption.state.replaceAll("_", " ")}</dd>
        </div>
        <div>
          <dt>Redeemed quantity / actual payout</dt>
          <dd>
            {lifecycle.redemption.actualPayoutRaw === null
              ? "NOT VERIFIED"
              : `${lifecycle.redemption.redeemedQuantityRaw ?? "UNKNOWN"} / ${lifecycle.redemption.actualPayoutRaw} raw tUSDC`}
          </dd>
        </div>
      </dl>
      <div className="actionRow">
        <Link className="secondaryAction" to={`/proof?experimentId=${encodeURIComponent(lifecycle.experimentId)}`}>
          Open canonical proof
        </Link>
      </div>
    </section>
  );
}
