import { minimumSample, policyRows } from "../data.js";

export default function ComparePage() {
  return (
    <div className="pageStack">
      <section className="routeHero">
        <p className="eyebrow">Strategy Comparison</p>
        <h1>Compare evidence dimensions, not vanity scores.</h1>
        <p>Forecast quality, tradeability, risk, settlement evidence, and PnL remain visibly separate.</p>
      </section>
      <section className="routePanel" aria-label="Strategy comparison">
        <div className="policyMatrix" role="table" aria-label="Policy evidence comparison">
          <div role="row">
            <span role="columnheader">Policy</span>
            <span role="columnheader">Version</span>
            <span role="columnheader">Action</span>
            <span role="columnheader">Observations</span>
            <span role="columnheader">Calibration</span>
            <span role="columnheader">Tradeability</span>
            <span role="columnheader">PnL</span>
            <span role="columnheader">Promotion</span>
          </div>
          {policyRows.map((row) => (
            <div role="row" key={row.version}>
              <span role="cell" data-label="Policy">{row.name}</span>
              <span role="cell" data-label="Version">{row.version}</span>
              <span role="cell" data-label="Action">{row.action}</span>
              <span role="cell" data-label="Observations">{row.observations}/{minimumSample}</span>
              <span role="cell" data-label="Calibration">{row.calibration}</span>
              <span role="cell" data-label="Tradeability">{row.tradeability}</span>
              <span role="cell" data-label="PnL">{row.pnl}</span>
              <span role="cell" data-label="Promotion" className="mutedCell">{row.promotion}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
