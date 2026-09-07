import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const proofWalletAddress = "0x6b3a87a4bbf7d7d324df227d640fc42ebf987971";
const defaultBaseUrl = process.env.PUBLIC_APP_URL ?? "http://127.0.0.1:3000";
const defaultAssets = ["BTC", "ETH"] as const;
const defaultIntervals = [900, 3600] as const;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requestTimeoutMs = 10_000;

const CandidateSchema = z.object({
  status: z.enum(["READY", "BLOCKED"]),
  intentHash: z.string(),
  account: z.string(),
  market: z.object({
    stableMarketId: z.string(),
    marketAddress: z.string(),
    poolAddress: z.string(),
    asset: z.string(),
    intervalSeconds: z.number().nullable(),
    expirySeconds: z.number()
  }),
  strategyLink: z.object({
    decision: z.object({
      forecastPUp: z.number(),
      action: z.string(),
      reasonCodes: z.array(z.string())
    })
  }),
  risk: z.object({
    maxEscrowRaw: z.string(),
    expiryHeadroomSeconds: z.number()
  }),
  sizing: z.object({
    side: z.string(),
    priceRaw: z.string().nullable(),
    availableQuantityRaw: z.string().nullable(),
    quantityRaw: z.string(),
    minQuantityRaw: z.string()
  }),
  unsignedTransactions: z.unknown().nullable(),
  blockedReasons: z.array(z.string())
});

const CandidateEnvelopeSchema = z.object({
  data: z.object({
    executionCandidate: CandidateSchema
  })
});

const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean().optional()
  })
});

type Asset = (typeof defaultAssets)[number];
type IntervalSec = (typeof defaultIntervals)[number];
type Candidate = z.infer<typeof CandidateSchema>;

interface WatchConfig {
  readonly baseUrl: string;
  readonly account: string;
  readonly assets: readonly Asset[];
  readonly intervals: readonly IntervalSec[];
  readonly cycles: number;
  readonly intervalMs: number;
  readonly outputPath: string;
  readonly statePath: string;
}

interface WatchRuntime extends WatchConfig {
  readonly cookie: string;
  readonly experimentByTrack: ReadonlyMap<string, string>;
}

const CampaignStateSchema = z.object({
  cookie: z.string().min(1),
  csrfToken: z.string().min(1),
  experiments: z.array(z.object({
    asset: z.enum(["BTC", "ETH"]),
    intervalSec: z.union([z.literal(900), z.literal(3600)]),
    experimentId: z.string().uuid()
  }))
});

async function resumeCampaignSession(baseUrl: string, cookie: string, csrfToken: string): Promise<string> {
  const encodedCookieValue = cookie.split("=", 2)[1];
  const rawCookieValue = encodedCookieValue === undefined ? "" : decodeURIComponent(encodedCookieValue);
  const rawSessionToken = rawCookieValue.split(".", 1)[0] ?? "";
  if (!/^[a-f0-9]{64}$/.test(rawSessionToken)) {
    throw new Error("Campaign state does not contain a valid opaque session resume token");
  }
  const response = await fetch(new URL("/api/v2/research-session/resume", baseUrl), {
    method: "POST",
    signal: AbortSignal.timeout(requestTimeoutMs),
    headers: {
      accept: "application/json",
      authorization: `Bearer ${rawSessionToken}`,
      cookie,
      "x-csrf-token": csrfToken
    }
  });
  if (!response.ok) {
    throw new Error(`Campaign session could not be resumed (${String(response.status)})`);
  }
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? cookie;
}

type WatchSample =
  | {
      readonly observedAt: string;
      readonly track: string;
      readonly asset: Asset;
      readonly intervalSec: IntervalSec;
      readonly status: "READY" | "BLOCKED";
      readonly candidate: Candidate;
    }
  | {
      readonly observedAt: string;
      readonly track: string;
      readonly asset: Asset;
      readonly intervalSec: IntervalSec;
      readonly status: "ERROR";
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly retryable: boolean | null;
      };
    };

