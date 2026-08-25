import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import {
  createApprovalChallenge,
  createLoginChallenge,
  verifyChallenge,
  type AuthChallenge,
  type SignatureVerifier
} from "@edgelab/auth";
import { summarizeChainEvidence } from "@edgelab/chain";
import type { RuntimeConfig } from "@edgelab/config";
import { DREAMDEX_MARKETS_SDK_VERSION, SOMNIA_MAINNET_CHAIN_ID, SOMNIA_SHANNON_CHAIN_ID } from "@edgelab/domain";
import {
  completeReplayRun,
  createInteractiveExperiment,
  createReplayRun,
  createResearchSession,
  failReplayRun,
  findReplayRunByInputHash,
  findActiveResearchSessionByTokenHash,
  getInteractiveExperiment,
  getLatestReplayRunForExperiment,
  listInteractiveExperiments,
  persistHistoricalSourceManifest,
  persistReplayDecision,
  rotateResearchSessionCsrf,
  startReplayRun,
  upsertPolicyVersion,
  type InteractiveExperimentDetailRecord,
  type ReplayRunDetailRecord,
  type ReplayRunRecord,
  type ResearchSessionRecord
} from "@edgelab/db";
import {
  countHistoricalBinaryMarkets,
  createMainnetHistoricalDreamDexSdkClient,
  discoverSuccessorMarkets,
  getHistoricalBinaryMarket,
  getHistoricalMarketResolution,
  getHistoricalMarketStatusHistory,
  getHistoricalReconstructedBookCapability,
  HISTORICAL_BOOK_RECONSTRUCTION_CAPABILITY,
  HISTORICAL_CANDLE_INTERVAL_SECONDS,
  listHistoricalBinaryMarkets,
  listHistoricalCandles,
  listHistoricalFillsByMarket,
  listHistoricalOrdersByMarket,
  type DreamDexReadConfig,
  type DreamDexSdkClient,
  type HistoricalDreamDexReadResult,
  type HistoricalDreamDexSdkClient,
  type HistoricalFillEvidence,
  type HistoricalIndexerFetch,
  type HistoricalMarketEvidence,
  type HistoricalMarketFilters,
  type HistoricalOrderEvidence,
  type HistoricalPageOptions,
  type HistoricalRowsPage,
  type HistoricalTimeWindowPageOptions,
  type MainnetHistoricalDreamDexConfig
} from "@edgelab/dreamdex";
import { runMetricAssessment } from "@edgelab/evaluate";
import { observeExperiment } from "@edgelab/observe";
import {
  createHistoricalPolicyManifest,
  createPolicyManifest,
  evaluateHistoricalPolicy,
  historicalPolicies,
  referencePolicies,
  type HistoricalPolicyAdapter,
  type PolicyAdapter
} from "@edgelab/policy-runtime";
import { buildHistoricalDecisionFrame } from "@edgelab/replay";
import { reconcileSettlements } from "@edgelab/settle";
import { z } from "zod";

export interface AppDependencies {
  readonly pool?: pg.Pool;
  readonly dreamDexClient?: DreamDexSdkClient;
  readonly dreamDexConfig?: DreamDexReadConfig;
  readonly historicalDreamDexClient?: HistoricalDreamDexSdkClient;
  readonly historicalDreamDexConfig?: MainnetHistoricalDreamDexConfig;
  readonly historicalIndexerFetch?: HistoricalIndexerFetch;
  readonly policyAdapters?: readonly PolicyAdapter[];
  readonly consumedNonces?: Set<string>;
  readonly signatureVerifier?: SignatureVerifier;
}

const AddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const MarketIdSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const IntentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const IdempotencyKeySchema = z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const ResearchSessionCookie = "edgelab_research_session";
const CsrfHeader = "x-csrf-token";
const SessionTtlMs = 7 * 24 * 60 * 60 * 1000;
const IntervalSecSchema = z.union([z.literal(900), z.literal(3600), z.literal(14400), z.literal(86400)]);
const ExperimentCreateSchema = z.object({
  name: z.string().trim().min(3).max(80),
  mode: z.enum(["HISTORICAL_REPLAY", "LIVE_SHADOW"]),
  asset: z.enum(["BTC", "ETH"]),
  intervalSec: IntervalSecSchema,
  policyId: z.string().min(1),
  policyVersion: z.string().min(1),
  marketId: MarketIdSchema.optional(),
  windowFrom: z.iso.datetime().optional(),
  windowTo: z.iso.datetime().optional(),
  decisionOffsetSec: z.number().int().min(-3600).max(3600).default(0),
  riskEnvelopeId: z.literal("WATCH_ONLY_BOUNDED").default("WATCH_ONLY_BOUNDED")
});
const HistoricalMarketQuerySchema = z.object({
  asset: z.enum(["BTC", "ETH"]).optional(),
  intervalSec: z.coerce.number().int().positive().optional(),
  status: z.enum(["Resolved", "Finalized"]).optional(),
  limit: z.coerce.number().int().optional(),
  offset: z.coerce.number().int().optional()
});
const HistoricalPageQuerySchema = z.object({
  limit: z.coerce.number().int().optional(),
  offset: z.coerce.number().int().optional()
});
const HistoricalCandleQuerySchema = z.object({
  intervalSeconds: z.coerce.number().int().positive(),
  limit: z.coerce.number().int().optional(),
  fromSec: z.coerce.number().int().optional(),
  toSec: z.coerce.number().int().optional()
});
const ChallengeRequestSchema = z.discriminatedUnion("purpose", [
  z.object({ purpose: z.literal("login"), account: AddressSchema }),
  z.object({ purpose: z.literal("approval"), account: AddressSchema, intentHash: IntentHashSchema })
]);
const VerifyRequestSchema = z.object({
  challenge: z.custom<AuthChallenge>(),
  signature: z.string().min(1),
  account: AddressSchema
});
const EvaluateRequestSchema = z.object({
  policyVersionId: z.string().uuid(),
  ruleVersion: z.string().min(1)
});
const ComparisonCreateSchema = z.object({
  name: z.string().trim().min(3).max(80),
  assessmentIds: z.array(z.string().uuid()).min(2).max(4)
});

