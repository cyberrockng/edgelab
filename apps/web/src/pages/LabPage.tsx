import { useState } from "react";

export default function LabPage() {
  const [strategy, setStrategy] = useState("watch-only-calibration");
  const [mode, setMode] = useState("HISTORICAL_REPLAY");
  const [asset, setAsset] = useState("BTC");
  return (
    <div className="pageStack">
      <section className="routeHero">
        <p className="eyebrow">Strategy Lab</p>
        <h1>Create an evidence-backed strategy experiment.</h1>
        <p>Experiment writes are application state. They do not authorize blockchain transactions.</p>
      </section>
      <section className="workflowGrid">
        <form className="controlPanel" aria-label="Experiment draft">
          <label>
            Strategy
            <select
              value={strategy}
              onChange={(event) => {
                setStrategy(event.target.value);
              }}
            >
              <option value="watch-only-calibration">Watch-only calibration</option>
              <option value="neutral-abstain">Neutral abstain baseline</option>
            </select>
          </label>
          <label>
            Mode
            <select
              value={mode}
              onChange={(event) => {
                setMode(event.target.value);
              }}
            >
              <option value="HISTORICAL_REPLAY">Historical replay</option>
              <option value="LIVE_SHADOW">Live shadow</option>
            </select>
          </label>
          <label>
            Asset universe
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
          <button type="button" aria-describedby="lab-write-status">
            Prepare Draft
          </button>
        </form>
        <article className="routePanel" id="lab-write-status" aria-live="polite">
          <span className="statusPill">Application write API pending EXP-002</span>
          <h2>Draft ready for session-backed creation.</h2>
          <p>{`Selected ${strategy} on ${asset} with ${mode}. DB-002 has the schema for this write; EXP-002 will connect this form to persistent API state.`}</p>
        </article>
      </section>
    </div>
  );
}