function parseArgs(argv: readonly string[]): WatchConfig {
  const args = new Map<string, string>();
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      continue;
    }
    const [key, value = "true"] = arg.slice(2).split("=", 2);
    args.set(key, value);
  }
  const assets = parseAssets(args.get("assets") ?? defaultAssets.join(","));
  const intervals = parseIntervals(args.get("intervals") ?? defaultIntervals.join(","));
  const now = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  return {
    baseUrl: args.get("base-url") ?? defaultBaseUrl,
    account: args.get("account") ?? proofWalletAddress,
    assets,
    intervals,
    cycles: parsePositiveInteger(args.get("cycles") ?? "12000", "cycles"),
    intervalMs: parsePositiveInteger(args.get("interval-ms") ?? "30000", "interval-ms"),
    outputPath: resolve(repoRoot, args.get("output") ?? `evidence/execution-watch/watch-${now}.jsonl`),
    statePath: resolve(repoRoot, args.get("state-path") ?? "forward-observation-campaign.local")
  };
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${label} must be a positive integer`);
  }
  return parsed;
}

function parseAssets(value: string): readonly Asset[] {
  const assets = value.split(",").map((asset) => asset.trim().toUpperCase());
  for (const asset of assets) {
    if (asset !== "BTC" && asset !== "ETH") {
      throw new Error("--assets must contain only BTC and ETH");
    }
  }
  return [...new Set(assets)] as readonly Asset[];
}

function parseIntervals(value: string): readonly IntervalSec[] {
  const intervals = value.split(",").map((interval) => Number(interval.trim()));
  for (const interval of intervals) {
    if (interval !== 900 && interval !== 3600) {
      throw new Error("--intervals must contain only 900 and 3600");
    }
  }
  return [...new Set(intervals)] as readonly IntervalSec[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchCandidate(config: WatchRuntime, asset: Asset, intervalSec: IntervalSec): Promise<WatchSample> {
  const observedAt = new Date().toISOString();
  const track = `${asset}-${String(intervalSec)}`;
  const experimentId = config.experimentByTrack.get(`${asset}:${String(intervalSec)}`);
  if (experimentId === undefined) {
    return {
      observedAt,
      track,
      asset,
      intervalSec,
      status: "ERROR",
      error: {
        code: "CAMPAIGN_TRACK_MISSING",
        message: `No campaign experiment is recorded for ${asset}:${String(intervalSec)}`,
        retryable: true
      }
    };
  }
  try {
    const url = new URL("/api/v2/shannon/execution-candidate", config.baseUrl);
    url.searchParams.set("experimentId", experimentId);
    url.searchParams.set("account", config.account);
    url.searchParams.set("asset", asset);
    url.searchParams.set("intervalSec", String(intervalSec));
    const response = await fetch(url, {
      headers: { cookie: config.cookie },
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
    const payload: unknown = await response.json();
    const parsed = CandidateEnvelopeSchema.safeParse(payload);
    if (response.ok && parsed.success) {
      return {
        observedAt,
        track,
        asset,
        intervalSec,
        status: parsed.data.data.executionCandidate.status,
        candidate: parsed.data.data.executionCandidate
      };
    }
    const parsedError = ErrorEnvelopeSchema.safeParse(payload);
    return {
      observedAt,
      track,
      asset,
      intervalSec,
      status: "ERROR",
      error: parsedError.success
        ? {
            code: parsedError.data.error.code,
            message: parsedError.data.error.message,
            retryable: parsedError.data.error.retryable ?? null
          }
        : {
            code: `HTTP_${String(response.status)}`,
            message: response.statusText || "Execution candidate response was invalid",
            retryable: response.status >= 500
          }
    };
  } catch (error) {
    return {
      observedAt,
      track,
      asset,
      intervalSec,
      status: "ERROR",
      error: {
        code: "WATCH_REQUEST_FAILED",
        message: error instanceof Error ? error.message : "Execution candidate request failed",
        retryable: true
      }
    };
  }
}

function unavailableSamples(config: WatchConfig, error: unknown): WatchSample[] {
  const observedAt = new Date().toISOString();
  const message = error instanceof Error ? error.message : "Campaign state or session is unavailable";
  return config.assets.flatMap((asset) =>
    config.intervals.map((intervalSec) => ({
      observedAt,
      track: `${asset}-${String(intervalSec)}`,
      asset,
      intervalSec,
      status: "ERROR" as const,
      error: {
        code: "WATCH_SESSION_UNAVAILABLE",
        message,
        retryable: true
      }
    }))
  );
}

function summarizeSample(sample: WatchSample): string {
  if (sample.status === "ERROR") {
    return `${sample.observedAt} ${sample.track} ERROR ${sample.error.code}: ${sample.error.message}`;
  }
  const reasons = sample.candidate.blockedReasons.length === 0 ? "ready" : sample.candidate.blockedReasons.join(",");
  return [
    sample.observedAt,
    sample.track,
    sample.status,
    `side=${sample.candidate.sizing.side}`,
    `price=${sample.candidate.sizing.priceRaw ?? "none"}`,
    `qty=${sample.candidate.sizing.quantityRaw}`,
    `headroom=${String(sample.candidate.risk.expiryHeadroomSeconds)}s`,
    reasons
  ].join(" ");
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  await mkdir(dirname(config.outputPath), { recursive: true });
  const samples: WatchSample[] = [];
  let ready: WatchSample | null = null;
  console.log(`Watching ${config.assets.join(",")} ${config.intervals.join(",")} against ${config.baseUrl}`);
  console.log(`Account ${config.account}`);
  console.log(`Writing ${config.outputPath}`);

  for (let cycle = 1; cycle <= config.cycles; cycle += 1) {
    let cycleSamples: WatchSample[];
    try {
      const campaignState = CampaignStateSchema.parse(JSON.parse(await readFile(config.statePath, "utf8")));
      const cookie = await resumeCampaignSession(
        config.baseUrl,
        campaignState.cookie,
        campaignState.csrfToken
      );
      const cycleConfig: WatchRuntime = {
        ...config,
        cookie,
        experimentByTrack: new Map(
          campaignState.experiments.map((experiment) => [
            `${experiment.asset}:${String(experiment.intervalSec)}`,
            experiment.experimentId
          ])
        )
      };
      cycleSamples = await Promise.all(
        config.assets.flatMap((asset) =>
          config.intervals.map(async (intervalSec) => await fetchCandidate(cycleConfig, asset, intervalSec))
        )
      );
    } catch (error) {
      cycleSamples = unavailableSamples(config, error);
    }
    samples.push(...cycleSamples);
    await writeFile(config.outputPath, samples.map((sample) => JSON.stringify(sample)).join("\n") + "\n");
    for (const sample of cycleSamples) {
      console.log(`[${String(cycle).padStart(3, "0")}] ${summarizeSample(sample)}`);
      if (sample.status === "READY") {
        ready = sample;
      }
    }
    if (ready !== null) {
      console.log("READY observation found. Open /execution-candidate; the server will revalidate again before each wallet signing request.");
      break;
    }
    if (cycle < config.cycles) {
      await sleep(config.intervalMs);
    }
  }

  if (ready === null) {
    console.log("No READY candidate found before watcher limit. The JSONL evidence records every blocked/error reason.");
  }
}

await main();
