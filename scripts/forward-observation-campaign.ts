import { chmod, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PositiveIntSchema = z.coerce.number().int().positive();
const CampaignConfigSchema = z.object({
  baseUrl: z.url(),
  targetDecisions: PositiveIntSchema,
  intervalMs: PositiveIntSchema,
  maxCycles: PositiveIntSchema,
  durationMinutes: z.coerce.number().positive().optional(),
  assets: z.array(z.enum(["BTC", "ETH"])).min(1),
  intervals: z.array(z.union([z.literal(900), z.literal(3600)])).min(1),
  policyId: z.string().min(1),
  policyVersion: z.string().min(1),
  statePath: z.string().min(1)
});
const SessionResponseSchema = z.object({
  data: z.object({
    csrfToken: z.string().min(1)
  })
});
const ExperimentResponseSchema = z.object({
  data: z.object({
    experiment: z.object({
      experimentId: z.string().uuid(),
      configuration: z.object({
        mode: z.literal("LIVE_SHADOW")
      }),
      policies: z.array(
        z.object({
          policyId: z.string(),
          version: z.string()
        })
      )
    })
  })
});
const ObserveResponseSchema = z.object({
  data: z.object({
    observation: z.object({
      leaseAcquired: z.boolean(),
      discoveredMarketCount: z.number().int().nonnegative(),
      discoveryIssue: z
        .object({
          reasonCode: z.string().min(1),
          message: z.string().min(1)
        })
        .optional(),
      observed: z.array(
        z.object({
          insertedDecisionCount: z.number().int().nonnegative(),
          reusedDecisionCount: z.number().int().nonnegative(),
          skipped: z.boolean(),
          reasonCode: z.string().optional()
        })
      )
    }),
    liveShadow: z.object({
      decisionCount: z.number().int().nonnegative(),
      eligibleDecisionCount: z.number().int().nonnegative(),
      abstentionCount: z.number().int().nonnegative(),
      pendingOutcomeCount: z.number().int().nonnegative(),
      timingExcludedDecisionCount: z.number().int().nonnegative(),
      excludedEpisodeCount: z.number().int().nonnegative(),
      latestMarketId: z.string().nullable()
    })
  })
});
const ReconcileResponseSchema = z.object({
  data: z.object({
    liveShadow: ObserveResponseSchema.shape.data.shape.liveShadow
  })
});
const EvaluationResponseSchema = z.object({
  data: z.object({
    assessment: z.object({
      assessmentId: z.string().uuid(),
      verdict: z.enum(["STRATEGY_QUALIFIED", "REJECT", "HOLD", "INSUFFICIENT_EVIDENCE"]),
      sampleSize: z.number().int().nonnegative(),
      reasonCodes: z.array(z.string())
    })
  })
});

type CampaignConfig = z.infer<typeof CampaignConfigSchema>;
type ObserveResponse = z.infer<typeof ObserveResponseSchema>;
type CampaignTarget = {
  readonly asset: "BTC" | "ETH";
  readonly intervalSec: 900 | 3600;
};
type CampaignExperiment = CampaignTarget & {
  readonly experimentId: string;
};
const CampaignStateSchema = z.object({
  version: z.literal(1),
  baseUrl: z.url(),
  policyId: z.string(),
  policyVersion: z.string(),
  cookie: z.string().min(1),
  csrfToken: z.string().min(1),
  experiments: z.array(z.object({
    asset: z.enum(["BTC", "ETH"]),
    intervalSec: z.union([z.literal(900), z.literal(3600)]),
    experimentId: z.string().uuid()
  })),
  retiredExperiments: z.array(z.object({
    asset: z.enum(["BTC", "ETH"]),
    intervalSec: z.union([z.literal(900), z.literal(3600)]),
    experimentId: z.string().uuid()
  })).optional()
});
type CampaignState = z.infer<typeof CampaignStateSchema>;

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function parseAssets(value: string | undefined): CampaignConfig["assets"] {
  const raw = value ?? argValue("asset") ?? "BTC,ETH";
  return z
    .array(z.enum(["BTC", "ETH"]))
    .min(1)
    .parse(
      raw
        .split(",")
        .map((item) => item.trim().toUpperCase())
        .filter((item) => item.length > 0)
    );
}

function parseIntervals(value: string | undefined): CampaignConfig["intervals"] {
  const raw = value ?? argValue("interval-sec") ?? "900,3600";
  return z
    .array(z.coerce.number().pipe(z.union([z.literal(900), z.literal(3600)])))
    .min(1)
    .parse(
      raw
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    );
}

function parseConfig(): CampaignConfig {
  return CampaignConfigSchema.parse({
    baseUrl: argValue("base-url") ?? "http://127.0.0.1:3000",
    targetDecisions: argValue("target-decisions") ?? "30",
    intervalMs: argValue("interval-ms") ?? "30000",
    maxCycles: argValue("max-cycles") ?? "12000",
    durationMinutes: argValue("duration-minutes"),
    assets: parseAssets(argValue("assets")),
    intervals: parseIntervals(argValue("intervals")),
    policyId: argValue("policy-id") ?? "last-trade-forward-proxy",
    policyVersion: argValue("policy-version") ?? "1.0.0",
    statePath: resolve(repoRoot, argValue("state-path") ?? "forward-observation-campaign.local")
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

class ApiClient {
  private cookie: string;

  constructor(private readonly config: CampaignConfig, cookie = "") {
    this.cookie = cookie;
  }

  currentCookie(): string {
    return this.cookie;
  }

  async resumeSession(csrfToken: string): Promise<void> {
    const encodedCookieValue = this.cookie.split("=", 2)[1];
    const rawCookieValue = encodedCookieValue === undefined ? "" : decodeURIComponent(encodedCookieValue);
    const rawSessionToken = rawCookieValue.split(".", 1)[0] ?? "";
    if (!/^[a-f0-9]{64}$/.test(rawSessionToken)) {
      throw new Error("Campaign state does not contain a valid opaque session resume token");
    }
    await this.request("/api/v2/research-session/resume", {
      method: "POST",
      headers: {
        authorization: `Bearer ${rawSessionToken}`,
        "x-csrf-token": csrfToken
      }
    });
  }

  async authenticatedRequest(path: string, csrfToken: string, init: RequestInit = {}): Promise<unknown> {
    try {
      return await this.request(path, init);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!message.includes("RESEARCH_SESSION_REQUIRED") && !message.includes("RESEARCH_SESSION_EXPIRED")) {
        throw error;
      }
      await this.resumeSession(csrfToken);
      return await this.request(path, init);
    }
  }

  async request(path: string, init: RequestInit = {}): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const headers = new Headers(init.headers);
        headers.set("accept", "application/json");
        if (this.cookie !== "") {
          headers.set("cookie", this.cookie);
        }
        const response = await fetch(`${this.config.baseUrl}${path}`, {
          ...init,
          headers
        });
        const setCookie = response.headers.get("set-cookie");
        if (setCookie !== null) {
          this.cookie = setCookie.split(";")[0] ?? this.cookie;
        }
        const body: unknown = await response.json();
        if (response.ok) {
          return body;
        }
        lastError = new Error(`${String(response.status)} ${JSON.stringify(body)}`);
        if (response.status < 500 && response.status !== 429) {
          throw lastError;
        }
      } catch (error) {
        lastError = error;
        const status = error instanceof Error ? Number(error.message.slice(0, 3)) : Number.NaN;
        if (Number.isFinite(status) && status < 500 && status !== 429) {
          throw error;
        }
      }
      if (attempt < 3) {
        await sleep(attempt * 1_000);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Campaign API request failed after bounded retries");
  }
}

async function loadCampaignState(config: CampaignConfig): Promise<CampaignState | null> {
  try {
    const parsed = CampaignStateSchema.parse(JSON.parse(await readFile(config.statePath, "utf8")));
    const expectedTargets = campaignTargets(config).map((target) => `${target.asset}:${String(target.intervalSec)}`).sort();
    const storedTargets = parsed.experiments.map((target) => `${target.asset}:${String(target.intervalSec)}`).sort();
    if (
      parsed.baseUrl !== config.baseUrl ||
      parsed.policyId !== config.policyId ||
      parsed.policyVersion !== config.policyVersion ||
      storedTargets.some((target) => !expectedTargets.includes(target))
    ) {
      throw new Error("Campaign state does not match the requested URL, policy, assets, and intervals");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function saveCampaignState(config: CampaignConfig, state: CampaignState): Promise<void> {
  await writeFile(config.statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(config.statePath, 0o600);
}

function summarize(observed: ObserveResponse) {
  return {
    discovered: observed.data.observation.discoveredMarketCount,
    inserted: observed.data.observation.observed.reduce(
      (sum, item) => sum + item.insertedDecisionCount,
      0
    ),
    reused: observed.data.observation.observed.reduce(
      (sum, item) => sum + item.reusedDecisionCount,
      0
    ),
    skipped: observed.data.observation.observed.filter((item) => item.skipped).length,
    skipReasons: observed.data.observation.observed
      .filter((item) => item.skipped)
      .map((item) => item.reasonCode ?? "UNSPECIFIED"),
    totalDecisions: observed.data.liveShadow.decisionCount,
    eligibleDecisions: observed.data.liveShadow.eligibleDecisionCount,
    abstentions: observed.data.liveShadow.abstentionCount,
    pendingOutcomes: observed.data.liveShadow.pendingOutcomeCount,
    timingExcludedDecisions: observed.data.liveShadow.timingExcludedDecisionCount,
    excludedEpisodes: observed.data.liveShadow.excludedEpisodeCount,
    latestMarketId: observed.data.liveShadow.latestMarketId
  };
}

function campaignTargets(config: CampaignConfig): CampaignTarget[] {
  return config.assets.flatMap((asset) =>
    config.intervals.map((intervalSec) => ({
      asset,
      intervalSec
    }))
  );
}

async function createCampaignExperiment(
  client: ApiClient,
  csrfToken: string,
  config: CampaignConfig,
  target: CampaignTarget
): Promise<CampaignExperiment> {
  const created = ExperimentResponseSchema.parse(
    await client.request("/api/v2/experiments", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrfToken,
        "idempotency-key": `forward-campaign-${target.asset}-${String(target.intervalSec)}-${crypto.randomUUID()}`
      },
      body: JSON.stringify({
        name: `${target.asset} ${String(target.intervalSec)} strategy-linked forward observation campaign`,
        mode: "LIVE_SHADOW",
        asset: target.asset,
        intervalSec: target.intervalSec,
        policyId: config.policyId,
        policyVersion: config.policyVersion,
        decisionOffsetSec: 60,
        riskEnvelopeId: "WATCH_ONLY_BOUNDED"
      })
    })
  );
  return {
    asset: target.asset,
    intervalSec: target.intervalSec,
    experimentId: created.data.experiment.experimentId
  };
}

async function main(): Promise<void> {
  const config = parseConfig();
  const storedState = await loadCampaignState(config);
  const client = new ApiClient(config, storedState?.cookie ?? "");
  const targets = campaignTargets(config);
  let recoveredExpiredSession = false;
  let state: CampaignState;
  if (storedState === null) {
    const session = SessionResponseSchema.parse(await client.request("/api/v2/research-session", { method: "POST" }));
    state = {
      version: 1,
      baseUrl: config.baseUrl,
      policyId: config.policyId,
      policyVersion: config.policyVersion,
      cookie: client.currentCookie(),
      csrfToken: session.data.csrfToken,
      experiments: [],
      retiredExperiments: []
    };
    await saveCampaignState(config, state);
  } else {
    state = storedState;
    try {
      await client.resumeSession(state.csrfToken);
      state = { ...state, cookie: client.currentCookie() };
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("RESEARCH_SESSION_EXPIRED")) {
        throw error;
      }
      const session = SessionResponseSchema.parse(await client.request("/api/v2/research-session", { method: "POST" }));
      state = {
        ...state,
        cookie: client.currentCookie(),
        csrfToken: session.data.csrfToken,
        experiments: [],
        retiredExperiments: [...(state.retiredExperiments ?? []), ...state.experiments]
      };
      recoveredExpiredSession = true;
    }
    await saveCampaignState(config, state);
  }
  const experiments: CampaignExperiment[] = [...state.experiments];
  for (const target of targets) {
    if (experiments.some((experiment) => experiment.asset === target.asset && experiment.intervalSec === target.intervalSec)) {
      continue;
    }
    experiments.push(await createCampaignExperiment(client, state.csrfToken, config, target));
    state = { ...state, cookie: client.currentCookie(), experiments: [...experiments] };
    await saveCampaignState(config, state);
  }
  const csrfToken = state.csrfToken;
  let totalDecisions = 0;
  const decisionsByExperiment = new Map<string, number>();
  const evaluatedCountByExperiment = new Map<string, number>();
  let cycle = 0;
  const startedAtMs = Date.now();
  const deadlineMs =
    config.durationMinutes === undefined
      ? null
      : startedAtMs + Math.round(config.durationMinutes * 60_000);
  console.log(JSON.stringify({
    event: "campaign_started",
    experiments,
    policy: `${config.policyId}@${config.policyVersion}`,
    sourcePlane: "SHANNON_FORWARD",
    assets: config.assets,
    intervals: config.intervals,
    targetDecisionsPerTrack: config.targetDecisions,
    maxCycles: config.maxCycles,
    durationMinutes: config.durationMinutes ?? null,
    collectionModel: "one durable decision per eligible market generation per asset/interval experiment",
    resumed: storedState !== null,
    recoveredExpiredSession,
    retiredExperimentCount: state.retiredExperiments?.length ?? 0,
    statePath: config.statePath,
    blockchainWrite: false,
    walletRequired: false
  }));

  while (
    experiments.some((experiment) => (decisionsByExperiment.get(experiment.experimentId) ?? 0) < config.targetDecisions) &&
    cycle < config.maxCycles &&
    (deadlineMs === null || Date.now() < deadlineMs)
  ) {
    cycle += 1;
    const cycleResults: Record<string, unknown>[] = [];
    totalDecisions = 0;
    for (const experiment of experiments) {
      try {
        const observed = ObserveResponseSchema.parse(
          await client.authenticatedRequest(`/api/v2/experiments/${experiment.experimentId}/live-shadow/observe`, csrfToken, {
            method: "POST",
            headers: {
              "x-csrf-token": csrfToken,
              "idempotency-key": `forward-observe-${experiment.asset}-${String(experiment.intervalSec)}-${crypto.randomUUID()}`
            }
          })
        );
        let reconciliationError: string | null = null;
        let reconciledLiveShadow: z.infer<typeof ObserveResponseSchema>["data"]["liveShadow"] | null = null;
        try {
          reconciledLiveShadow = ReconcileResponseSchema.parse(
            await client.authenticatedRequest(`/api/v2/experiments/${experiment.experimentId}/live-shadow/reconcile`, csrfToken, {
              method: "POST",
              headers: {
                "x-csrf-token": csrfToken,
                "idempotency-key": `forward-reconcile-${experiment.asset}-${String(experiment.intervalSec)}-${crypto.randomUUID()}`
              }
            })
          ).data.liveShadow;
        } catch (error) {
          reconciliationError = error instanceof Error ? error.message : "Settlement reconciliation failed";
        }
        const summary = summarize({
          ...observed,
          data: {
            ...observed.data,
            liveShadow: reconciledLiveShadow ?? observed.data.liveShadow
          }
        });
        totalDecisions += summary.totalDecisions;
        decisionsByExperiment.set(experiment.experimentId, summary.eligibleDecisions);
        const discoveryIssue = observed.data.observation.discoveryIssue;
        const observationStatus =
          discoveryIssue?.reasonCode === "DREAMDEX_NO_ELIGIBLE_MARKET"
            ? "NO_ELIGIBLE_MARKET"
            : discoveryIssue !== undefined
              ? "DATA_ERROR"
              : observed.data.observation.leaseAcquired
                ? "OBSERVED"
                : "LEASE_NOT_ACQUIRED";
        cycleResults.push({
          experimentId: experiment.experimentId,
          asset: experiment.asset,
          intervalSec: experiment.intervalSec,
          status: observationStatus,
          discoveryIssue: discoveryIssue ?? null,
          reconciliationError,
          ...summary
        });
      } catch (error) {
        cycleResults.push({
          experimentId: experiment.experimentId,
          asset: experiment.asset,
          intervalSec: experiment.intervalSec,
          status: "DATA_ERROR",
          error: error instanceof Error ? error.message : "Forward observation failed",
          eligibleDecisions: decisionsByExperiment.get(experiment.experimentId) ?? 0
        });
      }
    }
    const trackEvaluations: Record<string, unknown>[] = [];
    for (const experiment of experiments) {
      const eligibleDecisions = decisionsByExperiment.get(experiment.experimentId) ?? 0;
      if (
        eligibleDecisions < config.targetDecisions ||
        evaluatedCountByExperiment.get(experiment.experimentId) === eligibleDecisions
      ) {
        continue;
      }
      try {
        const evaluated = EvaluationResponseSchema.parse(
          await client.authenticatedRequest(`/api/v2/experiments/${experiment.experimentId}/evaluate`, csrfToken, {
            method: "POST",
            headers: {
              "x-csrf-token": csrfToken,
              "idempotency-key": `forward-evaluate-${experiment.asset}-${String(experiment.intervalSec)}-${crypto.randomUUID()}`
            }
          })
        );
        evaluatedCountByExperiment.set(experiment.experimentId, eligibleDecisions);
        trackEvaluations.push({
          experimentId: experiment.experimentId,
          asset: experiment.asset,
          intervalSec: experiment.intervalSec,
          eligibleDecisions,
          ...evaluated.data.assessment
        });
      } catch (error) {
        trackEvaluations.push({
          experimentId: experiment.experimentId,
          asset: experiment.asset,
          intervalSec: experiment.intervalSec,
          eligibleDecisions,
          error: error instanceof Error ? error.message : "Forward evaluation failed"
        });
      }
    }
    state = { ...state, cookie: client.currentCookie() };
    await saveCampaignState(config, state);
    console.log(JSON.stringify({
      event: "observation_cycle",
      cycle,
      totalDecisions,
      thresholdReadyTrackCount: experiments.filter(
        (experiment) => (decisionsByExperiment.get(experiment.experimentId) ?? 0) >= config.targetDecisions
      ).length,
      elapsedSeconds: Math.round((Date.now() - startedAtMs) / 1000),
      remainingSeconds: deadlineMs === null ? null : Math.max(0, Math.round((deadlineMs - Date.now()) / 1000)),
      targets: cycleResults,
      evaluations: trackEvaluations
    }));
    if (experiments.every(
      (experiment) => (decisionsByExperiment.get(experiment.experimentId) ?? 0) >= config.targetDecisions
    )) {
      break;
    }
    await sleep(config.intervalMs);
  }

  const complete = experiments.every(
    (experiment) => (decisionsByExperiment.get(experiment.experimentId) ?? 0) >= config.targetDecisions
  );
  const evaluations = complete
    ? await Promise.all(
        experiments.map(async (experiment) => ({
          experimentId: experiment.experimentId,
          asset: experiment.asset,
          intervalSec: experiment.intervalSec,
          response: await client.authenticatedRequest(`/api/v2/experiments/${experiment.experimentId}/evaluate`, csrfToken, {
            method: "POST",
            headers: {
              "x-csrf-token": csrfToken,
              "idempotency-key": `forward-evaluate-${experiment.asset}-${String(experiment.intervalSec)}-${crypto.randomUUID()}`
            }
          })
        }))
      )
    : [];
  console.log(JSON.stringify({
    event: complete ? "campaign_complete" : "campaign_incomplete",
    experiments,
    totalDecisions,
    targetDecisionsPerTrack: config.targetDecisions,
    decisionsByExperiment: Object.fromEntries(decisionsByExperiment),
    evaluations,
    cycles: cycle,
    maxCycles: config.maxCycles,
    elapsedSeconds: Math.round((Date.now() - startedAtMs) / 1000),
    stoppedBy:
      complete
        ? "targetDecisions"
        : cycle >= config.maxCycles
          ? "maxCycles"
          : deadlineMs !== null && Date.now() >= deadlineMs
            ? "durationMinutes"
            : "unknown",
    nextStep: complete
      ? "review each deterministic forward assessment, then request a fresh bounded execution candidate only for STRATEGY_QUALIFIED tracks"
      : "keep the campaign running over real DreamDEX market rotations; increasing cycle count is valid, duplicating one market is not"
  }));
}

await main();
