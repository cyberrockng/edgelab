export type QualificationJourneyState = "complete" | "current" | "locked" | "unproven";

export interface QualificationJourneyStage {
  readonly title: string;
  readonly status: string;
  readonly detail: string;
  readonly state: QualificationJourneyState;
}

interface QualificationJourneyProps {
  readonly stages: readonly QualificationJourneyStage[];
  readonly title?: string;
  readonly description?: string;
}

export function QualificationJourney({
  stages,
  title = "Qualification-to-receipt journey",
  description = "Each gate must be earned in order. A later market condition never upgrades an earlier evidence decision."
}: QualificationJourneyProps) {
  return (
    <section className="qualificationJourney" aria-label="Qualification to receipt journey">
      <div className="journeyHeader">
        <div>
          <span className="label">Canonical progression</span>
          <h2>{title}</h2>
        </div>
        <p>{description}</p>
      </div>
      <ol className="journeyTrack">
        {stages.map((stage, index) => (
          <li className={`journeyStep journey-${stage.state}`} key={stage.title}>
            <div className="journeyMarker" aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </div>
            <div>
              <span className="journeyStatus">{stage.status}</span>
              <strong>{stage.title}</strong>
              <p>{stage.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
