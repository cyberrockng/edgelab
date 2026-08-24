import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DREAMDEX_MARKETS_SDK_VERSION, SOMNIA_SHANNON_CHAIN_ID } from "@edgelab/domain";
import "./styles.css";

function App() {
  return (
    <main className="shell">
      <section className="review">
        <p className="eyebrow">EdgeLab baseline</p>
        <h1>Forward DreamDEX evidence before bounded testnet action</h1>
        <div className="verdict" aria-label="Current evidence verdict">
          INSUFFICIENT_EVIDENCE
        </div>
        <p>
          Forecast quality, captured-book tradeability, and realized PnL are intentionally separate.
          Human wallet approval is required before any chain write.
        </p>
        <dl>
          <div>
            <dt>Chain</dt>
            <dd>Somnia Shannon {SOMNIA_SHANNON_CHAIN_ID}</dd>
          </div>
          <div>
            <dt>DreamDEX SDK</dt>
            <dd>{DREAMDEX_MARKETS_SDK_VERSION}</dd>
          </div>
          <div>
            <dt>Service signer</dt>
            <dd>Disabled by design</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Missing root element");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
