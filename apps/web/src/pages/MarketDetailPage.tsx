import { Link, useParams } from "react-router-dom";

export default function MarketDetailPage() {
  const { marketId } = useParams();
  return (
    <div className="pageStack">
      <section className="routeHero">
        <p className="eyebrow">Market Detail</p>
        <h1>Inspect one DreamDEX market with source provenance.</h1>
        <p>Orders, fills, candles, lifecycle, and resolution remain separate evidence tabs.</p>
      </section>
      <section className="routePanel" aria-label="Market detail state">
        <span className="statusPill">Data connection pending HIST-003</span>
        <h2>Selected market route</h2>
        <p className="monoText">{marketId ?? "No market selected"}</p>
        <p>
          This route is intentionally empty until the bounded historical market detail API is wired.
          No stored book snapshot or reconstructed book is claimed.
        </p>
        <div className="actionRow">
          <Link className="primaryAction" to={`/lab?market=${encodeURIComponent(marketId ?? "")}`}>
            Use in Strategy Lab
          </Link>
          <Link className="secondaryAction" to="/markets">
            Back to Markets
          </Link>
        </div>
      </section>
    </div>
  );
}
