import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

export default function MarketsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [asset, setAsset] = useState(searchParams.get("asset") ?? "BTC");
  const [interval, setInterval] = useState(searchParams.get("interval") ?? "3600");
  const plane = searchParams.get("plane") ?? "historical";
  const appliedFilters = useMemo(() => ({ plane, asset, interval }), [asset, interval, plane]);

  function applyFilters() {
    setSearchParams({ plane, asset, interval });
  }

  return (
    <div className="pageStack">
      <section className="routeHero">
        <p className="eyebrow">DreamDEX Market Explorer</p>
        <h1>Browse historical and live Event Contract markets without mixing networks.</h1>
        <p>Mainnet research is read-only. Shannon routes are for forward observation and execution proof.</p>
      </section>

      <section className="workflowGrid" aria-label="Market filters">
        <form className="controlPanel" onSubmit={(event) => {
          event.preventDefault();
          applyFilters();
        }}>
          <label>
            Plane
            <select
              value={plane}
              onChange={(event) => {
                setSearchParams({ plane: event.target.value, asset, interval });
              }}
            >
              <option value="historical">Mainnet historical</option>
              <option value="live">Shannon live</option>
            </select>
          </label>
          <label>
            Asset
            <select
              value={asset}
              onChange={(event) => {
                setAsset(event.target.value);
              }}
            >
              <option>BTC</option>
              <option>ETH</option>
            </select>
          </label>
          <label>
            Interval
            <select
              value={interval}
              onChange={(event) => {
                setInterval(event.target.value);
              }}
            >
              <option value="900">15 minutes</option>
              <option value="3600">1 hour</option>
              <option value="14400">4 hours</option>
            </select>
          </label>
          <button type="submit">Apply Filters</button>
        </form>

        <article className="routePanel" aria-label="Market explorer state">
          <span className="statusPill">Route ready</span>
          <h2>{appliedFilters.plane === "historical" ? "Mainnet historical API pending" : "Shannon live API pending"}</h2>
          <p>
            UX-010 establishes the route, filter state, accessibility, and refresh behavior. HIST-003
            will connect this view to bounded DreamDEX data. Until then, EdgeLab shows no fabricated
            market rows.
          </p>
          <dl className="factGrid">
            <div>
              <dt>Plane</dt>
              <dd>{appliedFilters.plane === "historical" ? "MAINNET_HISTORICAL" : "SHANNON_FORWARD"}</dd>
            </div>
            <div>
              <dt>Asset</dt>
              <dd>{appliedFilters.asset}</dd>
            </div>
            <div>
              <dt>Interval</dt>
              <dd>{appliedFilters.interval}s</dd>
            </div>
          </dl>
          <Link className="secondaryAction" to="/markets/sample-mainnet-market-1bb7">
            Open verified sample route
          </Link>
        </article>
      </section>
    </div>
  );
}
