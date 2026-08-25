export default function HowItWorksPage() {
  return (
    <div className="pageStack">
      <section className="routeHero">
        <p className="eyebrow">Methodology</p>
        <h1>Evidence-gated promotion keeps the product honest.</h1>
        <p>
          EdgeLab qualifies strategies through historical reality, forward evidence, and execution
          reality while preserving strict network and evidence boundaries.
        </p>
      </section>
      <section className="methodGrid" aria-label="EdgeLab method">
        <article>
          <span className="label">1. Historical research</span>
          <h2>Mainnet 5031 is read-only.</h2>
          <p>Historical markets, orders, fills, candles, and resolutions can inform qualification. EdgeLab never signs mainnet trades.</p>
        </article>
        <article>
          <span className="label">2. Look-ahead protection</span>
          <h2>Future data is embargoed.</h2>
          <p>Replay decisions may only see data available at the historical decision block or timestamp.</p>
        </article>
        <article>
          <span className="label">3. Book reconstruction</span>
          <h2>Fail closed until verified.</h2>
          <p>No native stored historical book snapshots are claimed. Reconstruction remains unavailable until semantics are proven.</p>
        </article>
        <article>
          <span className="label">4. Forward observation</span>
          <h2>Shadow decisions precede outcomes.</h2>
          <p>Live-shadow evidence records decisions before outcome data exists.</p>
        </article>
        <article>
          <span className="label">5. Execution proof</span>
          <h2>Shannon writes require humans.</h2>
          <p>Consequential DreamDEX writes remain bounded and wallet-authorized by the owner.</p>
        </article>
        <article>
          <span className="label">6. Evidence Gate</span>
          <h2>The verdict is earned.</h2>
          <p>PROMOTE, HOLD, REJECT, and INSUFFICIENT EVIDENCE come from server evaluation, not local UI decoration.</p>
        </article>
      </section>
    </div>
  );
}
