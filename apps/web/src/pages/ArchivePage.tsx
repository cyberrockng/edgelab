import { Link, useParams } from "react-router-dom";
import ObservationPage from "./ObservationPage.js";
import ProofPage from "./ProofPage.js";

export default function ArchivePage() {
  const { artifactId } = useParams();
  if (artifactId === "observe-001") return <ObservationPage />;
  if (artifactId === "exg-003") return <ProofPage />;
  return (
    <div className="pageStack">
      <section className="routeHero">
        <p className="eyebrow">Public evidence archive</p>
        <h1>Dated artifacts keep their original scope.</h1>
        <p>Archive evidence remains available without inheriting a current study’s qualification or execution status.</p>
      </section>
      <section className="routePanel" aria-label="Public evidence archive">
        <div className="experimentRow"><div><strong>OBSERVE-001</strong><small>Captured four-market forward observation protocol proof</small></div><Link className="secondaryAction inlineAction" to="/evidence/archive/observe-001">Open artifact</Link></div>
        <div className="experimentRow"><div><strong>EXG-003</strong><small>Unlinked protocol interaction · zero fills</small></div><Link className="secondaryAction inlineAction" to="/evidence/archive/exg-003">Open artifact</Link></div>
      </section>
    </div>
  );
}
