import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { apiErrorMessage, createExperiment, listExperiments, type ExperimentCreateInput } from "../data.js";

const strategyOptions = [
  {
    key: "reference-neutral@1.0.0",
    policyId: "reference-neutral",
    policyVersion: "1.0.0",
    label: "Educational neutral baseline",
    description: "Watch-only 50 percent forecast baseline. Valid for historical replay and live shadow."
  },
  {
    key: "historical-last-trade@1.0.0",
    policyId: "historical-last-trade",
    policyVersion: "1.0.0",
    label: "Last-Trade Probability",
    description: "Historical-only strategy using the latest verified pre-cutoff fill; abstains when no qualifying fill exists."
  },
  {
    key: "reference-book-tilt@1.0.0",
    policyId: "reference-book-tilt",
    policyVersion: "1.0.0",
    label: "Captured-book tilt baseline",
    description: "Shannon forward-only baseline. Historical use is disabled until book reconstruction is verified."
  }
] as const;

function intervalValue(value: string): ExperimentCreateInput["intervalSec"] {
  if (value === "900" || value === "3600" || value === "14400" || value === "86400") {
    return Number(value) as ExperimentCreateInput["intervalSec"];
  }
  return 3600;
}

export default function LabPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const seededMarketId = searchParams.get("market");
  const [name, setName] = useState(seededMarketId === null ? "Judge historical replay" : "Market-selected replay");
  const [strategyKey, setStrategyKey] = useState<(typeof strategyOptions)[number]["key"]>("reference-neutral@1.0.0");
  const [mode, setMode] = useState<ExperimentCreateInput["mode"]>("HISTORICAL_REPLAY");
  const [asset, setAsset] = useState<ExperimentCreateInput["asset"]>("BTC");
  const [interval, setInterval] = useState("3600");
  const selectedStrategy = strategyOptions.find((strategy) => strategy.key === strategyKey) ?? strategyOptions[0];
  const experimentsQuery = useQuery({
    queryKey: ["experiments"],
    queryFn: listExperiments
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
        riskEnvelopeId: "WATCH_ONLY_BOUNDED"
      }),
    onSuccess: async (response) => {
      await queryClient.invalidateQueries({ queryKey: ["experiments"] });
      await navigate(`/lab/${response.data.experiment.experimentId}`);
    }
  });

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
            createMutation.mutate();
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
                setStrategyKey(next);
                if (next === "reference-book-tilt@1.0.0") {
                  setMode("LIVE_SHADOW");
                }
                if (next === "historical-last-trade@1.0.0") {
                  setMode("HISTORICAL_REPLAY");
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
              <option value="HISTORICAL_REPLAY">Historical replay</option>
              <option value="LIVE_SHADOW">Live shadow</option>
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
              <option value="14400">4 hours</option>
              <option value="86400">24 hours</option>
            </select>
          </label>
          <button type="submit" aria-describedby="lab-write-status" disabled={createMutation.isPending}>
            {createMutation.isPending ? "Creating..." : "Create Experiment"}
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
              <dt>Blockchain write</dt>
              <dd>None</dd>
            </div>
          </dl>
          {seededMarketId !== null ? <p className="monoText">Seed market: {seededMarketId}</p> : null}
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
