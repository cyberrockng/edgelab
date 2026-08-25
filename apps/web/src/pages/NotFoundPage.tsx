import { Link } from "react-router-dom";

export default function NotFoundPage() {
  return (
    <section className="routePanel" aria-label="Route not found">
      <p className="eyebrow">Route not found</p>
      <h1>This EdgeLab workflow does not exist.</h1>
      <p>Use the product navigation to return to a supported market, lab, comparison, evidence, or proof route.</p>
      <Link className="primaryAction" to="/">
        Return Home
      </Link>
    </section>
  );
}