function requireIdempotencyKey(headers: Record<string, string | string[] | undefined>): string {
  const value = headers["idempotency-key"];
  if (typeof value !== "string" || !IdempotencyKeySchema.safeParse(value).success) {
    throw new Error("Idempotency-Key header is required");
  }
  return value.trim();
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function randomToken(): string {
  return randomBytes(32).toString("hex");
}

function stableJson(input: unknown): string {
  if (Array.isArray(input)) {
    return `[${input.map(stableJson).join(",")}]`;
  }
  if (input !== null && typeof input === "object") {
    return `{${Object.entries(input as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${JSON.stringify(key)}:${stableJson(value)}`)
      .join(",")}}`;
  }
  return JSON.stringify(input);
}

function sessionCookieOptions(config: RuntimeConfig) {
  return {
    path: "/",
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "lax" as const,
    signed: true,
    maxAge: Math.floor(SessionTtlMs / 1000)
  };
}

function readSignedSessionToken(request: FastifyRequest): string | null {
  const rawCookie = request.cookies[ResearchSessionCookie];
  if (typeof rawCookie !== "string") {
    return null;
  }
  const unsigned = request.unsignCookie(rawCookie);
  return unsigned.valid && typeof unsigned.value === "string" ? unsigned.value : null;
}

function requirePool(deps: AppDependencies): pg.Pool {
  if (deps.pool === undefined) {
    throw new Error("Database dependency is not configured");
  }
  return deps.pool;
}

function requireDreamDex(deps: AppDependencies): {
  readonly client: DreamDexSdkClient;
  readonly config: DreamDexReadConfig;
} {
  if (deps.dreamDexClient === undefined || deps.dreamDexConfig === undefined) {
    throw new Error("DreamDEX dependency is not configured");
  }
  return { client: deps.dreamDexClient, config: deps.dreamDexConfig };
}

async function createFreshResearchSession(
  pool: pg.Pool,
  config: RuntimeConfig,
  reply: FastifyReply
): Promise<{ readonly session: ResearchSessionRecord; readonly rawSessionToken: string; readonly csrfToken: string }> {
  const rawSessionToken = randomToken();
  const csrfToken = randomToken();
  const session = await createResearchSession(pool, {
    tokenHash: sha256(rawSessionToken),
    csrfHash: sha256(csrfToken),
    expiresAt: new Date(Date.now() + SessionTtlMs)
  });
  reply.setCookie(ResearchSessionCookie, rawSessionToken, sessionCookieOptions(config));
  return { session, rawSessionToken, csrfToken };
}

async function ensureResearchSession(
  pool: pg.Pool,
  config: RuntimeConfig,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<{ readonly session: ResearchSessionRecord; readonly csrfToken: string; readonly created: boolean }> {
  const rawSessionToken = readSignedSessionToken(request);
  if (rawSessionToken !== null) {
    const existing = await findActiveResearchSessionByTokenHash(pool, sha256(rawSessionToken));
    if (existing !== null) {
      const csrfToken = randomToken();
      const rotated = await rotateResearchSessionCsrf(pool, {
        sessionId: existing.id,
        csrfHash: sha256(csrfToken)
      });
      if (rotated !== null) {
        reply.setCookie(ResearchSessionCookie, rawSessionToken, sessionCookieOptions(config));
        return { session: rotated, csrfToken, created: false };
      }
    }
  }
  const created = await createFreshResearchSession(pool, config, reply);
  return { session: created.session, csrfToken: created.csrfToken, created: true };
}

async function requireResearchSession(
  pool: pg.Pool,
  request: FastifyRequest
): Promise<ResearchSessionRecord | null> {
  const rawSessionToken = readSignedSessionToken(request);
  if (rawSessionToken === null) {
    return null;
  }
  return await findActiveResearchSessionByTokenHash(pool, sha256(rawSessionToken));
}

function requireCsrf(request: FastifyRequest, session: ResearchSessionRecord): boolean {
  const value = request.headers[CsrfHeader];
  return typeof value === "string" && sha256(value) === session.csrfHash;
}

function serializeExperiment(record: InteractiveExperimentDetailRecord) {
  return {
    experimentId: record.experimentId,
    name: record.name,
    status: record.status,
    visibility: record.visibility,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    configuration: {
      ...record.configuration,
      windowFrom: record.configuration.windowFrom?.toISOString() ?? null,
      windowTo: record.configuration.windowTo?.toISOString() ?? null
    },
    policies: record.policies
  };
}

function policySupportedPlanes(policyId: string): readonly ("MAINNET_HISTORICAL" | "SHANNON_FORWARD")[] {
  if (policyId === "reference-book-tilt") {
    return ["SHANNON_FORWARD"];
  }
  if (policyId === "historical-last-trade") {
    return ["MAINNET_HISTORICAL"];
  }
  return ["MAINNET_HISTORICAL", "SHANNON_FORWARD"];
}

function policySupportedInMode(policyId: string, mode: "HISTORICAL_REPLAY" | "LIVE_SHADOW"): boolean {
  const requiredPlane = mode === "HISTORICAL_REPLAY" ? "MAINNET_HISTORICAL" : "SHANNON_FORWARD";
  return policySupportedPlanes(policyId).includes(requiredPlane);
}

function policyCatalog(
  adapters: readonly PolicyAdapter[]
): readonly {
  readonly policyId: string;
  readonly version: string;
  readonly label: string;
  readonly adapterName: string;
  readonly sourceHash: string;
  readonly supportedPlanes: readonly ("MAINNET_HISTORICAL" | "SHANNON_FORWARD")[];
  readonly description: string;
}[] {
  const livePolicies = adapters.map((adapter) => ({
    ...createPolicyManifest(adapter),
    supportedPlanes: policySupportedPlanes(adapter.policyId),
    description:
      adapter.policyId === "reference-book-tilt"
        ? "Captured-book tilt baseline. Historical use remains disabled until book reconstruction is verified."
        : "Neutral watch-only baseline for calibration and workflow validation."
  }));
  const replayPolicies = historicalPolicies.map((adapter: HistoricalPolicyAdapter) => ({
    ...createHistoricalPolicyManifest(adapter),
    supportedPlanes: policySupportedPlanes(adapter.policyId),
    description:
      "Uses only the latest verified pre-cutoff fill in the last 15 minutes; abstains when no qualifying fill exists."
  }));
  return [...livePolicies, ...replayPolicies];
}

function createDefaultHistoricalConfig(config: RuntimeConfig): MainnetHistoricalDreamDexConfig {
  return {
    rpcUrl: config.SOMNIA_MAINNET_RPC_URL,
    indexerUrl: config.DREAMDEX_MAINNET_INDEXER_URL,
    chainId: config.SOMNIA_MAINNET_CHAIN_ID,
    sdkVersion: config.MARKETS_SDK_VERSION
  };
}

function v2Data<T>(data: T, meta: Record<string, unknown> = {}) {
  return {
    data,
    meta: {
      apiVersion: "v2",
      ...meta
    }
  };
}

function v2Error(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  retryable: boolean,
  correlationId: string,
  details?: unknown
) {
  return reply.code(statusCode).send({
    error: {
      code,
      message,
      retryable,
      correlationId,
      ...(details === undefined ? {} : { details })
    }
  });
}

function historicalErrorStatus(result: Extract<HistoricalDreamDexReadResult<unknown>, { readonly ok: false }>): number {
  if (result.reasonCode === "DREAMDEX_HISTORICAL_BOUNDS_INVALID") {
    return 400;
  }
  if (result.reasonCode === "DREAMDEX_HISTORICAL_CAPABILITY_UNVERIFIED") {
    return 409;
  }
  if (result.reasonCode === "DREAMDEX_HISTORICAL_CONFIG_INVALID") {
    return 503;
  }
  return 503;
}

function historicalErrorRetryable(result: Extract<HistoricalDreamDexReadResult<unknown>, { readonly ok: false }>): boolean {
  return result.reasonCode === "DREAMDEX_HISTORICAL_READ_FAILED";
}

function compactHistoricalMarketFilters(input: z.infer<typeof HistoricalMarketQuerySchema>): HistoricalMarketFilters {
  return {
    ...(input.asset === undefined ? {} : { asset: input.asset }),
    ...(input.intervalSec === undefined ? {} : { intervalSec: input.intervalSec }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.offset === undefined ? {} : { offset: input.offset })
  };
}

function compactHistoricalPage(input: z.infer<typeof HistoricalPageQuerySchema>): HistoricalPageOptions {
  return {
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.offset === undefined ? {} : { offset: input.offset })
  };
}

function compactHistoricalCandleQuery(
  input: z.infer<typeof HistoricalCandleQuerySchema>
): Omit<HistoricalTimeWindowPageOptions, "offset"> {
  return {
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.fromSec === undefined ? {} : { fromSec: input.fromSec }),
    ...(input.toSec === undefined ? {} : { toSec: input.toSec })
  };
}

const ReplaySourceVersion = "dreamdex-mainnet-history@0.28.1";
const ReplayQueryVersion = "replay-002-bounded-v1";
const ReplayMaxMarkets = 12;
const ReplayPageLimit = 100;
const ReplayMaxFills = 1_000;

function serializeReplayRun(record: ReplayRunRecord | ReplayRunDetailRecord) {
  return {
    id: record.id,
    experimentId: record.experimentId,
    configurationId: record.configurationId,
    plane: record.plane,
    status: record.status,
    frozenNow: record.frozenNow.toISOString(),
    selectedCount: record.selectedCount,
    processedCount: record.processedCount,
    scoredCount: record.scoredCount,
    excludedCount: record.excludedCount,
    capability: record.capability,
    sourceVersion: record.sourceVersion,
    queryVersion: record.queryVersion,
    inputHash: record.inputHash,
    outputHash: record.outputHash,
    errorCode: record.errorCode,
    checkpoints: record.checkpoints,
    createdAt: record.createdAt.toISOString(),
    startedAt: record.startedAt?.toISOString() ?? null,
    completedAt: record.completedAt?.toISOString() ?? null,
    decisions:
      "decisions" in record
        ? record.decisions.map((decision) => ({
            id: decision.id,
            marketId: decision.marketId,
            decisionAt: decision.decisionAt.toISOString(),
            cutoffBlock: decision.cutoffBlock,
            frameHash: decision.frameHash,
            forecastPUp: decision.forecastPUp,
            action: decision.action,
            reasonCodes: decision.reasonCodes,
            outcomeLoadedAt: decision.outcomeLoadedAt?.toISOString() ?? null,
            outcomeResult: decision.outcomeResult,
            exclusionReason: decision.exclusionReason
          }))
        : undefined
  };
}

function candidatePolicy(record: InteractiveExperimentDetailRecord) {
  return record.policies.find((policy) => policy.role === "CANDIDATE") ?? record.policies[0] ?? null;
}

function historicalPolicyAdapter(record: InteractiveExperimentDetailRecord): HistoricalPolicyAdapter | null {
  const policy = candidatePolicy(record);
  if (policy === null) {
    return null;
  }
  return (
    historicalPolicies.find((adapter) => adapter.policyId === policy.policyId && adapter.version === policy.version) ??
    null
  );
}

function experimentReplayInputHash(experiment: InteractiveExperimentDetailRecord): string {
  return sha256(
    stableJson({
      experimentId: experiment.experimentId,
      configurationId: experiment.configuration.id,
      configHash: experiment.configuration.configHash,
      candidatePolicy: candidatePolicy(experiment),
      sourceVersion: ReplaySourceVersion,
      queryVersion: ReplayQueryVersion
    })
  );
}

function selectedMarketId(experiment: InteractiveExperimentDetailRecord): string | null {
  const value = experiment.configuration.config.selectedMarketId;
  return typeof value === "string" && MarketIdSchema.safeParse(value).success ? value.toLowerCase() : null;
}

function normalizeOutcome(value: string | null): "YES" | "NO" | null {
  if (value === null) {
    return null;
  }
  const normalized = value.trim().toUpperCase();
  if (["YES", "UP", "TRUE", "0"].includes(normalized)) {
    return "YES";
  }
  if (["NO", "DOWN", "FALSE", "1"].includes(normalized)) {
    return "NO";
  }
  return null;
}

function maxBlock(values: readonly string[]): string | null {
  let max: bigint | null = null;
  for (const value of values) {
    if (!/^[0-9]+$/.test(value)) {
      continue;
    }
    const parsed = BigInt(value);
    if (max === null || parsed > max) {
      max = parsed;
    }
  }
  return max?.toString() ?? null;
}

function minBlock(values: readonly string[]): string | null {
  let min: bigint | null = null;
  for (const value of values) {
    if (!/^[0-9]+$/.test(value)) {
      continue;
    }
    const parsed = BigInt(value);
    if (min === null || parsed < min) {
      min = parsed;
    }
  }
  return min?.toString() ?? null;
}

function cutoffBlockFromSourceRows(input: {
  readonly decisionAtSeconds: number;
  readonly orders: readonly HistoricalOrderEvidence[];
  readonly fills: readonly HistoricalFillEvidence[];
}): string {
  const blocks: string[] = [];
  for (const fill of input.fills) {
    if (fill.timestampSeconds < input.decisionAtSeconds) {
      blocks.push(fill.blockNumber);
    }
  }
  for (const order of input.orders) {
    if (order.placedAtTimestampSeconds < input.decisionAtSeconds) {
      blocks.push(order.placedAtBlock);
    }
    if (order.lastUpdatedAtTimestampSeconds < input.decisionAtSeconds) {
      blocks.push(order.lastUpdatedAtBlock);
    }
  }
  return maxBlock(blocks) ?? "0";
}

async function fetchPagedHistoricalRows<T>(
  readPage: (page: HistoricalPageOptions) => Promise<HistoricalDreamDexReadResult<HistoricalRowsPage<T>>>,
  maxRows: number
): Promise<HistoricalDreamDexReadResult<{ readonly rows: readonly T[]; readonly hasMore: boolean }>> {
  const rows: T[] = [];
  let offset = 0;
  let hasMore = true;
  while (hasMore && rows.length < maxRows) {
    const page = await readPage({ limit: Math.min(ReplayPageLimit, maxRows - rows.length), offset });
    if (!page.ok) {
      return page;
    }
    rows.push(...page.value.rows);
    hasMore = page.value.hasMore;
    offset += page.value.page.limit;
  }
  return { ok: true, value: { rows, hasMore } };
}

async function selectHistoricalReplayMarkets(input: {
  readonly experiment: InteractiveExperimentDetailRecord;
  readonly client: HistoricalDreamDexSdkClient;
  readonly config: MainnetHistoricalDreamDexConfig;
}): Promise<HistoricalDreamDexReadResult<readonly HistoricalMarketEvidence[]>> {
  const explicitMarketId = selectedMarketId(input.experiment);
  if (explicitMarketId !== null) {
    const market = await getHistoricalBinaryMarket(input.client, input.config, explicitMarketId);
    if (!market.ok) {
      return market;
    }
    return { ok: true, value: market.value === null ? [] : [market.value] };
  }
  const [asset] = input.experiment.configuration.assets;
  const [intervalSec] = input.experiment.configuration.intervals;
  const page = await listHistoricalBinaryMarkets(input.client, input.config, {
    ...(asset === "BTC" || asset === "ETH" ? { asset } : {}),
    ...(typeof intervalSec === "number" ? { intervalSec } : {}),
    status: "Finalized",
    limit: ReplayMaxMarkets,
    offset: 0
  });
  if (!page.ok) {
    return page;
  }
  const fromSeconds =
    input.experiment.configuration.windowFrom === null
      ? null
      : Math.floor(input.experiment.configuration.windowFrom.getTime() / 1000);
  const toSeconds =
    input.experiment.configuration.windowTo === null
      ? null
      : Math.floor(input.experiment.configuration.windowTo.getTime() / 1000);
  return {
    ok: true,
    value: page.value.rows.filter(
      (market) =>
        (fromSeconds === null || market.expirySeconds >= fromSeconds) &&
        (toSeconds === null || market.tradingStartSeconds <= toSeconds)
    )
  };
}

async function executeHistoricalReplay(input: {
  readonly pool: pg.Pool;
  readonly replayRun: ReplayRunRecord;
  readonly experiment: InteractiveExperimentDetailRecord;
  readonly historicalDreamDexClient: HistoricalDreamDexSdkClient;
  readonly historicalDreamDexConfig: MainnetHistoricalDreamDexConfig;
  readonly historicalIndexerFetch?: HistoricalIndexerFetch;
}): Promise<ReplayRunRecord> {
  const adapter = historicalPolicyAdapter(input.experiment);
  const policy = candidatePolicy(input.experiment);
  if (adapter === null || policy === null) {
    throw new Error("Experiment does not have a supported historical candidate policy");
  }
  const markets = await selectHistoricalReplayMarkets({
    experiment: input.experiment,
    client: input.historicalDreamDexClient,
    config: input.historicalDreamDexConfig
  });
  if (!markets.ok) {
    throw new Error(markets.message);
  }
  let processedCount = 0;
  let scoredCount = 0;
  const outputItems: unknown[] = [];
  for (const market of markets.value.slice(0, ReplayMaxMarkets)) {
    const decisionLeadSeconds = Math.max(60, Math.abs(input.experiment.configuration.decisionOffsetSec));
    const decisionAtSeconds = Math.max(market.tradingStartSeconds + 1, market.expirySeconds - decisionLeadSeconds);
    const decisionAt = new Date(decisionAtSeconds * 1000);
    const candles = await listHistoricalCandles(input.historicalDreamDexClient, input.historicalDreamDexConfig, market.poolAddress, 300, {
      fromSec: market.tradingStartSeconds,
      toSec: decisionAtSeconds,
      limit: 100
    });
    if (!candles.ok) {
      throw new Error(candles.message);
    }
    const orders = await listHistoricalOrdersByMarket(
      input.historicalDreamDexConfig,
      market.stableMarketId,
      { limit: ReplayPageLimit, offset: 0 },
      input.historicalIndexerFetch
    );
    if (!orders.ok) {
      throw new Error(orders.message);
    }
    const fills = await fetchPagedHistoricalRows(
      (page) =>
        listHistoricalFillsByMarket(input.historicalDreamDexConfig, market.stableMarketId, page, input.historicalIndexerFetch),
      ReplayMaxFills
    );
    if (!fills.ok) {
      throw new Error(fills.message);
    }
    const cutoffBlock = cutoffBlockFromSourceRows({
      decisionAtSeconds,
      orders: orders.value.rows,
      fills: fills.value.rows
    });
    const frameResult = buildHistoricalDecisionFrame({
      market,
      decisionAt: decisionAt.toISOString(),
      cutoffBlock,
      candles: candles.value,
      orders: orders.value.rows,
      fills: fills.value.rows,
      openingPrice:
        market.openingPriceRaw === null
          ? null
          : {
              priceRaw: market.openingPriceRaw,
              availableAtBlock: cutoffBlock
            },
      quoteDecimals: market.quoteDecimals
    });
    const decision = evaluateHistoricalPolicy(adapter, {
      frame: frameResult.frame,
      frameHash: frameResult.frameHash
    });
    const outcome = normalizeOutcome(market.winningOutcome);
    const exclusionReason =
      decision.action === "ABSTAIN"
        ? decision.reasonCodes.join("|")
        : outcome === null
          ? "OUTCOME_UNAVAILABLE_OR_UNMAPPED"
          : null;
    await persistReplayDecision(input.pool, {
      replayRunId: input.replayRun.id,
      marketId: market.stableMarketId,
      policyVersionId: policy.policyVersionId,
      decisionAt,
      cutoffBlock,
      frameHash: frameResult.frameHash,
      forecastPUp: decision.action === "ABSTAIN" ? null : decision.forecastPUp,
      action: decision.action,
      reasonCodes: decision.reasonCodes,
      outcomeLoadedAt: new Date(),
      outcomeResult: outcome,
      exclusionReason
    });
    const blocks = [
      ...orders.value.rows.flatMap((order) => [order.placedAtBlock, order.lastUpdatedAtBlock]),
      ...fills.value.rows.map((fill) => fill.blockNumber)
    ];
    const manifestDigest = sha256(
      stableJson({
        marketId: market.stableMarketId,
        frameHash: frameResult.frameHash,
        ordersCount: orders.value.rows.length,
        fillsCount: fills.value.rows.length,
        candlesCount: candles.value.length,
        partialOrders: orders.value.hasMore,
        partialFills: fills.value.hasMore
      })
    );
    await persistHistoricalSourceManifest(input.pool, {
      replayRunId: input.replayRun.id,
      marketId: market.stableMarketId,
      sourceVersion: ReplaySourceVersion,
      queryVersion: ReplayQueryVersion,
      ordersCount: orders.value.rows.length,
      fillsCount: fills.value.rows.length,
      candlesCount: candles.value.length,
      firstBlock: minBlock(blocks),
      lastBlock: maxBlock(blocks),
      completeness: orders.value.hasMore || fills.value.hasMore ? "PARTIAL" : "COMPLETE",
      canonicalDigest: manifestDigest,
      retrievedAt: new Date(),
      sourceMetadata: {
        plane: "MAINNET_HISTORICAL",
        chainId: SOMNIA_MAINNET_CHAIN_ID,
        marketId: market.stableMarketId,
        cutoffBlock,
        frameHash: frameResult.frameHash,
        outcomeLoadedOnlyAfterFrame: true,
        bookReconstruction: HISTORICAL_BOOK_RECONSTRUCTION_CAPABILITY
      }
    });
    processedCount += 1;
    if (decision.action !== "ABSTAIN" && outcome !== null) {
      scoredCount += 1;
    }
    outputItems.push({
      marketId: market.stableMarketId,
      frameHash: frameResult.frameHash,
      cutoffBlock,
      action: decision.action,
      outcome,
      exclusionReason
    });
  }
  const outputHash = sha256(stableJson(outputItems));
  return await completeReplayRun(input.pool, {
    replayRunId: input.replayRun.id,
    selectedCount: markets.value.length,
    processedCount,
    scoredCount,
    excludedCount: processedCount - scoredCount,
    outputHash,
    checkpoints: {
      marketsProcessed: processedCount,
      decisionsGenerated: processedCount,
      scoredDecisions: scoredCount,
      abstentionsOrUnusable: processedCount - scoredCount,
      sourcePlane: "MAINNET_HISTORICAL",
      outcomeEmbargo: "OUTCOME_WRITTEN_AFTER_FRAME_HASH",
      bookReconstruction: HISTORICAL_BOOK_RECONSTRUCTION_CAPABILITY
    }
  });
}

async function loadLiveShadowState(pool: pg.Pool, input: { readonly sessionId: string; readonly experimentId: string }) {
  const result = await pool.query<{
    episode_count: string;
    snapshot_count: string;
    decision_count: string;
    latest_decided_at: Date | null;
    latest_market_id: string | null;
  }>(
    `
      SELECT
        count(DISTINCT me.id) AS episode_count,
        count(DISTINCT ms.id) AS snapshot_count,
        count(DISTINCT sd.id) AS decision_count,
        max(sd.decided_at) AS latest_decided_at,
        (array_agg(me.market_id ORDER BY sd.decided_at DESC NULLS LAST))[1] AS latest_market_id
      FROM experiments e
      LEFT JOIN market_episodes me ON me.experiment_id = e.id
      LEFT JOIN market_snapshots ms ON ms.episode_id = me.id
      LEFT JOIN shadow_decisions sd ON sd.episode_id = me.id
      WHERE e.id = $1
        AND e.created_by_session_id = $2
      GROUP BY e.id
    `,
    [input.experimentId, input.sessionId]
  );
  const row = result.rows[0];
  return {
    episodeCount: Number(row?.episode_count ?? 0),
    snapshotCount: Number(row?.snapshot_count ?? 0),
    decisionCount: Number(row?.decision_count ?? 0),
    latestDecidedAt: row?.latest_decided_at?.toISOString() ?? null,
    latestMarketId: row?.latest_market_id ?? null,
    sourcePlane: "SHANNON_FORWARD",
    blockchainWrite: false
  };
}

interface AssessmentSummaryRow {
  readonly assessment_id: string;
  readonly metric_run_id: string;
  readonly experiment_id: string;
  readonly experiment_name: string;
  readonly verdict: string;
  readonly reason_codes: string[];
  readonly sample_size: number;
  readonly exclusion_count: number;
  readonly brier_score: number | null;
  readonly calibration_bias: number | null;
  readonly neutral_baseline_delta: number | null;
  readonly pnl_status: string;
  readonly evidence_plane: string;
  readonly promotion_scope: string;
  readonly created_at: Date;
}

function serializeAssessmentSummary(row: AssessmentSummaryRow) {
  return {
    assessmentId: row.assessment_id,
    metricRunId: row.metric_run_id,
    experimentId: row.experiment_id,
    experimentName: row.experiment_name,
    verdict: row.verdict,
    reasonCodes: row.reason_codes,
    sampleSize: row.sample_size,
    exclusionCount: row.exclusion_count,
    brierScore: row.brier_score,
    calibrationBias: row.calibration_bias,
    neutralBaselineDelta: row.neutral_baseline_delta,
    pnlStatus: row.pnl_status,
    evidencePlane: row.evidence_plane,
    promotionScope: row.promotion_scope,
    createdAt: row.created_at.toISOString()
  };
}

async function loadOwnedAssessmentSummaries(
  pool: pg.Pool,
  input: { readonly sessionId: string; readonly assessmentIds?: readonly string[]; readonly limit?: number }
): Promise<AssessmentSummaryRow[]> {
  const result = await pool.query<AssessmentSummaryRow>(
    `
      SELECT
        ea.id AS assessment_id,
        mr.id AS metric_run_id,
        e.id AS experiment_id,
        e.name AS experiment_name,
        ea.verdict,
        ea.reason_codes,
        mr.sample_size,
        mr.exclusion_count,
        mr.brier_score,
        mr.calibration_bias,
        mr.neutral_baseline_delta,
        mr.pnl_status,
        mr.evidence_plane,
        mr.promotion_scope,
        ea.created_at
      FROM evidence_assessments ea
      JOIN metric_runs mr ON mr.id = ea.metric_run_id
      JOIN experiments e ON e.id = mr.experiment_id
      WHERE e.created_by_session_id = $1
        AND ($2::uuid[] IS NULL OR ea.id = ANY($2::uuid[]))
      ORDER BY ea.created_at DESC, ea.id DESC
      LIMIT $3
    `,
    [input.sessionId, input.assessmentIds === undefined ? null : [...input.assessmentIds], input.limit ?? 20]
  );
  return result.rows;
}

async function loadComparison(pool: pg.Pool, input: { readonly sessionId: string; readonly comparisonId: string }) {
  const result = await pool.query<{
    comparison_id: string;
    name: string;
    created_at: Date;
    updated_at: Date;
    items: unknown;
  }>(
    `
      SELECT
        cs.id AS comparison_id,
        cs.name,
        cs.created_at,
        cs.updated_at,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'assessmentId', ea.id,
              'displayOrder', ci.display_order,
              'metricRunId', mr.id,
              'experimentId', e.id,
              'experimentName', e.name,
              'verdict', ea.verdict,
              'reasonCodes', ea.reason_codes,
              'sampleSize', mr.sample_size,
              'exclusionCount', mr.exclusion_count,
              'brierScore', mr.brier_score,
              'calibrationBias', mr.calibration_bias,
              'neutralBaselineDelta', mr.neutral_baseline_delta,
              'pnlStatus', mr.pnl_status,
              'evidencePlane', mr.evidence_plane,
              'promotionScope', mr.promotion_scope,
              'createdAt', ea.created_at
            )
            ORDER BY ci.display_order
          ) FILTER (WHERE ea.id IS NOT NULL),
          '[]'::jsonb
        ) AS items
      FROM comparison_sets cs
      JOIN comparison_items ci ON ci.comparison_set_id = cs.id
      JOIN evidence_assessments ea ON ea.id = ci.assessment_id
      JOIN metric_runs mr ON mr.id = ea.metric_run_id
      JOIN experiments e ON e.id = mr.experiment_id
      WHERE cs.id = $1
        AND cs.created_by_session_id = $2
      GROUP BY cs.id
    `,
    [input.comparisonId, input.sessionId]
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    comparisonId: row.comparison_id,
    name: row.name.replace(/#[A-Za-z0-9._:-]{8,128}$/, ""),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    items: Array.isArray(row.items) ? row.items : []
  };
}

export function buildApp(config: RuntimeConfig, deps: AppDependencies = {}) {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"]
    }
  });
  const consumedNonces = deps.consumedNonces ?? new Set<string>();
  const policyAdapters = deps.policyAdapters ?? referencePolicies;
  const historicalDreamDexConfig = deps.historicalDreamDexConfig ?? createDefaultHistoricalConfig(config);
  const historicalDreamDexClient =
    deps.historicalDreamDexClient ?? createMainnetHistoricalDreamDexSdkClient(historicalDreamDexConfig);

  void app.register(helmet);
  void app.register(cookie, { secret: config.SESSION_SECRET });
  void app.register(cors, {
    origin: config.PUBLIC_APP_URL,
    credentials: true
  });
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const staticRoots = [
    join(moduleDir, "..", "..", "web", "dist"),
    join(moduleDir, "..", "..", "..", "apps", "web", "dist")
  ];
  const staticRoot = staticRoots.find((candidate) => existsSync(join(candidate, "index.html")));
  if (staticRoot !== undefined) {
    void app.register(fastifyStatic, {
      root: staticRoot,
      prefix: "/"
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const methodAllowsSpaFallback = request.method === "GET" || request.method === "HEAD";
    const path = new URL(request.url, config.PUBLIC_APP_URL).pathname;
    const isApiPath = path === "/api" || path.startsWith("/api/");
    const looksLikeAsset = path.split("/").at(-1)?.includes(".") ?? false;
    if (staticRoot !== undefined && methodAllowsSpaFallback && !isApiPath && !looksLikeAsset) {
      const html = readFileSync(join(staticRoot, "index.html"), "utf8");
      return reply.type("text/html; charset=utf-8").send(html);
    }
    return reply.code(404).send({
      ok: false,
      reasonCode: "NOT_FOUND",
      message: "Route not found"
    });
  });

  app.get("/healthz", () => ({
    ok: true,
    service: "edgelab",
    buildCommit: config.BUILD_COMMIT
  }));

  app.get("/readyz", async () => {
    let database = "not_configured";
    if (deps.pool !== undefined) {
      await deps.pool.query("SELECT 1");
      database = "ok";
    }
    return {
      ok: true,
      database,
      workerEnabled: config.WORKER_ENABLED,
      chainId: SOMNIA_SHANNON_CHAIN_ID,
      marketsSdkVersion: DREAMDEX_MARKETS_SDK_VERSION
    };
  });

  app.get("/api/v1/invariants", () => ({
    product: "forward-testing-live-shadow-recent-window-dreamdex-lab",
    verdicts: ["PROMOTE", "HOLD", "REJECT", "INSUFFICIENT_EVIDENCE"],
    boundaries: {
      serviceSignsTransactions: false,
      historicalClobBacktest: false,
      fabricatedFills: false,
      mainnetWrites: false,
      pnlWithoutFillAndSettlement: false
    }
  }));

  app.get("/api/v2/capabilities", () =>
    v2Data(
      {
        planes: [
          {
            id: "MAINNET_HISTORICAL",
            chainId: SOMNIA_MAINNET_CHAIN_ID,
            label: "Somnia Mainnet historical research",
            writePolicy: "read-only-no-mainnet-signer"
          },
          {
            id: "SHANNON_FORWARD",
            chainId: SOMNIA_SHANNON_CHAIN_ID,
            label: "Somnia Shannon forward observation",
            writePolicy: "read-only-observation"
          },
          {
            id: "SHANNON_EXECUTION",
            chainId: SOMNIA_SHANNON_CHAIN_ID,
            label: "Somnia Shannon execution proof",
            writePolicy: "browser-wallet-human-gated-only"
          }
        ],
        dreamDex: {
          sdkVersion: DREAMDEX_MARKETS_SDK_VERSION,
          mainnetIndexerUrl: historicalDreamDexConfig.indexerUrl,
          shannonIndexerUrl: config.DREAMDEX_INDEXER_URL,
          historicalBookReconstruction: HISTORICAL_BOOK_RECONSTRUCTION_CAPABILITY,
          candleIntervals: HISTORICAL_CANDLE_INTERVAL_SECONDS
        },
        build: {
          commit: config.BUILD_COMMIT,
          workerEnabled: config.WORKER_ENABLED
        }
      },
      { provenance: "server-runtime-config-no-secrets" }
    )
  );

  app.get("/api/v2/policies", () =>
    v2Data(
      {
        policies: policyCatalog(policyAdapters)
      },
      { immutableVersions: true }
    )
  );

  app.post("/api/v2/research-session", async (request, reply) => {
    try {
      const pool = requirePool(deps);
      const ensured = await ensureResearchSession(pool, config, request, reply);
      return v2Data(
        {
          session: {
            id: ensured.session.id,
            expiresAt: ensured.session.expiresAt.toISOString(),
            csrfVersion: ensured.session.csrfVersion
          },
          csrfToken: ensured.csrfToken
        },
        {
          created: ensured.created,
          tokenPolicy: "opaque-session-token-hashed-server-side",
          walletRequired: false
        }
      );
    } catch (error) {
      return v2Error(
        reply,
        503,
        "RESEARCH_SESSION_UNAVAILABLE",
        error instanceof Error ? error.message : "Research session unavailable",
        true,
        request.id
      );
    }
  });

  app.get("/api/v2/experiments", async (request, reply) => {
    try {
      const pool = requirePool(deps);
      const ensured = await ensureResearchSession(pool, config, request, reply);
      const experiments = await listInteractiveExperiments(pool, {
        sessionId: ensured.session.id,
        limit: 20
      });
      return v2Data(
        {
          experiments: experiments.map(serializeExperiment),
          session: {
            id: ensured.session.id,
            expiresAt: ensured.session.expiresAt.toISOString(),
            csrfVersion: ensured.session.csrfVersion
          },
          csrfToken: ensured.csrfToken
        },
        {
          ownership: "research-session",
          walletRequired: false
        }
      );
    } catch (error) {
      return v2Error(
        reply,
        503,
        "EXPERIMENT_LIST_UNAVAILABLE",
        error instanceof Error ? error.message : "Experiment list unavailable",
        true,
        request.id
      );
    }
  });

  app.post("/api/v2/experiments", async (request, reply) => {
    const parsed = ExperimentCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return v2Error(
        reply,
        400,
        "EXPERIMENT_CREATE_INVALID",
        "Experiment configuration is invalid",
        false,
        request.id,
        parsed.error.issues
      );
    }
    let idempotencyKey: string;
    try {
      idempotencyKey = requireIdempotencyKey(request.headers);
    } catch {
      return await v2Error(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required", false, request.id);
    }
    try {
      const pool = requirePool(deps);
      const session = await requireResearchSession(pool, request);
      if (session === null) {
        return await v2Error(reply, 401, "RESEARCH_SESSION_REQUIRED", "Create a research session first", false, request.id);
      }
      if (!requireCsrf(request, session)) {
        return await v2Error(reply, 403, "CSRF_TOKEN_INVALID", "Research-session CSRF token is missing or invalid", false, request.id);
      }
      const policy = policyCatalog(policyAdapters).find(
        (entry) => entry.policyId === parsed.data.policyId && entry.version === parsed.data.policyVersion
      );
      if (policy === undefined) {
        return await v2Error(reply, 400, "POLICY_VERSION_UNSUPPORTED", "Selected policy version is not supported", false, request.id);
      }
      if (!policySupportedInMode(policy.policyId, parsed.data.mode)) {
        return await v2Error(
          reply,
          400,
          "POLICY_PLANE_UNSUPPORTED",
          "Selected policy cannot run in the requested experiment mode",
          false,
          request.id
        );
      }
      const windowFrom = parsed.data.windowFrom === undefined ? null : new Date(parsed.data.windowFrom);
      const windowTo = parsed.data.windowTo === undefined ? null : new Date(parsed.data.windowTo);
      if (windowFrom !== null && windowTo !== null && windowFrom >= windowTo) {
        return await v2Error(reply, 400, "EXPERIMENT_WINDOW_INVALID", "Historical window start must precede end", false, request.id);
      }
      const policyVersionId = await upsertPolicyVersion(pool, {
        policyId: policy.policyId,
        version: policy.version,
        label: policy.label,
        adapterName: policy.adapterName,
        sourceHash: policy.sourceHash,
        manifest: {
          policyId: policy.policyId,
          version: policy.version,
          label: policy.label,
          adapterName: policy.adapterName,
          sourceHash: policy.sourceHash,
          supportedPlanes: policy.supportedPlanes
        }
      });
      const configPayload = {
        sourcePlane: parsed.data.mode === "HISTORICAL_REPLAY" ? "MAINNET_HISTORICAL" : "SHANNON_FORWARD",
        selectedMarketId: parsed.data.marketId ?? null,
        asset: parsed.data.asset,
        intervalSec: parsed.data.intervalSec,
        riskEnvelopeId: parsed.data.riskEnvelopeId,
        policy: {
          policyId: policy.policyId,
          version: policy.version,
          sourceHash: policy.sourceHash
        },
        historicalBookReconstruction: HISTORICAL_BOOK_RECONSTRUCTION_CAPABILITY,
        pnlStatus: "NOT_AVAILABLE"
      };
      const created = await createInteractiveExperiment(pool, {
        sessionId: session.id,
        name: parsed.data.name,
        createIdempotencyKey: idempotencyKey,
        configuration: {
          mode: parsed.data.mode,
          assets: [parsed.data.asset],
          intervals: [parsed.data.intervalSec],
          windowFrom,
          windowTo,
          decisionOffsetSec: parsed.data.decisionOffsetSec,
          ruleVersion: "interactive-2.0.0",
          config: configPayload,
          configHash: sha256(stableJson(configPayload))
        },
        policyVersions: [{ policyVersionId, role: "CANDIDATE" }]
      });
      const experiment = await getInteractiveExperiment(pool, {
        sessionId: session.id,
        experimentId: created.experimentId
      });
      if (experiment === null) {
        return await v2Error(reply, 500, "EXPERIMENT_CREATE_UNREADABLE", "Created experiment could not be reloaded", true, request.id);
      }
      return await reply.code(created.idempotentReplay ? 200 : 201).send(
        v2Data(
          {
            experiment: serializeExperiment(experiment),
            idempotentReplay: created.idempotentReplay
          },
          {
            ownership: "research-session",
            applicationWrite: true,
            blockchainWrite: false
          }
        )
      );
    } catch (error) {
      return v2Error(
        reply,
        503,
        "EXPERIMENT_CREATE_FAILED",
        error instanceof Error ? error.message : "Experiment create failed",
        true,
        request.id
      );
    }
  });

  app.get("/api/v2/experiments/:experimentId", async (request, reply) => {
    const params = z.object({ experimentId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return await v2Error(reply, 400, "EXPERIMENT_ID_INVALID", "Experiment ID is invalid", false, request.id, params.error.issues);
    }
    try {
      const pool = requirePool(deps);
      const ensured = await ensureResearchSession(pool, config, request, reply);
      const experiment = await getInteractiveExperiment(pool, {
        sessionId: ensured.session.id,
        experimentId: params.data.experimentId
      });
      if (experiment === null) {
        return await v2Error(reply, 404, "EXPERIMENT_NOT_FOUND", "Experiment was not found for this research session", false, request.id);
      }
      return v2Data(
        {
          experiment: serializeExperiment(experiment),
          csrfToken: ensured.csrfToken
        },
        {
          ownership: "research-session",
          walletRequired: false
        }
      );
    } catch (error) {
      return v2Error(
        reply,
        503,
        "EXPERIMENT_DETAIL_UNAVAILABLE",
        error instanceof Error ? error.message : "Experiment detail unavailable",
        true,
        request.id
      );
    }
  });

  app.get("/api/v2/experiments/:experimentId/replay", async (request, reply) => {
    const params = z.object({ experimentId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return await v2Error(reply, 400, "EXPERIMENT_ID_INVALID", "Experiment ID is invalid", false, request.id, params.error.issues);
    }
    try {
      const pool = requirePool(deps);
      const ensured = await ensureResearchSession(pool, config, request, reply);
      const replay = await getLatestReplayRunForExperiment(pool, {
        sessionId: ensured.session.id,
        experimentId: params.data.experimentId
      });
      return v2Data(
        {
          replay: replay === null ? null : serializeReplayRun(replay),
          csrfToken: ensured.csrfToken
        },
        {
          ownership: "research-session",
          sourcePlane: "MAINNET_HISTORICAL",
          blockchainWrite: false
        }
      );
    } catch (error) {
      return v2Error(
        reply,
        503,
        "REPLAY_STATE_UNAVAILABLE",
        error instanceof Error ? error.message : "Replay state unavailable",
        true,
        request.id
      );
    }
  });

  app.post("/api/v2/experiments/:experimentId/replay", async (request, reply) => {
    const params = z.object({ experimentId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return await v2Error(reply, 400, "EXPERIMENT_ID_INVALID", "Experiment ID is invalid", false, request.id, params.error.issues);
    }
    let idempotencyKey: string;
    try {
      idempotencyKey = requireIdempotencyKey(request.headers);
    } catch {
      return await v2Error(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required", false, request.id);
    }
    try {
      const pool = requirePool(deps);
      const session = await requireResearchSession(pool, request);
      if (session === null) {
        return await v2Error(reply, 401, "RESEARCH_SESSION_REQUIRED", "Create a research session first", false, request.id);
      }
      if (!requireCsrf(request, session)) {
        return await v2Error(reply, 403, "CSRF_TOKEN_INVALID", "Research-session CSRF token is missing or invalid", false, request.id);
      }
      const experiment = await getInteractiveExperiment(pool, {
        sessionId: session.id,
        experimentId: params.data.experimentId
      });
      if (experiment === null) {
        return await v2Error(reply, 404, "EXPERIMENT_NOT_FOUND", "Experiment was not found for this research session", false, request.id);
      }
      if (experiment.configuration.mode !== "HISTORICAL_REPLAY") {
        return await v2Error(reply, 409, "REPLAY_MODE_REQUIRED", "Only historical replay experiments can run historical qualification", false, request.id);
      }
      const adapter = historicalPolicyAdapter(experiment);
      if (adapter === null) {
        return await v2Error(reply, 409, "HISTORICAL_POLICY_UNSUPPORTED", "Experiment policy is not approved for historical replay", false, request.id);
      }
      const inputHash = experimentReplayInputHash(experiment);
      const existing = await findReplayRunByInputHash(pool, {
        sessionId: session.id,
        experimentId: experiment.experimentId,
        inputHash
      });
      if (existing !== null && existing.status === "SUCCEEDED") {
        const replay = await getLatestReplayRunForExperiment(pool, {
          sessionId: session.id,
          experimentId: experiment.experimentId
        });
        return v2Data(
          { replay: replay === null ? serializeReplayRun(existing) : serializeReplayRun(replay), idempotentReplay: true },
          { applicationWrite: false, blockchainWrite: false, sourcePlane: "MAINNET_HISTORICAL" }
        );
      }
      if (existing !== null && existing.status === "RUNNING") {
        return await v2Error(reply, 409, "REPLAY_ALREADY_RUNNING", "Historical qualification is already running", true, request.id);
      }
      const replayRun = await createReplayRun(pool, {
        experimentId: experiment.experimentId,
        configurationId: experiment.configuration.id,
        frozenNow: new Date(),
        sourceVersion: ReplaySourceVersion,
        queryVersion: ReplayQueryVersion,
        inputHash,
        idempotencyKey,
        capability: HISTORICAL_BOOK_RECONSTRUCTION_CAPABILITY,
        checkpoints: {
          sourcePlane: "MAINNET_HISTORICAL",
          antiLookahead: "STRICTLY_BEFORE_DECISION_AT",
          bookReconstruction: HISTORICAL_BOOK_RECONSTRUCTION_CAPABILITY
        }
      });
      const running = await startReplayRun(pool, replayRun.id);
      let completed: ReplayRunRecord;
      try {
        completed = await executeHistoricalReplay({
          pool,
          replayRun: running,
          experiment,
          historicalDreamDexClient,
          historicalDreamDexConfig,
          ...(deps.historicalIndexerFetch === undefined ? {} : { historicalIndexerFetch: deps.historicalIndexerFetch })
        });
      } catch (error) {
        await failReplayRun(pool, {
          replayRunId: running.id,
          errorCode: error instanceof Error ? error.message.slice(0, 120) : "REPLAY_FAILED",
          checkpoints: {
            sourcePlane: "MAINNET_HISTORICAL",
            failedAt: new Date().toISOString()
          }
        });
        throw error;
      }
      const detail = await getLatestReplayRunForExperiment(pool, {
        sessionId: session.id,
        experimentId: experiment.experimentId
      });
      return v2Data(
        { replay: detail === null ? serializeReplayRun(completed) : serializeReplayRun(detail), idempotentReplay: false },
        {
          applicationWrite: true,
          blockchainWrite: false,
          sourcePlane: "MAINNET_HISTORICAL",
          outcomeEmbargo: "outcomes persisted only after decision frame hashes"
        }
      );
    } catch (error) {
      return v2Error(
        reply,
        503,
        "REPLAY_RUN_FAILED",
        error instanceof Error ? error.message : "Historical replay failed",
        true,
        request.id
      );
    }
  });

  app.get("/api/v2/experiments/:experimentId/evaluation/latest", async (request, reply) => {
    const params = z.object({ experimentId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return await v2Error(reply, 400, "EXPERIMENT_ID_INVALID", "Experiment ID is invalid", false, request.id, params.error.issues);
    }
    try {
      const pool = requirePool(deps);
      const ensured = await ensureResearchSession(pool, config, request, reply);
      const result = await pool.query<{
        assessment_id: string;
        metric_run_id: string;
        verdict: string;
        reason_codes: string[];
        sample_size: number;
        exclusion_count: number;
        brier_score: number | null;
        calibration_bias: number | null;
        neutral_baseline_delta: number | null;
        pnl_status: string;
        evidence_plane: string;
        replay_run_id: string | null;
        promotion_scope: string;
        created_at: Date;
      }>(
        `
          SELECT
            evidence_assessments.id AS assessment_id,
            metric_runs.id AS metric_run_id,
            evidence_assessments.verdict,
            evidence_assessments.reason_codes,
            metric_runs.sample_size,
            metric_runs.exclusion_count,
            metric_runs.brier_score,
            metric_runs.calibration_bias,
            metric_runs.neutral_baseline_delta,
            metric_runs.pnl_status,
            metric_runs.evidence_plane,
            metric_runs.replay_run_id,
            metric_runs.promotion_scope,
            evidence_assessments.created_at
          FROM evidence_assessments
          JOIN metric_runs ON metric_runs.id = evidence_assessments.metric_run_id
          JOIN experiments ON experiments.id = metric_runs.experiment_id
          WHERE experiments.id = $1
            AND experiments.created_by_session_id = $2
          ORDER BY evidence_assessments.created_at DESC
          LIMIT 1
        `,
        [params.data.experimentId, ensured.session.id]
      );
      const row = result.rows[0] ?? null;
      return v2Data(
        {
          assessment:
            row === null
              ? null
              : {
                  assessmentId: row.assessment_id,
                  metricRunId: row.metric_run_id,
                  verdict: row.verdict,
                  reasonCodes: row.reason_codes,
                  sampleSize: row.sample_size,
                  exclusionCount: row.exclusion_count,
                  brierScore: row.brier_score,
                  calibrationBias: row.calibration_bias,
                  neutralBaselineDelta: row.neutral_baseline_delta,
                  pnlStatus: row.pnl_status,
                  evidencePlane: row.evidence_plane,
                  replayRunId: row.replay_run_id,
                  promotionScope: row.promotion_scope,
                  createdAt: row.created_at.toISOString()
                },
          csrfToken: ensured.csrfToken
        },
        { ownership: "research-session", sourcePlane: "MAINNET_HISTORICAL" }
      );
    } catch (error) {
      return v2Error(
        reply,
        503,
        "EVALUATION_STATE_UNAVAILABLE",
        error instanceof Error ? error.message : "Evaluation state unavailable",
        true,
        request.id
      );
    }
  });

  app.post("/api/v2/experiments/:experimentId/evaluate", async (request, reply) => {
    const params = z.object({ experimentId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return await v2Error(reply, 400, "EXPERIMENT_ID_INVALID", "Experiment ID is invalid", false, request.id, params.error.issues);
    }
    try {
      requireIdempotencyKey(request.headers);
    } catch {
      return await v2Error(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required", false, request.id);
    }
    try {
      const pool = requirePool(deps);
      const session = await requireResearchSession(pool, request);
      if (session === null) {
        return await v2Error(reply, 401, "RESEARCH_SESSION_REQUIRED", "Create a research session first", false, request.id);
      }
      if (!requireCsrf(request, session)) {
        return await v2Error(reply, 403, "CSRF_TOKEN_INVALID", "Research-session CSRF token is missing or invalid", false, request.id);
      }
      const experiment = await getInteractiveExperiment(pool, {
        sessionId: session.id,
        experimentId: params.data.experimentId
      });
      if (experiment === null) {
        return await v2Error(reply, 404, "EXPERIMENT_NOT_FOUND", "Experiment was not found for this research session", false, request.id);
      }
      const policy = candidatePolicy(experiment);
      if (policy === null) {
        return await v2Error(reply, 409, "CANDIDATE_POLICY_MISSING", "Experiment has no candidate policy to evaluate", false, request.id);
      }
      const replay = await getLatestReplayRunForExperiment(pool, {
        sessionId: session.id,
        experimentId: experiment.experimentId
      });
      if (replay === null || replay.status !== "SUCCEEDED") {
        return await v2Error(reply, 409, "REPLAY_REQUIRED", "Run historical qualification before evaluating evidence", false, request.id);
      }
      const assessment = await runMetricAssessment({
        pool,
        experimentId: experiment.experimentId,
        policyVersionId: policy.policyVersionId,
        replayRunId: replay.id,
        evidencePlane: "MAINNET_HISTORICAL",
        promotionScope: "HISTORICAL_REPLAY_ONLY",
        ruleVersion: "eval-002-historical-replay-v1",
        provenance: {
          replayRunId: replay.id,
          replayOutputHash: replay.outputHash,
          sourcePlane: "MAINNET_HISTORICAL",
          pnlLabel: "REPLAY_COUNTERFACTUAL_OR_NOT_AVAILABLE",
          bookReconstruction: HISTORICAL_BOOK_RECONSTRUCTION_CAPABILITY
        }
      });
      return v2Data(
        { assessment },
        {
          applicationWrite: true,
          blockchainWrite: false,
          sourcePlane: "MAINNET_HISTORICAL",
          verdictAuthority: "server-evaluation-engine"
        }
      );
    } catch (error) {
      return v2Error(
        reply,
        503,
        "EVALUATION_FAILED",
        error instanceof Error ? error.message : "Evaluation failed",
        true,
        request.id
      );
    }
  });

  app.get("/api/v2/experiments/:experimentId/live-shadow", async (request, reply) => {
    const params = z.object({ experimentId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return await v2Error(reply, 400, "EXPERIMENT_ID_INVALID", "Experiment ID is invalid", false, request.id, params.error.issues);
    }
    try {
      const pool = requirePool(deps);
      const ensured = await ensureResearchSession(pool, config, request, reply);
      const experiment = await getInteractiveExperiment(pool, {
        sessionId: ensured.session.id,
        experimentId: params.data.experimentId
      });
      if (experiment === null) {
        return await v2Error(reply, 404, "EXPERIMENT_NOT_FOUND", "Experiment was not found for this research session", false, request.id);
      }
      return v2Data(
        {
          liveShadow: await loadLiveShadowState(pool, {
            sessionId: ensured.session.id,
            experimentId: params.data.experimentId
          }),
          csrfToken: ensured.csrfToken
        },
        { sourcePlane: "SHANNON_FORWARD", ownership: "research-session", blockchainWrite: false }
      );
    } catch (error) {
      return v2Error(
        reply,
        503,
        "LIVE_SHADOW_STATE_UNAVAILABLE",
        error instanceof Error ? error.message : "Live-shadow state unavailable",
        true,
        request.id
      );
    }
  });

  app.post("/api/v2/experiments/:experimentId/live-shadow/observe", async (request, reply) => {
    const params = z.object({ experimentId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return await v2Error(reply, 400, "EXPERIMENT_ID_INVALID", "Experiment ID is invalid", false, request.id, params.error.issues);
    }
    let idempotencyKey: string;
    try {
      idempotencyKey = requireIdempotencyKey(request.headers);
    } catch {
      return await v2Error(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required", false, request.id);
    }
    try {
      const pool = requirePool(deps);
      const session = await requireResearchSession(pool, request);
      if (session === null) {
        return await v2Error(reply, 401, "RESEARCH_SESSION_REQUIRED", "Create a research session first", false, request.id);
      }
      if (!requireCsrf(request, session)) {
        return await v2Error(reply, 403, "CSRF_TOKEN_INVALID", "Research-session CSRF token is missing or invalid", false, request.id);
      }
      const experiment = await getInteractiveExperiment(pool, {
        sessionId: session.id,
        experimentId: params.data.experimentId
      });
      if (experiment === null) {
        return await v2Error(reply, 404, "EXPERIMENT_NOT_FOUND", "Experiment was not found for this research session", false, request.id);
      }
      if (experiment.configuration.mode !== "LIVE_SHADOW") {
        return await v2Error(reply, 409, "LIVE_SHADOW_MODE_REQUIRED", "Only live-shadow experiments can capture forward observations", false, request.id);
      }
      const dreamDex = requireDreamDex(deps);
      const assets = experiment.configuration.assets.filter((asset): asset is "BTC" | "ETH" => asset === "BTC" || asset === "ETH");
      const result = await observeExperiment({
        pool,
        dreamDexClient: dreamDex.client,
        dreamDexConfig: dreamDex.config,
        experimentId: experiment.experimentId,
        policyAdapters,
        holderId: idempotencyKey,
        assets,
        intervals: experiment.configuration.intervals
      });
      return v2Data(
        {
          observation: result,
          liveShadow: await loadLiveShadowState(pool, {
            sessionId: session.id,
            experimentId: experiment.experimentId
          })
        },
        {
          applicationWrite: true,
          blockchainWrite: false,
          sourcePlane: "SHANNON_FORWARD",
          preOutcomeBoundary: "shadow decision insert guarded before market expiry"
        }
      );
    } catch (error) {
      return v2Error(
        reply,
        503,
        "LIVE_SHADOW_OBSERVE_FAILED",
        error instanceof Error ? error.message : "Live-shadow observation failed",
        true,
        request.id
      );
    }
  });

  app.get("/api/v2/assessments", async (request, reply) => {
    try {
      const pool = requirePool(deps);
      const ensured = await ensureResearchSession(pool, config, request, reply);
      const assessments = await loadOwnedAssessmentSummaries(pool, {
        sessionId: ensured.session.id,
        limit: 20
      });
      return v2Data(
        {
          assessments: assessments.map(serializeAssessmentSummary),
          csrfToken: ensured.csrfToken
        },
        { ownership: "research-session", comparisonSource: "immutable-assessments" }
      );
    } catch (error) {
      return v2Error(
        reply,
        503,
        "ASSESSMENT_LIST_UNAVAILABLE",
        error instanceof Error ? error.message : "Assessment list unavailable",
        true,
        request.id
      );
    }
  });

  app.post("/api/v2/comparisons", async (request, reply) => {
    const parsed = ComparisonCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return await v2Error(reply, 400, "COMPARISON_CREATE_INVALID", "Comparison request is invalid", false, request.id, parsed.error.issues);
    }
    let idempotencyKey: string;
    try {
      idempotencyKey = requireIdempotencyKey(request.headers);
    } catch {
      return await v2Error(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required", false, request.id);
    }
    try {
      const pool = requirePool(deps);
      const session = await requireResearchSession(pool, request);
      if (session === null) {
        return await v2Error(reply, 401, "RESEARCH_SESSION_REQUIRED", "Create a research session first", false, request.id);
      }
      if (!requireCsrf(request, session)) {
        return await v2Error(reply, 403, "CSRF_TOKEN_INVALID", "Research-session CSRF token is missing or invalid", false, request.id);
      }
      const uniqueIds = [...new Set(parsed.data.assessmentIds)];
      if (uniqueIds.length !== parsed.data.assessmentIds.length) {
        return await v2Error(reply, 400, "COMPARISON_DUPLICATE_ASSESSMENT", "Comparison assessment IDs must be unique", false, request.id);
      }
      const owned = await loadOwnedAssessmentSummaries(pool, {
        sessionId: session.id,
        assessmentIds: uniqueIds,
        limit: uniqueIds.length
      });
      if (owned.length !== uniqueIds.length) {
        return await v2Error(reply, 404, "ASSESSMENT_NOT_FOUND", "One or more assessments are unavailable for this session", false, request.id);
      }
      const client = await pool.connect();
      let comparisonId: string;
      try {
        await client.query("BEGIN");
        const existing = await client.query<{ id: string }>(
          `
            SELECT id
            FROM comparison_sets
            WHERE created_by_session_id = $1
              AND name = $2
            ORDER BY created_at DESC
            LIMIT 1
          `,
          [session.id, `${parsed.data.name}#${idempotencyKey}`]
        );
        const existingRow = existing.rows[0];
        if (existingRow === undefined) {
          const comparison = await client.query<{ id: string }>(
            `
              INSERT INTO comparison_sets(created_by_session_id, name)
              VALUES ($1, $2)
              RETURNING id
            `,
            [session.id, `${parsed.data.name}#${idempotencyKey}`]
          );
          comparisonId = comparison.rows[0]?.id ?? "";
          for (const [displayOrder, assessmentId] of parsed.data.assessmentIds.entries()) {
            await client.query(
              `
                INSERT INTO comparison_items(comparison_set_id, assessment_id, display_order)
                VALUES ($1, $2, $3)
              `,
              [comparisonId, assessmentId, displayOrder]
            );
          }
        } else {
          comparisonId = existingRow.id;
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      const comparison = await loadComparison(pool, { sessionId: session.id, comparisonId });
      return v2Data(
        { comparison },
        { applicationWrite: true, blockchainWrite: false, comparisonSource: "immutable-assessments" }
      );
    } catch (error) {
      return v2Error(
        reply,
        503,
        "COMPARISON_CREATE_FAILED",
        error instanceof Error ? error.message : "Comparison create failed",
        true,
        request.id
      );
    }
  });

  app.get("/api/v2/comparisons/:comparisonId", async (request, reply) => {
    const params = z.object({ comparisonId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return await v2Error(reply, 400, "COMPARISON_ID_INVALID", "Comparison ID is invalid", false, request.id, params.error.issues);
    }
    try {
      const pool = requirePool(deps);
      const ensured = await ensureResearchSession(pool, config, request, reply);
      const comparison = await loadComparison(pool, {
        sessionId: ensured.session.id,
        comparisonId: params.data.comparisonId
      });
      if (comparison === null) {
        return await v2Error(reply, 404, "COMPARISON_NOT_FOUND", "Comparison was not found for this research session", false, request.id);
      }
      return v2Data(
        { comparison, csrfToken: ensured.csrfToken },
        { ownership: "research-session", comparisonSource: "immutable-assessments" }
      );
    } catch (error) {
      return v2Error(
        reply,
        503,
        "COMPARISON_DETAIL_UNAVAILABLE",
        error instanceof Error ? error.message : "Comparison detail unavailable",
        true,
        request.id
      );
    }
  });

  app.get("/api/v2/mainnet/history/markets/count", async (request, reply) => {
    const parsed = HistoricalMarketQuerySchema.omit({ limit: true, offset: true }).safeParse(request.query);
    if (!parsed.success) {
      return v2Error(reply, 400, "HISTORICAL_FILTER_INVALID", "Historical market count filters are invalid", false, request.id, parsed.error.issues);
    }
    const result = await countHistoricalBinaryMarkets(
      historicalDreamDexClient,
      historicalDreamDexConfig,
      compactHistoricalMarketFilters(parsed.data)
    );
    if (!result.ok) {
      return v2Error(
        reply,
        historicalErrorStatus(result),
        result.reasonCode,
        result.message,
        historicalErrorRetryable(result),
        request.id
      );
    }
    return v2Data(
      {
        count: result.value.count,
        countRelation: result.value.count >= 10_000 ? "AT_LEAST" : "EXACT"
      },
      { source: result.value.source }
    );
  });

  app.get("/api/v2/mainnet/history/markets", async (request, reply) => {
    const parsed = HistoricalMarketQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return v2Error(reply, 400, "HISTORICAL_FILTER_INVALID", "Historical market filters are invalid", false, request.id, parsed.error.issues);
    }
    const result = await listHistoricalBinaryMarkets(
      historicalDreamDexClient,
      historicalDreamDexConfig,
      compactHistoricalMarketFilters(parsed.data)
    );
    if (!result.ok) {
      return v2Error(
        reply,
        historicalErrorStatus(result),
        result.reasonCode,
        result.message,
        historicalErrorRetryable(result),
        request.id
      );
    }
    return v2Data(
      { markets: result.value.rows },
      {
        page: result.value.page,
        hasMore: result.value.hasMore,
        excludedMalformedRows: result.value.excludedMalformedRows,
        countRelation: "UNKNOWN",
        source: result.value.source
      }
    );
  });

  app.get("/api/v2/mainnet/history/markets/:marketId", async (request, reply) => {
    const params = z.object({ marketId: MarketIdSchema }).safeParse(request.params);
    if (!params.success) {
      return v2Error(reply, 400, "HISTORICAL_MARKET_ID_INVALID", "Historical market ID is invalid", false, request.id, params.error.issues);
    }
    const result = await getHistoricalBinaryMarket(historicalDreamDexClient, historicalDreamDexConfig, params.data.marketId);
    if (!result.ok) {
      return v2Error(
        reply,
        historicalErrorStatus(result),
        result.reasonCode,
        result.message,
        historicalErrorRetryable(result),
        request.id
      );
    }
    if (result.value === null) {
      return v2Error(reply, 404, "HISTORICAL_MARKET_NOT_FOUND", "Historical market was not found", false, request.id);
    }
    return v2Data({ market: result.value }, { source: result.value.source });
  });

  app.get("/api/v2/mainnet/history/markets/:marketId/resolution", async (request, reply) => {
    const params = z.object({ marketId: MarketIdSchema }).safeParse(request.params);
    if (!params.success) {
      return v2Error(reply, 400, "HISTORICAL_MARKET_ID_INVALID", "Historical market ID is invalid", false, request.id, params.error.issues);
    }
    const result = await getHistoricalMarketResolution(historicalDreamDexClient, historicalDreamDexConfig, params.data.marketId);
    if (!result.ok) {
      return v2Error(
        reply,
        historicalErrorStatus(result),
        result.reasonCode,
        result.message,
        historicalErrorRetryable(result),
        request.id
      );
    }
    return v2Data({ resolution: result.value }, { usage: "display-only-not-policy-input", source: result.value.source });
  });

  app.get("/api/v2/mainnet/history/markets/:marketId/status-history", async (request, reply) => {
    const params = z.object({ marketId: MarketIdSchema }).safeParse(request.params);
    if (!params.success) {
      return v2Error(reply, 400, "HISTORICAL_MARKET_ID_INVALID", "Historical market ID is invalid", false, request.id, params.error.issues);
    }
    const result = await getHistoricalMarketStatusHistory(historicalDreamDexClient, historicalDreamDexConfig, params.data.marketId);
    if (!result.ok) {
      return v2Error(
        reply,
        historicalErrorStatus(result),
        result.reasonCode,
        result.message,
        historicalErrorRetryable(result),
        request.id
      );
    }
    return v2Data({ statusHistory: result.value }, { source: result.value[0]?.source ?? null });
  });

  app.get("/api/v2/mainnet/history/markets/:marketId/candles", async (request, reply) => {
    const params = z.object({ marketId: MarketIdSchema }).safeParse(request.params);
    const query = HistoricalCandleQuerySchema.safeParse(request.query);
    if (!params.success) {
      return v2Error(reply, 400, "HISTORICAL_MARKET_ID_INVALID", "Historical market ID is invalid", false, request.id, params.error.issues);
    }
    if (!query.success) {
      return v2Error(reply, 400, "HISTORICAL_CANDLE_QUERY_INVALID", "Historical candle query is invalid", false, request.id, query.error.issues);
    }
    const market = await getHistoricalBinaryMarket(historicalDreamDexClient, historicalDreamDexConfig, params.data.marketId);
    if (!market.ok) {
      return v2Error(
        reply,
        historicalErrorStatus(market),
        market.reasonCode,
        market.message,
        historicalErrorRetryable(market),
        request.id
      );
    }
    if (market.value === null) {
      return v2Error(reply, 404, "HISTORICAL_MARKET_NOT_FOUND", "Historical market was not found", false, request.id);
    }
    const candles = await listHistoricalCandles(
      historicalDreamDexClient,
      historicalDreamDexConfig,
      market.value.poolAddress,
      query.data.intervalSeconds,
      compactHistoricalCandleQuery(query.data)
    );
    if (!candles.ok) {
      return v2Error(
        reply,
        historicalErrorStatus(candles),
        candles.reasonCode,
        candles.message,
        historicalErrorRetryable(candles),
        request.id
      );
    }
    return v2Data({ candles: candles.value }, { marketId: market.value.stableMarketId, source: market.value.source });
  });

  app.get("/api/v2/mainnet/history/markets/:marketId/orders", async (request, reply) => {
    const params = z.object({ marketId: MarketIdSchema }).safeParse(request.params);
    const query = HistoricalPageQuerySchema.safeParse(request.query);
    if (!params.success) {
      return v2Error(reply, 400, "HISTORICAL_MARKET_ID_INVALID", "Historical market ID is invalid", false, request.id, params.error.issues);
    }
    if (!query.success) {
      return v2Error(reply, 400, "HISTORICAL_PAGE_INVALID", "Historical order page is invalid", false, request.id, query.error.issues);
    }
    const result = await listHistoricalOrdersByMarket(
      historicalDreamDexConfig,
      params.data.marketId,
      compactHistoricalPage(query.data),
      deps.historicalIndexerFetch
    );
    if (!result.ok) {
      return v2Error(
        reply,
        historicalErrorStatus(result),
        result.reasonCode,
        result.message,
        historicalErrorRetryable(result),
        request.id
      );
    }
    return v2Data(
      { orders: result.value.rows },
      { page: result.value.page, hasMore: result.value.hasMore, source: result.value.source }
    );
  });

  app.get("/api/v2/mainnet/history/markets/:marketId/fills", async (request, reply) => {
    const params = z.object({ marketId: MarketIdSchema }).safeParse(request.params);
    const query = HistoricalPageQuerySchema.safeParse(request.query);
    if (!params.success) {
      return v2Error(reply, 400, "HISTORICAL_MARKET_ID_INVALID", "Historical market ID is invalid", false, request.id, params.error.issues);
    }
    if (!query.success) {
      return v2Error(reply, 400, "HISTORICAL_PAGE_INVALID", "Historical fill page is invalid", false, request.id, query.error.issues);
    }
    const result = await listHistoricalFillsByMarket(
      historicalDreamDexConfig,
      params.data.marketId,
      compactHistoricalPage(query.data),
      deps.historicalIndexerFetch
    );
    if (!result.ok) {
      return v2Error(
        reply,
        historicalErrorStatus(result),
        result.reasonCode,
        result.message,
        historicalErrorRetryable(result),
        request.id
      );
    }
    return v2Data(
      { fills: result.value.rows },
      { page: result.value.page, hasMore: result.value.hasMore, source: result.value.source }
    );
  });

  app.get("/api/v2/mainnet/history/markets/:marketId/reconstructed-book", (request, reply) => {
    const params = z.object({ marketId: MarketIdSchema }).safeParse(request.params);
    if (!params.success) {
      return v2Error(reply, 400, "HISTORICAL_MARKET_ID_INVALID", "Historical market ID is invalid", false, request.id, params.error.issues);
    }
    const capability = getHistoricalReconstructedBookCapability();
    return v2Error(
      reply,
      409,
      capability.ok ? "BOOK_RECONSTRUCTION_UNEXPECTEDLY_AVAILABLE" : capability.reasonCode,
      capability.ok ? "Historical book reconstruction capability is inconsistent" : capability.message,
      false,
      request.id,
      {
        capability: HISTORICAL_BOOK_RECONSTRUCTION_CAPABILITY,
        marketId: params.data.marketId.toLowerCase(),
        label: "reconstructed historical resting book",
        nativeStoredSnapshots: false
      }
    );
  });

  app.get("/api/v2/shannon/markets/live", async (request, reply) => {
    try {
      const dreamDex = requireDreamDex(deps);
      const result = await discoverSuccessorMarkets(dreamDex.client, dreamDex.config);
      if (!result.ok) {
        return await v2Error(reply, 502, result.reasonCode, result.message, true, request.id);
      }
      return v2Data({ markets: result.value }, { plane: "SHANNON_FORWARD", chainId: SOMNIA_SHANNON_CHAIN_ID });
    } catch (error) {
      return v2Error(
        reply,
        503,
        "DREAMDEX_UNAVAILABLE",
        error instanceof Error ? error.message : "DreamDEX unavailable",
        true,
        request.id
      );
    }
  });

  app.post("/api/v1/auth/challenge", (request, reply) => {
    const parsed = ChallengeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, reasonCode: "BAD_REQUEST", issues: parsed.error.issues });
    }
    const base = {
      domain: new URL(config.PUBLIC_APP_URL).host,
      uri: config.PUBLIC_APP_URL,
      account: parsed.data.account
    };
    const challenge =
      parsed.data.purpose === "login"
        ? createLoginChallenge(base)
        : createApprovalChallenge({ ...base, intentHash: parsed.data.intentHash });
    return { ok: true, challenge };
  });

  app.post("/api/v1/auth/verify", async (request, reply) => {
    const parsed = VerifyRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, reasonCode: "BAD_REQUEST", issues: parsed.error.issues });
    }
    const verificationInput = {
      challenge: parsed.data.challenge,
      signature: parsed.data.signature,
      expectedDomain: new URL(config.PUBLIC_APP_URL).host,
      expectedUri: config.PUBLIC_APP_URL,
      expectedAccount: parsed.data.account,
      consumedNonces
    };
    const result = await verifyChallenge(
      deps.signatureVerifier === undefined
        ? verificationInput
        : { ...verificationInput, verifier: deps.signatureVerifier }
    );
    if (!result.ok) {
      return reply.code(401).send({ ok: false, reasonCode: result.reasonCode, message: result.message });
    }
    consumedNonces.add(result.nonce);
    return { ok: true, account: result.account };
  });

  app.get("/api/v1/dreamdex/markets", async (request, reply) => {
    try {
      const dreamDex = requireDreamDex(deps);
      const result = await discoverSuccessorMarkets(dreamDex.client, dreamDex.config);
      if (!result.ok) {
        return await reply.code(502).send(result);
      }
      return { ok: true, markets: result.value };
    } catch (error) {
      return reply.code(503).send({
        ok: false,
        reasonCode: "DREAMDEX_UNAVAILABLE",
        message: error instanceof Error ? error.message : "DreamDEX unavailable"
      });
    }
  });

  app.get("/api/v1/evidence/summary", async (request, reply) => {
    try {
      const pool = requirePool(deps);
      const result = await pool.query<{
        experiments: string;
        episodes: string;
        snapshots: string;
        decisions: string;
        settlements: string;
        metric_runs: string;
        assessments: string;
      }>(
        `
          SELECT
            (SELECT count(*) FROM experiments) AS experiments,
            (SELECT count(*) FROM market_episodes) AS episodes,
            (SELECT count(*) FROM market_snapshots) AS snapshots,
            (SELECT count(*) FROM shadow_decisions) AS decisions,
            (SELECT count(*) FROM settlements) AS settlements,
            (SELECT count(*) FROM metric_runs) AS metric_runs,
            (SELECT count(*) FROM evidence_assessments) AS assessments
        `
      );
      const row = result.rows[0];
      const chain = await summarizeChainEvidence(pool);
      return {
        ok: true,
        counts: {
          experiments: Number(row?.experiments ?? 0),
          episodes: Number(row?.episodes ?? 0),
          snapshots: Number(row?.snapshots ?? 0),
          decisions: Number(row?.decisions ?? 0),
          settlements: Number(row?.settlements ?? 0),
          metricRuns: Number(row?.metric_runs ?? 0),
          assessments: Number(row?.assessments ?? 0)
        },
        chain
      };
    } catch (error) {
      return reply.code(503).send({
        ok: false,
        reasonCode: "DATABASE_UNAVAILABLE",
        message: error instanceof Error ? error.message : "Database unavailable"
      });
    }
  });

  app.post("/api/v1/experiments/:experimentId/observe", async (request, reply) => {
    try {
      const holderId = requireIdempotencyKey(request.headers);
      const pool = requirePool(deps);
      const dreamDex = requireDreamDex(deps);
      const params = z.object({ experimentId: z.string().uuid() }).parse(request.params);
      return await observeExperiment({
        pool,
        dreamDexClient: dreamDex.client,
        dreamDexConfig: dreamDex.config,
        experimentId: params.experimentId,
        policyAdapters,
        holderId
      });
    } catch (error) {
      return reply.code(400).send({
        ok: false,
        reasonCode: "OBSERVE_REQUEST_REJECTED",
        message: error instanceof Error ? error.message : "Observation request rejected"
      });
    }
  });

  app.post("/api/v1/settlements/reconcile", async (request, reply) => {
    try {
      const holderId = requireIdempotencyKey(request.headers);
      const pool = requirePool(deps);
      const dreamDex = requireDreamDex(deps);
      return await reconcileSettlements({ pool, dreamDexClient: dreamDex.client, holderId });
    } catch (error) {
      return reply.code(400).send({
        ok: false,
        reasonCode: "SETTLEMENT_REQUEST_REJECTED",
        message: error instanceof Error ? error.message : "Settlement request rejected"
      });
    }
  });

  app.post("/api/v1/experiments/:experimentId/evaluate", async (request, reply) => {
    try {
      requireIdempotencyKey(request.headers);
      const pool = requirePool(deps);
      const params = z.object({ experimentId: z.string().uuid() }).parse(request.params);
      const body = EvaluateRequestSchema.parse(request.body);
      return {
        ok: true,
        assessment: await runMetricAssessment({
          pool,
          experimentId: params.experimentId,
          policyVersionId: body.policyVersionId,
          ruleVersion: body.ruleVersion
        })
      };
    } catch (error) {
      return reply.code(400).send({
        ok: false,
        reasonCode: "EVALUATE_REQUEST_REJECTED",
        message: error instanceof Error ? error.message : "Evaluation request rejected"
      });
    }
  });

  return app;
}
