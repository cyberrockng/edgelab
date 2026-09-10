import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  apiErrorMessage, createExperiment, fetchPolicyCatalog, fetchProvenExperiments,
  listExperiments, type ExperimentCreateInput
} from "../data.js";

function intervalValue(value: string): ExperimentCreateInput["intervalSec"] {
  return value === "900" ? 900 : 3600;
}

function localDateTime(date: Date): string {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

export default function LabPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const seededMarketId = searchParams.get("market");
  const initialMode: ExperimentCreateInput["mode"] = searchParams.get("mode") === "live-shadow" ? "LIVE_SHADOW" : "HISTORICAL_REPLAY";
  const [createOpen, setCreateOpen] = useState(searchParams.get("create") === "1" || searchParams.has("mode") || seededMarketId !== null);
  const [name, setName] = useState(searchParams.get("name") ?? "New strategy study");
  const [mode, setMode] = useState<ExperimentCreateInput["mode"]>(initialMode);
  const [asset, setAsset] = useState<ExperimentCreateInput["asset"]>(searchParams.get("asset") === "ETH" ? "ETH" : "BTC");
  const [interval, setInterval] = useState(searchParams.get("interval") === "900" ? "900" : "3600");
  const initialForwardStart = useMemo(() => new Date(), []);
  const [windowFrom, setWindowFrom] = useState(initialMode === "LIVE_SHADOW" ? localDateTime(initialForwardStart) : "");
  const [windowTo, setWindowTo] = useState(initialMode === "LIVE_SHADOW" ? localDateTime(new Date(initialForwardStart.getTime() + 28 * 86_400_000)) : "");
  const [decisionOffsetSec, setDecisionOffsetSec] = useState(60);

  const experimentsQuery = useQuery({ queryKey: ["experiments"], queryFn: listExperiments });
  const provenQuery = useQuery({ queryKey: ["proven-experiments", "lab"], queryFn: fetchProvenExperiments });
  const policiesQuery = useQuery({ queryKey: ["policy-catalog"], queryFn: fetchPolicyCatalog });
  const supportedPolicies = useMemo(() => (policiesQuery.data?.data.policies ?? []).filter((policy) =>
    policy.supportedPlanes.includes(mode === "HISTORICAL_REPLAY" ? "MAINNET_HISTORICAL" : "SHANNON_FORWARD")
  ), [mode, policiesQuery.data]);
  const preferredKey = mode === "LIVE_SHADOW" ? "last-trade-forward-proxy@1.1.0" : "historical-last-trade@1.1.0";
  const [strategyKey, setStrategyKey] = useState(preferredKey);
  const selectedStrategy = supportedPolicies.find((policy) => `${policy.policyId}@${policy.version}` === strategyKey) ?? supportedPolicies[0];

  const createMutation = useMutation({
    mutationFn: () => {
      if (selectedStrategy === undefined) throw new Error("No server-supported policy is available for this mode.");
      return createExperiment({
        name, mode, asset, intervalSec: intervalValue(interval),
        policyId: selectedStrategy.policyId, policyVersion: selectedStrategy.version,
        ...(seededMarketId === null ? {} : { marketId: seededMarketId }),
        ...(windowFrom === "" ? {} : { windowFrom: new Date(windowFrom).toISOString() }),
        ...(windowTo === "" ? {} : { windowTo: new Date(windowTo).toISOString() }),
        decisionOffsetSec, riskEnvelopeId: "WATCH_ONLY_BOUNDED"
      });
    },
    onSuccess: async (response) => {
      await queryClient.invalidateQueries({ queryKey: ["experiments"] });
      await navigate(`/lab/${response.data.experiment.experimentId}/results`);
    }
  });
  const sessionReady = experimentsQuery.isSuccess && typeof experimentsQuery.data.data.csrfToken === "string";
  const dateOrderInvalid = windowFrom !== "" && windowTo !== "" && new Date(windowFrom) >= new Date(windowTo);

  return (
    <div className="pageStack">
      <section className="routeHero labHero">
        <div><p className="eyebrow">Lab</p><h1>Studies and assessments</h1><p>Review persisted evidence or register a versioned study. Creating a study does not submit a trade.</p></div>
        <button type="button" onClick={() => { setCreateOpen((value) => !value); }}>{createOpen ? "Close creation panel" : "New experiment"}</button>
      </section>
      {searchParams.get("notice") === "choose-experiment" ? <div className="stateBox" role="status">Choose a strategy before reviewing testnet execution.</div> : null}

      <section className="routePanel" aria-label="Recent experiments">
        <div className="sectionHeader"><div><span className="label">Research session</span><h2>Your experiments</h2></div><Link className="secondaryAction" to="/lab/compare">Compare selected</Link></div>
        {experimentsQuery.isLoading ? <div className="stateBox">Loading session experiments…</div> : null}
        {experimentsQuery.isError ? <div className="stateBox errorState" role="alert">{apiErrorMessage(experimentsQuery.error)}</div> : null}
        {experimentsQuery.data?.data.experiments.length === 0 ? <div className="stateBox">No experiments in this research session. <button type="button" className="textButton" onClick={() => { setCreateOpen(true); }}>Create an experiment</button> or <Link to="/lab/proven-experiment/results">open the public example</Link>.</div> : null}
        {experimentsQuery.data?.data.experiments.map((experiment) => (
          <div className="experimentRow" key={experiment.experimentId}>
            <div><strong>{experiment.name}</strong><small>{experiment.policies[0]?.label ?? "Candidate unavailable"} · {experiment.configuration.assets.join(", ")} · {experiment.configuration.intervals.join(", ")}s · {experiment.configuration.mode}</small><small>Updated {new Date(experiment.updatedAt).toLocaleString()}</small></div>
            <Link className="secondaryAction inlineAction" to={`/lab/${experiment.experimentId}/results`}>Open study</Link>
          </div>
        ))}
      </section>

      <section className="routePanel" aria-label="Public examples">
        <div className="sectionHeader"><div><span className="label">Public examples</span><h2>Dated, reproducible studies</h2></div><span className="statusPill">Mainnet · read-only</span></div>
        {provenQuery.isLoading ? <div className="stateBox">Loading public examples…</div> : null}
        {provenQuery.isError ? <div className="stateBox errorState" role="alert">{apiErrorMessage(provenQuery.error)}</div> : null}
        {provenQuery.data?.data.provenExperiments.map((proven) => <div className="experimentRow" key={proven.slug}><div><strong>{proven.title}</strong><small>{proven.policy} · {proven.sampleSize} scored · {proven.verdict.replaceAll("_", " ")}</small></div><Link className="secondaryAction inlineAction" to={`/lab/${proven.slug}/results`}>Open study</Link></div>)}
      </section>

      {createOpen ? <section className="routePanel" aria-label="New experiment">
        <div className="sectionHeader"><div><span className="label">New experiment</span><h2>Register an immutable configuration</h2></div><span className="statusPill">Application write only</span></div>
        <form className="studyForm" aria-label="Experiment draft" onSubmit={(event) => { event.preventDefault(); if (sessionReady && !dateOrderInvalid) createMutation.mutate(); }}>
          <fieldset><legend>1. Candidate and mode</legend>
            <label>Experiment name<input value={name} minLength={3} maxLength={80} required onChange={(event) => { setName(event.target.value); }} /></label>
            <label>Mode<select value={mode} onChange={(event) => { const next = event.target.value as ExperimentCreateInput["mode"]; setMode(next); setStrategyKey(next === "LIVE_SHADOW" ? "last-trade-forward-proxy@1.1.0" : "historical-last-trade@1.1.0"); if (next === "LIVE_SHADOW" && (windowFrom === "" || windowTo === "")) { const start = new Date(); setWindowFrom(localDateTime(start)); setWindowTo(localDateTime(new Date(start.getTime() + 28 * 86_400_000))); } }}><option value="HISTORICAL_REPLAY">Historical replay</option><option value="LIVE_SHADOW">Forward observation</option></select></label>
            <label>Candidate strategy<select value={selectedStrategy === undefined ? "" : `${selectedStrategy.policyId}@${selectedStrategy.version}`} disabled={policiesQuery.isLoading} onChange={(event) => { setStrategyKey(event.target.value); }}>{supportedPolicies.map((policy) => <option key={`${policy.policyId}@${policy.version}`} value={`${policy.policyId}@${policy.version}`}>{policy.label} · {policy.version}</option>)}</select></label>
            <p>{selectedStrategy?.description ?? "Loading server policy catalog…"}</p>
          </fieldset>
          <fieldset><legend>2. Cohort and observation protocol</legend>
            <label>Asset<select value={asset} onChange={(event) => { setAsset(event.target.value as ExperimentCreateInput["asset"]); }}><option>BTC</option><option>ETH</option></select></label>
            <label>Interval<select value={interval} onChange={(event) => { setInterval(event.target.value); }}><option value="900">15 minutes</option><option value="3600">1 hour</option></select></label>
            <label>Decision offset seconds<input type="number" min="60" max="3600" step="60" value={decisionOffsetSec} onChange={(event) => { setDecisionOffsetSec(Number(event.target.value)); }} /></label>
            <label>{mode === "LIVE_SHADOW" ? "Forward start" : "Window from"} (local time)<input type="datetime-local" required={mode === "LIVE_SHADOW"} value={windowFrom} onChange={(event) => { setWindowFrom(event.target.value); }} /></label>
            <label>{mode === "LIVE_SHADOW" ? "Fixed forward end" : "Window to"} (local time)<input type="datetime-local" required={mode === "LIVE_SHADOW"} value={windowTo} onChange={(event) => { setWindowTo(event.target.value); }} /></label>
            {mode === "LIVE_SHADOW" ? <p>Evaluation v4 captures in the exact five seconds before the decision deadline. Candidate and two-sided market midpoint must arrive before that deadline; missed windows remain exclusions.</p> : <p>Legacy historical protocols retain their configured decision-offset reconstruction.</p>}
            {dateOrderInvalid ? <p className="inlineError" role="alert">The end must be later than the start.</p> : null}
          </fieldset>
          <fieldset><legend>3. Review and create</legend><p>{asset} · {intervalValue(interval) / 60} minute · {mode.replaceAll("_", " ")} · decision offset {decisionOffsetSec}s. Configuration freezes when collection starts.</p><button type="submit" disabled={!sessionReady || policiesQuery.isError || selectedStrategy === undefined || dateOrderInvalid || createMutation.isPending}>{createMutation.isPending ? "Creating…" : "Create experiment"}</button></fieldset>
        </form>
        {policiesQuery.isError ? <div className="stateBox errorState" role="alert">{apiErrorMessage(policiesQuery.error)}</div> : null}
        {createMutation.isError ? <div className="stateBox errorState" role="alert">{apiErrorMessage(createMutation.error)}</div> : null}
      </section> : null}
    </div>
  );
}
