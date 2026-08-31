import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { apiErrorMessage, createExperiment, fetchProvenExperiments, listExperiments, type ExperimentCreateInput } from "../data.js";

const strategyOptions = [
  {
    key: "reference-neutral@1.0.0",
    policyId: "reference-neutral",
    policyVersion: "1.0.0",
    label: "Educational neutral baseline",
    description: "Watch-only 50 percent forecast baseline for Shannon live-shadow workflow validation.",
    allowedModes: ["LIVE_SHADOW"]
  },
  {
    key: "historical-last-trade@1.1.0",
    policyId: "historical-last-trade",
    policyVersion: "1.1.0",
    label: "Last-Trade Probability",
    description:
      "Historical-only strategy using DreamDEX canonical YES-term fill prices from the latest verified pre-cutoff fill.",
    allowedModes: ["HISTORICAL_REPLAY"]
  },
  {
    key: "reference-book-tilt@1.0.0",
    policyId: "reference-book-tilt",
    policyVersion: "1.0.0",
    label: "Captured-book tilt baseline",
    description: "Shannon forward-only baseline. Historical use is disabled until book reconstruction is verified.",
    allowedModes: ["LIVE_SHADOW"]
  }
] as const;

function strategyAllowsMode(
  strategy: (typeof strategyOptions)[number],
  candidateMode: ExperimentCreateInput["mode"]
): boolean {
  return (strategy.allowedModes as readonly ExperimentCreateInput["mode"][]).includes(candidateMode);
}

function intervalValue(value: string): ExperimentCreateInput["intervalSec"] {
  if (value === "900" || value === "3600") {
    return Number(value) as ExperimentCreateInput["intervalSec"];
  }
  return 3600;
}

function assetValue(value: string | null): ExperimentCreateInput["asset"] {
  return value === "ETH" ? "ETH" : "BTC";
}

function modeValue(value: string | null): ExperimentCreateInput["mode"] {
  return value === "live-shadow" ? "LIVE_SHADOW" : "HISTORICAL_REPLAY";
}

