import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { apiErrorMessage, fetchPublicOverview } from "../data.js";

function formatInterval(seconds: number): string {
  return seconds === 3600 ? "1 hour" : `${String(seconds / 60)} minutes`;
}

export default function HomePage() {
  const overviewQuery = useQuery({ queryKey: ["public-overview"], queryFn: fetchPublicOverview });
  const overview = overviewQuery.data?.data;
  const example = overview?.example;
  return (
    <div className="pageStack overviewPage">
      <section className="heroGrid overviewHero" aria-label="EdgeLab product overview">
        <div className="heroCopy">
          <p className="eyebrow">DreamDEX strategy evidence lab</p>
          <h1>Does your strategy improve on the market?</h1>
          <p>Compare forecasts, check executable prices, and inspect the evidence before testnet execution.</p>
          <div className="actionRow">
            <Link className="primaryAction large" to="/lab">Open Lab</Link>
            <Link className="secondaryAction" to="/lab/proven-experiment/results">View example study</Link>
          </div>
        </div>
        <article className="featuredStudy" aria-label="Featured study">
          {overviewQuery.isLoading ? <div className="stateBox">Loading published example…</div> : null}
          {overviewQuery.isError ? <div className="stateBox errorState" role="alert">{apiErrorMessage(overviewQuery.error)}</div> : null}
          {example !== undefined ? (
            <>
              <div className="sectionHeader">
                <div><span className="label">Captured on {new Date(example.assessedAt).toLocaleDateString()}</span><h2>{example.title}</h2></div>
                <span className="statusPill">Mainnet · read-only</span>
              </div>
              <p className="studyCohort">{example.asset} · {formatInterval(example.intervalSeconds)} · historical screening</p>
              <strong className="featuredVerdict">Historical screening passed</strong>
              <p>
                {example.sampleSize} forecasts were scored from {example.processedCount} processed markets. A market-relative assessment is unavailable for this artifact. Forward evidence is still required.
              </p>
              <p className="smallPrint">{example.selectionDisclosure}</p>
              <Link className="textLink" to={`/lab/${example.slug}/results`}>Open study</Link>
            </>
          ) : null}
        </article>
      </section>

      <section className="progressionStrip" aria-label="Study progression">
        {[
          ["01", "Study recorded", "Freeze the candidate and protocol."],
          ["02", "Collect observations", "Capture decisions before outcomes."],
          ["03", "Evaluate", "Compare paired forecasts and exclusions."],
          ["04", "Review testnet execution", "Review a fresh eligible candidate."]
        ].map(([index, title, detail]) => <div key={index}><span>{index}</span><strong>{title}</strong><p>{detail}</p></div>)}
      </section>

      <section className="routePanel compactPanel" aria-label="Current public campaign">
        <div className="sectionHeader"><div><span className="label">Current public campaign</span><h2>{overview?.currentCampaign?.label ?? "No current campaign published"}</h2></div><span className="statusPill">Shannon forward</span></div>
        {overview?.currentCampaign === null ? (
          <p>Forward collection remains private until a campaign is explicitly published. The dated example above remains available.</p>
        ) : overview?.currentCampaign !== undefined ? (
          <p>{overview.currentCampaign.settledCount}/{overview.currentCampaign.targetCount} settled · {overview.currentCampaign.serviceState} · last capture {overview.currentCampaign.lastCaptureAt ?? "Unavailable"}</p>
        ) : null}
        <Link className="textLink" to="/how-it-works">Read the methodology</Link>
      </section>
    </div>
  );
}