export default function LabPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const seededMarketId = searchParams.get("market");
  const initialMode = modeValue(searchParams.get("mode"));
  const [name, setName] = useState(searchParams.get("name") ?? (seededMarketId === null ? "BTC historical qualification" : "Market-selected qualification"));
  const [strategyKey, setStrategyKey] = useState<(typeof strategyOptions)[number]["key"]>(
    initialMode === "LIVE_SHADOW" ? "reference-neutral@1.0.0" : "historical-last-trade@1.1.0"
  );
  const [mode, setMode] = useState<ExperimentCreateInput["mode"]>(initialMode);
  const [asset, setAsset] = useState<ExperimentCreateInput["asset"]>(assetValue(searchParams.get("asset")));
  const [interval, setInterval] = useState(searchParams.get("interval") === "900" ? "900" : "3600");
  const [windowFrom, setWindowFrom] = useState("");
  const [windowTo, setWindowTo] = useState("");
  const [decisionOffsetSec, setDecisionOffsetSec] = useState(60);
  const selectedStrategy = strategyOptions.find((strategy) => strategy.key === strategyKey) ?? strategyOptions[0];
  const allowedModes = selectedStrategy.allowedModes as readonly ExperimentCreateInput["mode"][];
  const experimentsQuery = useQuery({
    queryKey: ["experiments"],
    queryFn: listExperiments
  });
  const provenQuery = useQuery({
    queryKey: ["proven-experiments", "lab"],
    queryFn: fetchProvenExperiments
  });
  const createMutation = useMutation({
    mutationFn: () =>
      createExperiment({
        name,
        mode,
        asset,
        intervalSec: intervalValue(interval),
        policyId: selectedStrategy.policyId,
        policyVersion: selectedStrategy.policyVersion,
        ...(seededMarketId === null ? {} : { marketId: seededMarketId }),
        ...(windowFrom.trim() === "" ? {} : { windowFrom: new Date(windowFrom).toISOString() }),
        ...(windowTo.trim() === "" ? {} : { windowTo: new Date(windowTo).toISOString() }),
        decisionOffsetSec,
        riskEnvelopeId: "WATCH_ONLY_BOUNDED"
      }),
    onSuccess: async (response) => {
      await queryClient.invalidateQueries({ queryKey: ["experiments"] });
      await navigate(`/lab/${response.data.experiment.experimentId}`);
    }
  });
  const researchSessionReady = experimentsQuery.isSuccess && typeof experimentsQuery.data.data.csrfToken === "string";
  const createDisabled = createMutation.isPending || !researchSessionReady;

  return (
    <div className="pageStack">
      <section className="routeHero">
        <p className="eyebrow">Strategy Lab</p>
        <h1>Create an evidence-backed strategy experiment.</h1>
        <p>Experiment writes are application state. They do not authorize blockchain transactions.</p>
      </section>
      <section className="workflowGrid">
        <form
          className="controlPanel"
          aria-label="Experiment draft"
          onSubmit={(event) => {
            event.preventDefault();
            if (researchSessionReady) {
              createMutation.mutate();
            }
          }}
        >
          <label>
            Experiment name
            <input
              value={name}
              maxLength={80}
              minLength={3}
              onChange={(event) => {
                setName(event.target.value);
              }}
              required
            />
          </label>
          <label>
            Strategy
            <select
              value={strategyKey}
              onChange={(event) => {
                const next = event.target.value as (typeof strategyOptions)[number]["key"];
                const nextStrategy = strategyOptions.find((strategy) => strategy.key === next) ?? strategyOptions[0];
                setStrategyKey(next);
                if (!strategyAllowsMode(nextStrategy, mode)) {
                  setMode(nextStrategy.allowedModes[0]);
                }
              }}
            >
              {strategyOptions.map((strategy) => (
                <option key={strategy.key} value={strategy.key}>
                  {strategy.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Mode
            <select
              value={mode}
              onChange={(event) => {
                setMode(event.target.value as ExperimentCreateInput["mode"]);
              }}
            >
              {allowedModes.includes("HISTORICAL_REPLAY") ? <option value="HISTORICAL_REPLAY">Historical replay</option> : null}
              {allowedModes.includes("LIVE_SHADOW") ? <option value="LIVE_SHADOW">Live shadow</option> : null}
            </select>
          </label>
          <label>
            Asset universe
            <select
              value={asset}
              onChange={(event) => {
                setAsset(event.target.value as ExperimentCreateInput["asset"]);
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
            </select>
          </label>
          {mode === "HISTORICAL_REPLAY" ? (
            <>
              <label>
                Window from
                <input
                  type="datetime-local"
                  value={windowFrom}
                  onChange={(event) => {
                    setWindowFrom(event.target.value);
                  }}
                />
              </label>
              <label>
                Window to
                <input
                  type="datetime-local"
                  value={windowTo}
                  onChange={(event) => {
                    setWindowTo(event.target.value);
                  }}
                />
              </label>
            </>
          ) : null}
          <label>
            Decision offset seconds
            <input
              type="number"
              min="60"
              max="3600"
              step="60"
              value={decisionOffsetSec}
              onChange={(event) => {
                setDecisionOffsetSec(Number(event.target.value));
              }}
            />
          </label>
          <label>
            Risk envelope
            <select value="WATCH_ONLY_BOUNDED" disabled>
              <option value="WATCH_ONLY_BOUNDED">Research only / watch only</option>
            </select>
          </label>
          <button type="submit" aria-describedby="lab-write-status" disabled={createDisabled}>
            {createMutation.isPending ? "Creating..." : researchSessionReady ? "Create Experiment" : "Preparing Session..."}
          </button>
        </form>
        <article className="routePanel" id="lab-write-status" aria-live="polite">
          <span className="statusPill">Application write</span>
          <h2>Create persistent research state without a wallet.</h2>
          <p>{selectedStrategy.description}</p>
          <dl className="factGrid">
            <div>
              <dt>Mode</dt>
              <dd>{mode}</dd>
            </div>
            <div>
              <dt>Plane</dt>
              <dd>{mode === "HISTORICAL_REPLAY" ? "MAINNET_HISTORICAL read-only" : "SHANNON_FORWARD read-only"}</dd>
            </div>
            <div>
              <dt>Risk envelope</dt>
              <dd>WATCH_ONLY_BOUNDED</dd>
            </div>
            <div>
              <dt>Decision offset</dt>
              <dd>{decisionOffsetSec}s before expiry</dd>
            </div>
            <div>
              <dt>Replay boundary</dt>
              <dd>max(trading start + 1s, expiry - offset)</dd>
            </div>
            <div>
              <dt>Blockchain write</dt>
              <dd>None</dd>
            </div>
          </dl>
          {seededMarketId !== null ? <p className="monoText">Seed market: {seededMarketId}</p> : null}
          {!researchSessionReady && !experimentsQuery.isError ? (
            <div className="stateBox" role="status">
              Preparing a wallet-free research session...
            </div>
          ) : null}
          {createMutation.isError ? (
            <div className="stateBox errorState" role="alert">
              {apiErrorMessage(createMutation.error)}
            </div>
          ) : null}
          {createMutation.isSuccess ? (
            <div className="stateBox" role="status">
              Experiment persisted. Opening workspace...
            </div>
          ) : null}
        </article>
      </section>

      <section className="routePanel" aria-label="Captured experiment library">
        <div className="sourceBar">
          <span className="statusPill">Captured real evidence</span>
          <span className="statusPill">No fabricated performance</span>
          <span className="statusPill">More runs come from new replay exports</span>
        </div>
        <h2>Captured experiment library</h2>
        <p>
          EdgeLab currently ships with the first captured real-evidence qualification. Create
          additional experiments above to grow this library without changing thresholds or inventing outcomes.
        </p>
        {provenQuery.isLoading ? <div className="stateBox">Loading captured experiments...</div> : null}
        {provenQuery.isError ? (
          <div className="stateBox errorState" role="alert">
            {apiErrorMessage(provenQuery.error)}
          </div>
        ) : null}
        {provenQuery.data?.data.provenExperiments.map((proven) => (
          <div className="experimentRow" key={proven.slug}>
            <div>
              <strong>{proven.title}</strong>
              <small>
                {proven.policy} / {proven.sourcePlane} / {proven.sampleSize} scored observations /{" "}
                {proven.verdict.replaceAll("_", " ")}
              </small>
            </div>
            <div className="actionRow">
              <Link className="secondaryAction inlineAction" to={proven.route}>
                Open
              </Link>
              <a className="secondaryAction inlineAction" href={`/api/v2/proven-experiments/${proven.slug}/report`} target="_blank" rel="noreferrer">
                Export Report
              </a>
            </div>
          </div>
        ))}
      </section>

      <section className="routePanel" aria-label="Recent experiments">
        <div className="sourceBar">
          <span className="statusPill">Research session</span>
          <span className="statusPill">Wallet not required</span>
          <span className="statusPill">{experimentsQuery.isFetching ? "Refreshing" : "Current response"}</span>
        </div>
        <h2>Recent experiments</h2>
        {experimentsQuery.isLoading ? <div className="stateBox">Loading session experiments...</div> : null}
        {experimentsQuery.isError ? (
          <div className="stateBox errorState" role="alert">
            {apiErrorMessage(experimentsQuery.error)}
          </div>
        ) : null}
        {experimentsQuery.data?.data.experiments.length === 0 ? (
          <div className="stateBox">No experiments in this research session yet.</div>
        ) : null}
        {experimentsQuery.data?.data.experiments.map((experiment) => (
          <div className="experimentRow" key={experiment.experimentId}>
            <div>
              <strong>{experiment.name}</strong>
              <small>
                {experiment.configuration.mode} / {experiment.configuration.assets.join(", ")} /{" "}
                {experiment.configuration.intervals.join(", ")}s
              </small>
            </div>
            <Link className="secondaryAction inlineAction" to={`/lab/${experiment.experimentId}`}>
              Open Workspace
            </Link>
          </div>
        ))}
      </section>
    </div>
  );
}
