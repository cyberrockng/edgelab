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
  appendAuditEvent,
  blockReplayRun,
  cancelReplayRun,
  completeReplayRun,
  countComparisonSets,
  countInteractiveExperiments,
  countReplayRuns,
  createInteractiveExperiment,
  createReplayRun,
  createResearchSession,
  failReplayRun,
  findReplayRunByInputHash,
  findActiveResearchSessionByTokenHash,
  getInteractiveExperiment,
  getLatestReplayRunForExperiment,
  getOwnedReplayRun,
  listInteractiveExperiments,
  persistHistoricalSourceManifest,
  persistReplayDecision,
  persistReplayOutcome,
  revokeResearchSession,
  startReplayRun,
  updateReplayProgress,
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
  resolveHistoricalCutoffBlock,
  type DreamDexReadConfig,
  type DreamDexSdkClient,
  type HistoricalDreamDexReadResult,
  type HistoricalDreamDexSdkClient,
  type HistoricalCandleEvidence,
  type HistoricalIndexerFetch,
  type HistoricalRpcFetch,
  type HistoricalMarketEvidence,
  type HistoricalMarketFilters,
  type HistoricalPageOptions,
  type HistoricalRowsPage,
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
import { z } from "zod";

export interface AppDependencies {
  readonly pool?: pg.Pool;
  readonly dreamDexClient?: DreamDexSdkClient;
  readonly dreamDexConfig?: DreamDexReadConfig;
  readonly historicalDreamDexClient?: HistoricalDreamDexSdkClient;
  readonly historicalDreamDexConfig?: MainnetHistoricalDreamDexConfig;
  readonly historicalIndexerFetch?: HistoricalIndexerFetch;
  readonly historicalRpcFetch?: HistoricalRpcFetch;
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
const PublicReadRateLimit = 240;
const PublicWriteRateLimit = 60;
const ResearchSessionCreateRateLimit = 30;
const RateWindowMs = 60_000;
const MaxExperimentsPerSession = 20;
const MaxReplayRunsPerSession = 20;
const MaxComparisonsPerSession = 10;
const ModuleDir = dirname(fileURLToPath(import.meta.url));
const ExperimentIntervalSecSchema = z.union([z.literal(900), z.literal(3600)]);
const ExperimentCreateSchema = z.object({
  name: z.string().trim().min(3).max(80),
  mode: z.enum(["HISTORICAL_REPLAY", "LIVE_SHADOW"]),
  asset: z.enum(["BTC", "ETH"]),
  intervalSec: ExperimentIntervalSecSchema,
  policyId: z.string().min(1),
  policyVersion: z.string().min(1),
  marketId: MarketIdSchema.optional(),
  windowFrom: z.iso.datetime().optional(),
  windowTo: z.iso.datetime().optional(),
  decisionOffsetSec: z.number().int().min(60).max(3600).default(60),
  riskEnvelopeId: z.literal("WATCH_ONLY_BOUNDED").default("WATCH_ONLY_BOUNDED")
});
const HistoricalMarketQuerySchema = z.object({
  asset: z.enum(["BTC", "ETH"]).optional(),
  intervalSec: z.coerce.number().int().positive().optional(),
  status: z.enum(["Resolved", "Finalized"]).optional(),
  fromSec: z.coerce.number().int().nonnegative().optional(),
  toSec: z.coerce.number().int().nonnegative().optional(),
  frozenAtSec: z.coerce.number().int().positive().optional(),
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

function requestIp(request: FastifyRequest): string {
  return request.ip;
}

function rateKey(request: FastifyRequest): string {
  const path = new URL(request.url, "http://localhost").pathname;
  if (!path.startsWith("/api/")) {
    return "unlimited-page";
  }
  const bucket =
    request.method === "POST" && path === "/api/v2/research-session"
      ? "session-create"
      : ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)
        ? "write"
        : path.startsWith("/api/")
          ? "api-read"
          : "page";
  return `${bucket}:${requestIp(request)}`;
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

function withoutSource<T extends { readonly source: unknown }>(input: T): Omit<T, "source"> {
  const { source, ...rest } = input;
  void source;
  return rest;
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
): Promise<{ readonly session: ResearchSessionRecord; readonly csrfToken?: string; readonly created: boolean }> {
  const rawSessionToken = readSignedSessionToken(request);
  if (rawSessionToken !== null) {
    const existing = await findActiveResearchSessionByTokenHash(pool, sha256(rawSessionToken));
    if (existing !== null) {
      reply.setCookie(ResearchSessionCookie, rawSessionToken, sessionCookieOptions(config));
      return { session: existing, created: false };
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

async function writeAudit(
  pool: pg.Pool,
  input: {
    readonly sessionId: string;
    readonly action: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly outcome: string;
    readonly correlationId: string;
    readonly safeMetadata?: Record<string, unknown>;
  }
): Promise<void> {
  await appendAuditEvent(pool, {
    actor: `research-session:${input.sessionId}`,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    outcome: input.outcome,
    correlationId: input.correlationId,
    ...(input.safeMetadata === undefined ? {} : { safeMetadata: input.safeMetadata })
  });
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
  if (policyId === "reference-neutral") {
    return ["SHANNON_FORWARD"];
  }
  if (policyId === "historical-last-trade") {
    return ["MAINNET_HISTORICAL"];
  }
  return ["MAINNET_HISTORICAL", "SHANNON_FORWARD"];
}

function policySupportedInMode(
  policyId: string,
  version: string,
  mode: "HISTORICAL_REPLAY" | "LIVE_SHADOW"
): boolean {
  if (policyId === "historical-last-trade" && version === "1.0.0") {
    return false;
  }
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
  readonly implementationHash: string;
  readonly parameters: Readonly<Record<string, unknown>>;
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
      adapter.version === "1.0.0"
        ? "Superseded historical identity retained for reproducibility only. New evidence must use 1.1.0."
        : "Uses only the latest verified pre-cutoff DreamDEX YES-term fill in the last 15 minutes; abstains when no qualifying fill exists."
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
    ...(input.fromSec === undefined ? {} : { fromSec: input.fromSec }),
    ...(input.toSec === undefined ? {} : { toSec: input.toSec }),
    ...(input.frozenAtSec === undefined ? {} : { frozenAtSec: input.frozenAtSec }),
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

const ReplaySourceVersion = "dreamdex-mainnet-history@0.28.1";
const ReplayQueryVersion = "replay-003-remediation-v2";
const ReplayMaxMarkets = 100;
const ReplayPageLimit = 100;
const ReplayMaxMarketScanRows = 1_000;
const ReplayMaxSourceRows = 10_000;
const HistoricalReplayPageTimeoutMs = 15_000;

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

async function withHistoricalReplayTimeout<T>(
  operation: Promise<HistoricalDreamDexReadResult<T>>,
  label: string
): Promise<HistoricalDreamDexReadResult<T>> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutResult = new Promise<HistoricalDreamDexReadResult<T>>((resolve) => {
    timeout = setTimeout(() => {
      resolve({
        ok: false,
        reasonCode: "DREAMDEX_HISTORICAL_READ_FAILED",
        message: `HISTORICAL_REPLAY_SOURCE_TIMEOUT: ${label} exceeded ${String(HistoricalReplayPageTimeoutMs)}ms`
      });
    }, HistoricalReplayPageTimeoutMs);
  });
  try {
    return await Promise.race([operation, timeoutResult]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function fetchPagedHistoricalRows<T>(
  readPage: (page: HistoricalPageOptions) => Promise<HistoricalDreamDexReadResult<HistoricalRowsPage<T>>>,
  maxRows: number,
  label = "historical rows"
): Promise<HistoricalDreamDexReadResult<{ readonly rows: readonly T[]; readonly hasMore: boolean }>> {
  const rows: T[] = [];
  let offset = 0;
  let hasMore = true;
  while (hasMore && rows.length < maxRows) {
    const page = await withHistoricalReplayTimeout(
      readPage({ limit: Math.min(ReplayPageLimit, maxRows - rows.length), offset }),
      `${label} page offset ${String(offset)}`
    );
    if (!page.ok) {
      return page;
    }
    rows.push(...page.value.rows);
    hasMore = page.value.hasMore;
    offset += page.value.page.limit;
  }
  return { ok: true, value: { rows, hasMore } };
}

async function fetchPagedHistoricalCandles(
  readPage: (page: HistoricalPageOptions) => Promise<HistoricalDreamDexReadResult<readonly HistoricalCandleEvidence[]>>,
  maxRows: number,
  label = "historical candles"
): Promise<HistoricalDreamDexReadResult<{ readonly rows: readonly HistoricalCandleEvidence[]; readonly hasMore: boolean }>> {
  const rows: HistoricalCandleEvidence[] = [];
  let offset = 0;
  let hasMore = true;
  while (hasMore && rows.length < maxRows) {
    const limit = Math.min(ReplayPageLimit, maxRows - rows.length);
    const page = await withHistoricalReplayTimeout(readPage({ limit, offset }), `${label} page offset ${String(offset)}`);
    if (!page.ok) {
      return page;
    }
    rows.push(...page.value);
    hasMore = page.value.length === limit;
    offset += page.value.length;
  }
  return { ok: true, value: { rows, hasMore } };
}

interface HistoricalReplayMarketSelection {
  readonly markets: readonly HistoricalMarketEvidence[];
  readonly pagesRead: number;
  readonly scannedCount: number;
  readonly duplicateCount: number;
  readonly filteredCount: number;
  readonly sourceCompleteness: "COMPLETE";
  readonly windowFromSeconds: number | null;
  readonly windowToSeconds: number | null;
  readonly explicitMarketId: string | null;
}

function replayWindowSeconds(experiment: InteractiveExperimentDetailRecord): {
  readonly fromSeconds: number | null;
  readonly toSeconds: number | null;
} {
  return {
    fromSeconds:
      experiment.configuration.windowFrom === null
        ? null
        : Math.floor(experiment.configuration.windowFrom.getTime() / 1000),
    toSeconds:
      experiment.configuration.windowTo === null
        ? null
        : Math.floor(experiment.configuration.windowTo.getTime() / 1000)
  };
}

function marketIntersectsReplayWindow(
  market: HistoricalMarketEvidence,
  window: { readonly fromSeconds: number | null; readonly toSeconds: number | null }
): boolean {
  return (
    (window.fromSeconds === null || market.expirySeconds >= window.fromSeconds) &&
    (window.toSeconds === null || market.tradingStartSeconds <= window.toSeconds)
  );
}

function replayDecisionAtSeconds(market: HistoricalMarketEvidence, decisionOffsetSec: number): number {
  return Math.max(market.tradingStartSeconds + 1, market.expirySeconds - decisionOffsetSec);
}

function marketDecisionFallsWithinReplayWindow(
  market: HistoricalMarketEvidence,
  window: { readonly fromSeconds: number | null; readonly toSeconds: number | null },
  decisionOffsetSec: number
): boolean {
  const decisionAtSeconds = replayDecisionAtSeconds(market, decisionOffsetSec);
  return (
    (window.fromSeconds === null || decisionAtSeconds >= window.fromSeconds) &&
    (window.toSeconds === null || decisionAtSeconds <= window.toSeconds)
  );
}

async function selectHistoricalReplayMarkets(input: {
  readonly experiment: InteractiveExperimentDetailRecord;
  readonly client: HistoricalDreamDexSdkClient;
  readonly config: MainnetHistoricalDreamDexConfig;
}): Promise<HistoricalDreamDexReadResult<HistoricalReplayMarketSelection>> {
  const window = replayWindowSeconds(input.experiment);
  const explicitMarketId = selectedMarketId(input.experiment);
  if (explicitMarketId !== null) {
    const market = await getHistoricalBinaryMarket(input.client, input.config, explicitMarketId);
    if (!market.ok) {
      return market;
    }
    if (market.value === null) {
      return {
        ok: true,
        value: {
          markets: [],
          pagesRead: 0,
          scannedCount: 0,
          duplicateCount: 0,
          filteredCount: 0,
          sourceCompleteness: "COMPLETE",
          windowFromSeconds: window.fromSeconds,
          windowToSeconds: window.toSeconds,
          explicitMarketId
        }
      };
    }
    if (
      !marketIntersectsReplayWindow(market.value, window) ||
      !marketDecisionFallsWithinReplayWindow(market.value, window, input.experiment.configuration.decisionOffsetSec)
    ) {
      return {
        ok: false,
        reasonCode: "DREAMDEX_HISTORICAL_BOUNDS_INVALID",
        message: `EXPLICIT_MARKET_OUTSIDE_WINDOW: ${explicitMarketId} decision timestamp is outside the configured historical window`
      };
    }
    return {
      ok: true,
      value: {
        markets: [market.value],
        pagesRead: 1,
        scannedCount: 1,
        duplicateCount: 0,
        filteredCount: 1,
        sourceCompleteness: "COMPLETE",
        windowFromSeconds: window.fromSeconds,
        windowToSeconds: window.toSeconds,
        explicitMarketId
      }
    };
  }
  const [asset] = input.experiment.configuration.assets;
  const [intervalSec] = input.experiment.configuration.intervals;
  const selected: HistoricalMarketEvidence[] = [];
  const seen = new Set<string>();
  let scannedCount = 0;
  let duplicateCount = 0;
  let pagesRead = 0;
  let hasMore = true;
  let offset = 0;
  while (hasMore && scannedCount < ReplayMaxMarketScanRows) {
    const limit = Math.min(ReplayPageLimit, ReplayMaxMarketScanRows - scannedCount);
    const page = await listHistoricalBinaryMarkets(input.client, input.config, {
      ...(asset === "BTC" || asset === "ETH" ? { asset } : {}),
      ...(typeof intervalSec === "number" ? { intervalSec } : {}),
      ...(window.fromSeconds === null ? {} : { fromSec: window.fromSeconds }),
      ...(window.toSeconds === null ? {} : { toSec: window.toSeconds }),
      status: "Finalized",
      limit,
      offset
    });
    if (!page.ok) {
      return page;
    }
    pagesRead += 1;
    if (page.value.excludedMalformedRows > 0) {
      return {
        ok: false,
        reasonCode: "DREAMDEX_HISTORICAL_MALFORMED_MARKET",
        message: `HISTORICAL_MARKET_SOURCE_MALFORMED: ${String(page.value.excludedMalformedRows)} malformed rows were excluded`
      };
    }
    for (const market of page.value.rows) {
      scannedCount += 1;
      const marketId = market.stableMarketId.toLowerCase();
      if (seen.has(marketId)) {
        duplicateCount += 1;
        continue;
      }
      seen.add(marketId);
      if (
        marketIntersectsReplayWindow(market, window) &&
        marketDecisionFallsWithinReplayWindow(market, window, input.experiment.configuration.decisionOffsetSec)
      ) {
        selected.push(market);
      }
    }
    hasMore = page.value.hasMore;
    offset += page.value.page.limit;
  }
  if (hasMore) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_HISTORICAL_BOUNDS_INVALID",
      message: `HISTORICAL_MARKET_SOURCE_CAP_EXCEEDED: scanned ${String(scannedCount)} rows without proving window completeness`
    };
  }
  if (selected.length > ReplayMaxMarkets) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_HISTORICAL_BOUNDS_INVALID",
      message: `HISTORICAL_MARKET_SELECTION_CAP_EXCEEDED: selected ${String(selected.length)} markets`
    };
  }
  return {
    ok: true,
    value: {
      markets: selected,
      pagesRead,
      scannedCount,
      duplicateCount,
      filteredCount: selected.length,
      sourceCompleteness: "COMPLETE",
      windowFromSeconds: window.fromSeconds,
      windowToSeconds: window.toSeconds,
      explicitMarketId
    }
  };
}

async function executeHistoricalReplay(input: {
  readonly pool: pg.Pool;
  readonly replayRun: ReplayRunRecord;
  readonly experiment: InteractiveExperimentDetailRecord;
  readonly historicalDreamDexClient: HistoricalDreamDexSdkClient;
  readonly historicalDreamDexConfig: MainnetHistoricalDreamDexConfig;
  readonly historicalIndexerFetch?: HistoricalIndexerFetch;
  readonly historicalRpcFetch?: HistoricalRpcFetch;
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
  const selectedMarkets = markets.value.markets;
  await updateReplayProgress(input.pool, {
    replayRunId: input.replayRun.id,
    selectedCount: selectedMarkets.length,
    processedCount,
    scoredCount,
    excludedCount: 0,
    checkpoints: {
      stage: "SOURCE_ACQUISITION",
      selectedMarketIds: selectedMarkets.map((market) => market.stableMarketId),
      sourceCompleteness: markets.value.sourceCompleteness,
      selectionPagesRead: markets.value.pagesRead,
      selectionRowsScanned: markets.value.scannedCount,
      selectionDuplicateRowsSkipped: markets.value.duplicateCount,
      selectionFilteredCount: markets.value.filteredCount,
      windowFromSeconds: markets.value.windowFromSeconds,
      windowToSeconds: markets.value.windowToSeconds,
      explicitMarketId: markets.value.explicitMarketId
    }
  });
  for (const market of selectedMarkets) {
    const decisionLeadSeconds = input.experiment.configuration.decisionOffsetSec;
    if (decisionLeadSeconds < 60) {
      throw new Error("DECISION_OFFSET_UNSUPPORTED: historical replay requires an explicit lead of at least 60 seconds");
    }
    try {
      const decisionAtSeconds = replayDecisionAtSeconds(market, decisionLeadSeconds);
      const decisionAt = new Date(decisionAtSeconds * 1000);
      const cutoff = await resolveHistoricalCutoffBlock(
        input.historicalDreamDexConfig,
        decisionAtSeconds,
        input.historicalRpcFetch
      );
      if (!cutoff.ok) {
        throw new Error(`CUTOFF_BLOCK_UNAVAILABLE: ${cutoff.message}`);
      }
      const candles = await fetchPagedHistoricalCandles(
        (page) =>
          listHistoricalCandles(input.historicalDreamDexClient, input.historicalDreamDexConfig, market.poolAddress, 300, {
            fromSec: market.tradingStartSeconds,
            toSec: decisionAtSeconds,
            ...page
          }),
        500,
        `candles ${market.stableMarketId}`
      );
      if (!candles.ok) {
        throw new Error(candles.message);
      }
      const orders = await fetchPagedHistoricalRows(
        (page) =>
          listHistoricalOrdersByMarket(
            input.historicalDreamDexConfig,
            market.stableMarketId,
            page,
            input.historicalIndexerFetch
          ),
        ReplayMaxSourceRows,
        `orders ${market.stableMarketId}`
      );
      if (!orders.ok) {
        throw new Error(orders.message);
      }
      const fills = await fetchPagedHistoricalRows(
        (page) =>
          listHistoricalFillsByMarket(input.historicalDreamDexConfig, market.stableMarketId, page, input.historicalIndexerFetch),
        ReplayMaxSourceRows,
        `fills ${market.stableMarketId}`
      );
      if (!fills.ok) {
        throw new Error(fills.message);
      }
    const cutoffBlock = cutoff.value.blockNumber;
    const blocks = [
      ...orders.value.rows.flatMap((order) => [order.placedAtBlock, order.lastUpdatedAtBlock]),
      ...fills.value.rows.map((fill) => fill.blockNumber)
    ];
    const sourceCompleteness = orders.value.hasMore || fills.value.hasMore || candles.value.hasMore ? "PARTIAL" : "COMPLETE";
    const manifestDigest = sha256(
      stableJson({
        marketId: market.stableMarketId,
        cutoff: cutoff.value,
        orders: orders.value.rows.map(withoutSource),
        fills: fills.value.rows.map(withoutSource),
        candles: candles.value.rows.map(withoutSource),
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
      candlesCount: candles.value.rows.length,
      firstBlock: minBlock(blocks),
      lastBlock: maxBlock(blocks),
      completeness: sourceCompleteness,
      canonicalDigest: manifestDigest,
      retrievedAt: new Date(),
      sourceMetadata: {
        plane: "MAINNET_HISTORICAL",
        chainId: SOMNIA_MAINNET_CHAIN_ID,
        marketId: market.stableMarketId,
        cutoffBlock,
        cutoffBlockHash: cutoff.value.blockHash,
        cutoffBlockTimestampSeconds: cutoff.value.timestampSeconds,
        cutoffRule: cutoff.value.rule,
        bookReconstruction: HISTORICAL_BOOK_RECONSTRUCTION_CAPABILITY
      }
    });
    if (sourceCompleteness !== "COMPLETE") {
      throw new Error(`SOURCE_BLOCKED: ${market.stableMarketId} exceeded a replay source cap`);
    }
    const frameResult = buildHistoricalDecisionFrame({
      market,
      decisionAt: decisionAt.toISOString(),
      cutoffBlock,
      candles: candles.value.rows,
      orders: orders.value.rows,
      fills: fills.value.rows,
      openingPrice: null,
      quoteDecimals: market.quoteDecimals
    });
    const decision = evaluateHistoricalPolicy(adapter, {
      frame: frameResult.frame,
      frameHash: frameResult.frameHash
    });
    const decisionExclusionReason = decision.action === "ABSTAIN" ? decision.reasonCodes.join("|") : null;
    const persistedDecision = await persistReplayDecision(input.pool, {
      replayRunId: input.replayRun.id,
      marketId: market.stableMarketId,
      policyVersionId: policy.policyVersionId,
      decisionAt,
      cutoffBlock,
      frameHash: frameResult.frameHash,
      forecastPUp: decision.forecastPUp,
      action: decision.action,
      reasonCodes: decision.reasonCodes,
      exclusionReason: decisionExclusionReason
    });
    const outcomeMarket = await getHistoricalBinaryMarket(
      input.historicalDreamDexClient,
      input.historicalDreamDexConfig,
      market.stableMarketId
    );
    if (!outcomeMarket.ok) {
      throw new Error(`OUTCOME_SOURCE_UNAVAILABLE: ${outcomeMarket.message}`);
    }
    const outcome = normalizeOutcome(outcomeMarket.value?.winningOutcome ?? null);
    const outcomeExclusionReason = outcome === null ? "OUTCOME_UNAVAILABLE_OR_UNMAPPED" : null;
    const outcomeLoadedAt = new Date();
    await persistReplayOutcome(input.pool, {
      replayDecisionId: persistedDecision.id,
      outcomeResult: outcome,
      exclusionReason: outcomeExclusionReason,
      loadedAt: outcomeLoadedAt,
      sourceMetadata: {
        plane: "MAINNET_HISTORICAL",
        chainId: SOMNIA_MAINNET_CHAIN_ID,
        marketId: market.stableMarketId,
        loadedAfterDecisionId: persistedDecision.id,
        decisionCommittedAt: persistedDecision.createdAt.toISOString()
      }
    });
    const exclusionReason = decisionExclusionReason ?? outcomeExclusionReason;
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
    await updateReplayProgress(input.pool, {
      replayRunId: input.replayRun.id,
      selectedCount: selectedMarkets.length,
      processedCount,
      scoredCount,
      excludedCount: processedCount - scoredCount,
      checkpoints: {
        stage: "OUTCOME_COMMITTED",
        lastMarketId: market.stableMarketId,
        lastDecisionId: persistedDecision.id,
        lastFrameHash: frameResult.frameHash,
        lastOutcomeLoadedAt: outcomeLoadedAt.toISOString()
      }
    });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Historical source read failed";
      const sourceFailure =
        message.startsWith("HISTORICAL_REPLAY_SOURCE_TIMEOUT") ||
        message.startsWith("SOURCE_BLOCKED") ||
        message.startsWith("CUTOFF_BLOCK_UNAVAILABLE") ||
        message.startsWith("DREAMDEX_HISTORICAL_READ_FAILED");
      if (!sourceFailure) {
        throw error;
      }
      const exclusionReason = `SOURCE_UNAVAILABLE|${message}`;
      processedCount += 1;
      outputItems.push({
        marketId: market.stableMarketId,
        frameHash: null,
        cutoffBlock: null,
        action: "ABSTAIN",
        outcome: null,
        exclusionReason
      });
      await updateReplayProgress(input.pool, {
        replayRunId: input.replayRun.id,
        selectedCount: selectedMarkets.length,
        processedCount,
        scoredCount,
        excludedCount: processedCount - scoredCount,
        checkpoints: {
          stage: "SOURCE_MARKET_EXCLUDED",
          lastMarketId: market.stableMarketId,
          lastExclusionReason: exclusionReason
        }
      });
    }
  }
  const outputHash = sha256(stableJson(outputItems));
  return await completeReplayRun(input.pool, {
    replayRunId: input.replayRun.id,
    selectedCount: selectedMarkets.length,
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
      bookReconstruction: HISTORICAL_BOOK_RECONSTRUCTION_CAPABILITY,
      sourceCompleteness: markets.value.sourceCompleteness,
      selectionPagesRead: markets.value.pagesRead,
      selectionRowsScanned: markets.value.scannedCount,
      selectionDuplicateRowsSkipped: markets.value.duplicateCount,
      selectionFilteredCount: markets.value.filteredCount,
      decisionOffsetSec: input.experiment.configuration.decisionOffsetSec,
      windowFromSeconds: markets.value.windowFromSeconds,
      windowToSeconds: markets.value.windowToSeconds,
      explicitMarketId: markets.value.explicitMarketId
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
  readonly execution_metrics: Record<string, unknown>;
  readonly pnl_status: string;
  readonly evidence_plane: string;
  readonly promotion_scope: string;
  readonly created_at: Date;
}

interface AssessmentDetailRow extends AssessmentSummaryRow {
  readonly thresholds: Record<string, unknown>;
  readonly replay_run_id: string | null;
  readonly execution_metrics: Record<string, unknown>;
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
    tradeabilityStatus:
      typeof row.execution_metrics.tradeabilityStatus === "string"
        ? row.execution_metrics.tradeabilityStatus
        : "NOT_EVALUATED",
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
        mr.execution_metrics,
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

function numberFromRecord(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function formatMetric(value: number | null, digits = 4): string {
  return value === null ? "NOT AVAILABLE" : value.toFixed(digits);
}

function verdictSummary(verdict: string, reasonCodes: readonly string[]): string {
  if (verdict === "PROMOTE_TO_FORWARD_OBSERVATION") {
    return "Historical replay evidence is sufficient to start forward observation, but it does not authorize execution.";
  }
  if (verdict === "HOLD") {
    return "Evidence supports continued observation without advancing the strategy.";
  }
  if (verdict === "REJECT") {
    return "The strategy version failed the configured evidence rules for this phase.";
  }
  if (reasonCodes.includes("MIN_SAMPLE_NOT_MET")) {
    return "Promotion is blocked because the scored evidence sample is below the required threshold.";
  }
  return "Evidence is not sufficient to advance this strategy.";
}

function nextActionForVerdict(verdict: string): string {
  if (verdict === "PROMOTE_TO_FORWARD_OBSERVATION") {
    return "START_FORWARD_OBSERVATION";
  }
  if (verdict === "HOLD") {
    return "CONTINUE_OBSERVATION";
  }
  if (verdict === "REJECT") {
    return "STOP_THIS_STRATEGY_VERSION";
  }
  return "COLLECT_MORE_EVIDENCE";
}

function doesNotAuthorizeForVerdict(verdict: string): readonly string[] {
  const shared = [
    "mainnet trading",
    "autonomous execution",
    "profit or realized PnL claims",
    "unbounded Shannon testnet orders"
  ];
  if (verdict === "PROMOTE_TO_FORWARD_OBSERVATION") {
    return [
      ...shared,
      "capital deployment without a separate human-authorized Shannon execution gate"
    ];
  }
  return [
    ...shared,
    "promotion to forward observation"
  ];
}

function progressionStages(input: {
  readonly verdict: string;
  readonly sourcePlane: string;
  readonly replayLinked: boolean;
  readonly executionLinked?: boolean;
}) {
  return [
    {
      stage: "Configuration",
      plane: "APPLICATION_STATE",
      status: "VERIFIED",
      detail: "Immutable experiment configuration and policy identity are persisted."
    },
    {
      stage: "Historical Replay",
      plane: input.sourcePlane,
      status: input.replayLinked ? "VERIFIED" : "PENDING",
      detail: "Historical evidence is evaluated under strict anti-lookahead."
    },
    {
      stage: "Evidence Gate",
      plane: input.sourcePlane,
      status: "VERIFIED",
      detail: "Server-authored assessment controls the current verdict."
    },
    {
      stage: "Forward Observation",
      plane: "SHANNON_FORWARD",
      status: input.verdict === "PROMOTE_TO_FORWARD_OBSERVATION" ? "ALLOWED_NEXT" : "PENDING",
      detail:
        input.verdict === "PROMOTE_TO_FORWARD_OBSERVATION"
          ? "Historical evidence permits forward observation only."
          : "Forward observation remains unavailable until evidence permits advancement."
    },
    {
      stage: "Execution Proof",
      plane: "SHANNON_EXECUTION",
      status: input.executionLinked === true ? "LINKED" : "UNLINKED_GLOBAL_PROOF_AVAILABLE",
      detail: "Global EXG-003 proof remains separate unless explicitly linked to this candidate."
    }
  ];
}

function buildEvidenceGate(input: { readonly row: AssessmentDetailRow | null; readonly experimentId: string }) {
  if (input.row === null) {
    return {
      evidence: null,
      state: "EVALUATION_REQUIRED",
      message: "Run evaluation before opening a server-authored Evidence Gate."
    };
  }
  const minSampleSize = numberFromRecord(input.row.thresholds, "minSampleSize", 30);
  const promoteMaxBrierScore = numberFromRecord(input.row.thresholds, "promoteMaxBrierScore", 0.2);
  const promoteMaxAbsCalibrationBias = numberFromRecord(input.row.thresholds, "promoteMaxAbsCalibrationBias", 0.05);
  const sampleDeficit = Math.max(0, minSampleSize - input.row.sample_size);
  const tradeabilityStatus =
    typeof input.row.execution_metrics.tradeabilityStatus === "string"
      ? input.row.execution_metrics.tradeabilityStatus
      : "NOT_EVALUATED";
  const assessment = serializeAssessmentSummary(input.row);
  const rows = [
    {
      dimension: "Forecast sample",
      status: sampleDeficit === 0 ? "PASS" : "BLOCKED",
      value: `${String(input.row.sample_size)}/${String(minSampleSize)} observations`,
      detail:
        sampleDeficit === 0
          ? "Minimum scored historical sample is satisfied."
          : `${String(sampleDeficit)} additional scored observations are required before promotion can be considered.`
    },
    {
      dimension: "Forecast quality",
      status:
        input.row.brier_score === null
          ? "NOT_AVAILABLE"
          : input.row.brier_score <= promoteMaxBrierScore
            ? "PASS"
            : "BLOCKED",
      value: formatMetric(input.row.brier_score),
      detail: `Brier score is compared with the promotion threshold ${promoteMaxBrierScore.toFixed(4)}.`
    },
    {
      dimension: "Forecast calibration",
      status:
        input.row.calibration_bias === null
          ? "NOT_AVAILABLE"
          : Math.abs(input.row.calibration_bias) <= promoteMaxAbsCalibrationBias
            ? "PASS"
            : "BLOCKED",
      value: formatMetric(input.row.calibration_bias),
      detail: `Absolute calibration bias must be <= ${promoteMaxAbsCalibrationBias.toFixed(4)} for promotion.`
    },
    {
      dimension: "Tradeability / execution quality",
      status: tradeabilityStatus === "EVALUATED" ? "VERIFIED" : "NOT_AVAILABLE",
      value: tradeabilityStatus,
      detail: "Historical replay forecast evidence remains separate from live execution and realized fill evidence."
    },
    {
      dimension: "PnL",
      status: input.row.pnl_status === "AVAILABLE" ? "VERIFIED" : "NOT_AVAILABLE",
      value: input.row.pnl_status,
      detail: "Replay or counterfactual PnL is never labeled realized wallet PnL."
    },
    {
      dimension: "Provenance",
      status: "VERIFIED",
      value: input.row.evidence_plane,
      detail: `${input.row.promotion_scope}; replay ${input.row.replay_run_id ?? "not linked"}.`
    }
  ];
  return {
    evidence: {
      experimentId: input.experimentId,
      assessment,
      decision: {
        verdict: input.row.verdict,
        reason: verdictSummary(input.row.verdict, input.row.reason_codes),
        supportingEvidence: rows.filter((row) => row.status === "PASS" || row.status === "VERIFIED").map((row) => row.dimension),
        missingEvidence: rows.filter((row) => row.status === "BLOCKED" || row.status === "NOT_AVAILABLE").map((row) => row.dimension),
        nextPermittedAction: nextActionForVerdict(input.row.verdict),
        doesNotAuthorize: doesNotAuthorizeForVerdict(input.row.verdict),
        sourcePlane: input.row.evidence_plane,
        promotionScope:
          input.row.verdict === "PROMOTE_TO_FORWARD_OBSERVATION" ? input.row.promotion_scope : "NOT_APPLICABLE",
        decidedAt: input.row.created_at.toISOString()
      },
      progression: {
        candidateId: input.experimentId,
        currentStage: "Evidence Gate",
        stages: progressionStages({
          verdict: input.row.verdict,
          sourcePlane: input.row.evidence_plane,
          replayLinked: input.row.replay_run_id !== null
        })
      },
      gateRows: rows,
      missingEvidence: rows.filter((row) => row.status === "BLOCKED" || row.status === "NOT_AVAILABLE").map((row) => row.dimension),
      verdictReasons: input.row.reason_codes,
      nextPermittedAction: nextActionForVerdict(input.row.verdict),
      serverAuthored: true
    },
    state: "READY",
    message: "Evidence Gate is server-authored from the latest immutable assessment."
  };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}

function readEvidenceRecord(relativePath: string): Record<string, unknown> {
  const candidates = [
    join(process.cwd(), relativePath),
    join(ModuleDir, "..", "..", "..", relativePath)
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path === undefined) {
    throw new Error(`Required proof artifact is missing: ${relativePath}`);
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Required proof artifact is not an object: ${relativePath}`);
  }
  return parsed;
}

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`Proof artifact field is missing or malformed: ${key}`);
  }
  return value;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Proof artifact string field is missing: ${key}`);
  }
  return value;
}

function booleanField(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`Proof artifact boolean field is missing: ${key}`);
  }
  return value;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Evidence artifact number field is missing: ${key}`);
  }
  return value;
}

function nullableNumberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Evidence artifact nullable number field is malformed: ${key}`);
  }
  return value;
}

function nullableStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Evidence artifact nullable string field is malformed: ${key}`);
  }
  return value;
}

function stringArrayField(record: Record<string, unknown>, key: string): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Evidence artifact string array field is missing: ${key}`);
  }
  return value.map((item) => String(item));
}

function compactHash(value: string): string {
  return value.length > 18 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

function explorerTx(explorerUrl: string, txHash: string): string {
  return `${explorerUrl.replace(/\/$/, "")}/tx/${txHash}`;
}

function explorerAddress(explorerUrl: string, address: string): string {
  return `${explorerUrl.replace(/\/$/, "")}/address/${address}`;
}

function buildExg003Proof() {
  const publicArtifact = readEvidenceRecord("evidence/proof/exg-003-public.json");
  const proof = recordField(publicArtifact, "proof");
  const network = recordField(proof, "network");
  const order = recordField(proof, "order");
  const reconciliation = recordField(proof, "reconciliation");
  const chainId = network.chainId;
  if (typeof chainId !== "number" || chainId !== SOMNIA_SHANNON_CHAIN_ID) {
    throw new Error("EXG-003 proof artifact is not on Somnia Shannon");
  }
  if (
    stringField(order, "terminalEvent") !== "OrderExpired" ||
    stringField(order, "fillStatus") !== "NO_FILL" ||
    booleanField(reconciliation, "fillObserved") ||
    !booleanField(reconciliation, "collateralReconciled") ||
    booleanField(reconciliation, "unexpectedOpenOrder") ||
    stringField(reconciliation, "pnlStatus") !== "NOT_AVAILABLE"
  ) {
    throw new Error("EXG-003 proof artifact does not match approved no-fill expired lifecycle");
  }
  const explorerUrl = stringField(network, "explorerUrl");
  const responseProof = JSON.parse(JSON.stringify(proof)) as Record<string, unknown>;
  const lifecycle = responseProof.lifecycle;
  if (Array.isArray(lifecycle)) {
    for (const step of lifecycle) {
      if (isRecord(step) && typeof step.txHash === "string") {
        step.href = explorerTx(explorerUrl, step.txHash);
      }
    }
  }
  const technical = responseProof.technical;
  if (Array.isArray(technical)) {
    for (const row of technical) {
      if (!isRecord(row)) {
        continue;
      }
      if (typeof row.txHash === "string") {
        row.href = explorerTx(explorerUrl, row.txHash);
      }
      if (typeof row.address === "string") {
        row.href = explorerAddress(explorerUrl, row.address);
      }
    }
  }
  return { proof: responseProof };
}

function provenGateRows(input: {
  readonly sampleSize: number;
  readonly exclusionCount: number;
  readonly brierScore: number | null;
  readonly calibrationBias: number | null;
  readonly pnlStatus: string;
  readonly replayOutputHash: string;
}) {
  const minSampleSize = 30;
  return [
    {
      dimension: "Forecast sample",
      status: input.sampleSize >= minSampleSize ? "PASS" : "BLOCKED",
      value: `${String(input.sampleSize)}/${String(minSampleSize)} observations`,
      detail: `${String(Math.max(0, minSampleSize - input.sampleSize))} additional scored observations are required before promotion can be considered.`
    },
    {
      dimension: "Forecast quality",
      status: input.brierScore === null ? "NOT_AVAILABLE" : "PASS",
      value: input.brierScore === null ? "NOT AVAILABLE" : input.brierScore.toFixed(4),
      detail:
        input.brierScore === null
          ? "No forecast-quality claim is made when the replay produced no scored decisions."
          : "Forecast quality is calculated from scored historical replay decisions only."
    },
    {
      dimension: "Forecast calibration",
      status: input.calibrationBias === null ? "NOT_AVAILABLE" : "PASS",
      value: input.calibrationBias === null ? "NOT AVAILABLE" : input.calibrationBias.toFixed(4),
      detail: "Calibration remains unavailable until scored historical decisions exist."
    },
    {
      dimension: "Tradeability / execution quality",
      status: "NOT_AVAILABLE",
      value: "NOT_AVAILABLE",
      detail: "Historical replay does not prove live fillability or realized execution quality."
    },
    {
      dimension: "PnL",
      status: "NOT_AVAILABLE",
      value: input.pnlStatus,
      detail: "No realized wallet PnL is claimed for a retrospective replay."
    },
    {
      dimension: "Provenance",
      status: "VERIFIED",
      value: compactHash(input.replayOutputHash),
      detail: "Replay output hash links the gate to the captured real-evidence run."
    },
    {
      dimension: "Excluded evidence",
      status: input.exclusionCount === 0 ? "PASS" : "BLOCKED",
      value: `${String(input.exclusionCount)} excluded`,
      detail: "Abstentions and unusable decisions remain visible instead of being scored as wins."
    }
  ];
}

function buildProvenExperiment() {
  const replayReport = readEvidenceRecord("evidence/replay/replay-002-report.json");
  const replaySample = readEvidenceRecord("evidence/replay/replay-002-sample.json");
  const evalReport = readEvidenceRecord("evidence/evaluate/eval-002-report.json");
  const market = recordField(replayReport, "market");
  const source = recordField(market, "source");
  const experiment = recordField(replayReport, "experiment");
  const configuration = recordField(experiment, "configuration");
  const config = recordField(configuration, "config");
  const replay = recordField(replayReport, "replay");
  const checkpoints = recordField(replay, "checkpoints");
  const decision = recordField(replaySample, "replayDecision");
  const evaluation = recordField(evalReport, "evaluation");
  const generatedEvidenceGate = recordField(evalReport, "evidenceGate");
  const generatedAssessment = recordField(generatedEvidenceGate, "assessment");
  const gateDecision = recordField(generatedEvidenceGate, "decision");
  const experimentId = stringField(experiment, "experimentId");
  const sampleSize = numberField(generatedAssessment, "sampleSize");
  const exclusionCount = numberField(generatedAssessment, "exclusionCount");
  const brierScore = nullableNumberField(generatedAssessment, "brierScore");
  const calibrationBias = nullableNumberField(generatedAssessment, "calibrationBias");
  const pnlStatus = stringField(generatedAssessment, "pnlStatus");
  const replayOutputHash = stringField(replay, "outputHash");
  const reasonCodes = stringArrayField(generatedAssessment, "reasonCodes");
  const assessment = {
    assessmentId: stringField(generatedAssessment, "assessmentId"),
    metricRunId: stringField(generatedAssessment, "metricRunId"),
    experimentId,
    experimentName: stringField(generatedAssessment, "experimentName"),
    verdict: stringField(generatedAssessment, "verdict"),
    reasonCodes,
    sampleSize,
    exclusionCount,
    brierScore,
    calibrationBias,
    neutralBaselineDelta: nullableNumberField(generatedAssessment, "neutralBaselineDelta"),
    pnlStatus,
    evidencePlane: stringField(generatedAssessment, "evidencePlane"),
    replayRunId: stringField(replay, "id"),
    promotionScope: stringField(generatedAssessment, "promotionScope"),
    createdAt: stringField(generatedAssessment, "createdAt")
  };
  const gateRows = provenGateRows({
    sampleSize,
    exclusionCount,
    brierScore,
    calibrationBias,
    pnlStatus,
    replayOutputHash
  });
  return {
    provenExperiment: {
      slug: "proven-experiment",
      title: "Proven replay: historical last-trade qualification",
      status: "PUBLIC_PROVEN",
      verdict: assessment.verdict,
      sampleSize: assessment.sampleSize,
      sourcePlane: "MAINNET_HISTORICAL",
      policy: `${stringField(recordField(config, "policy"), "policyId")}@${stringField(recordField(config, "policy"), "version")}`,
      route: "/lab/proven-experiment",
      evidenceRoute: "/evidence/proven-experiment",
      exportPath: "evidence/proven/manifest.json",
      selectionDisclosure:
        "Captured real-evidence qualification artifact. It is selected for reproducibility and source completeness, not for a favorable verdict.",
      source: {
        plane: stringField(source, "plane"),
        chainId: numberField(source, "chainId"),
        sdkVersion: stringField(source, "sdkVersion"),
        writePolicy: stringField(source, "writePolicy")
      },
      market: {
        stableMarketId: stringField(market, "stableMarketId"),
        asset: stringField(market, "asset"),
        intervalSeconds: numberField(market, "intervalSeconds"),
        status: stringField(market, "status"),
        normalizedOutcome: stringField(market, "winningOutcome")
      },
      experiment: {
        experimentId,
        mode: stringField(configuration, "mode"),
        policy: `${stringField(recordField(config, "policy"), "policyId")}@${stringField(recordField(config, "policy"), "version")}`,
        riskEnvelope: stringField(config, "riskEnvelopeId")
      },
      replay: {
        status: stringField(replay, "status"),
        selectedCount: numberField(replay, "selectedCount"),
        processedCount: numberField(replay, "processedCount"),
        scoredCount: numberField(replay, "scoredCount"),
        excludedCount: numberField(replay, "excludedCount"),
        outputHash: replayOutputHash,
        bookReconstruction: stringField(replay, "capability"),
        blockchainWrite: booleanField(recordField(replayReport, "assertions"), "blockchainWrite")
      },
      decision: {
        marketId: stringField(decision, "marketId"),
        action: stringField(decision, "action"),
        forecastPUp: nullableNumberField(decision, "forecastPUp"),
        outcomeResult: nullableStringField(decision, "outcomeResult"),
        frameHash: stringField(decision, "frameHash"),
        reasonCodes: stringArrayField(decision, "reasonCodes")
      },
      antiLookahead: {
        decisionFrames: "STRICT_PRE_CUTOFF_FRAME_HASHED",
        outcomeEmbargo: stringField(checkpoints, "outcomeEmbargo"),
        futureCandlesExcluded: true,
        futureFillsExcluded: true,
        resolutionEmbargoedFromPolicy: true
      },
      assessment,
      evidenceGate: {
        experimentId,
        assessment,
        decision: {
          verdict: assessment.verdict,
          reason: stringField(gateDecision, "reason"),
          supportingEvidence: stringArrayField(gateDecision, "supportingEvidence"),
          missingEvidence: stringArrayField(gateDecision, "missingEvidence"),
          nextPermittedAction: stringField(gateDecision, "nextPermittedAction"),
          doesNotAuthorize: stringArrayField(gateDecision, "doesNotAuthorize"),
          sourcePlane: assessment.evidencePlane,
          promotionScope: stringField(gateDecision, "promotionScope"),
          decidedAt: assessment.createdAt
        },
        progression: {
          candidateId: experimentId,
          currentStage: "Evidence Gate",
          stages: progressionStages({
            verdict: assessment.verdict,
            sourcePlane: assessment.evidencePlane,
            replayLinked: true
          })
        },
        gateRows,
        missingEvidence: gateRows.filter((row) => row.status === "BLOCKED" || row.status === "NOT_AVAILABLE").map((row) => row.dimension),
        verdictReasons: reasonCodes,
        nextPermittedAction: nextActionForVerdict(assessment.verdict),
        serverAuthored: true
      },
      reproducibility: {
        sourceArtifacts: [
          "evidence/replay/replay-002-report.json",
          "evidence/replay/replay-002-sample.json",
          "evidence/evaluate/eval-002-report.json"
        ],
        replayOutputHash,
        inputHash: stringField(evaluation, "inputHash"),
        assessmentHash: stringField(evaluation, "assessmentHash"),
        exportPath: "evidence/proven/manifest.json"
      }
    }
  };
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

async function listComparisons(pool: pg.Pool, input: { readonly sessionId: string; readonly limit?: number }) {
  const result = await pool.query<{
    comparison_id: string;
    name: string;
    created_at: Date;
    updated_at: Date;
    item_count: string;
  }>(
    `
      SELECT
        cs.id AS comparison_id,
        cs.name,
        cs.created_at,
        cs.updated_at,
        count(ci.assessment_id)::text AS item_count
      FROM comparison_sets cs
      LEFT JOIN comparison_items ci ON ci.comparison_set_id = cs.id
      WHERE cs.created_by_session_id = $1
      GROUP BY cs.id
      ORDER BY cs.updated_at DESC, cs.created_at DESC
      LIMIT $2
    `,
    [input.sessionId, input.limit ?? 20]
  );
  return result.rows.map((row) => ({
    comparisonId: row.comparison_id,
    name: row.name.replace(/#[A-Za-z0-9._:-]{8,128}$/, ""),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    itemCount: Number(row.item_count)
  }));
}

export function buildApp(config: RuntimeConfig, deps: AppDependencies = {}) {
  const app = Fastify({
    bodyLimit: 64 * 1024,
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
  const replayTasks = new Map<string, Promise<void>>();
  const rateBuckets = new Map<string, { readonly resetAt: number; count: number }>();

  app.addHook("onRequest", async (request, reply) => {
    const key = rateKey(request);
    if (key === "unlimited-page") {
      return;
    }
    const now = Date.now();
    for (const [bucketKey, bucket] of rateBuckets) {
      if (bucket.resetAt <= now) {
        rateBuckets.delete(bucketKey);
      }
    }
    const limit =
      key.startsWith("session-create:")
        ? ResearchSessionCreateRateLimit
        : key.startsWith("write:")
          ? PublicWriteRateLimit
          : PublicReadRateLimit;
    const bucket = rateBuckets.get(key);
    if (bucket === undefined) {
      rateBuckets.set(key, { resetAt: now + RateWindowMs, count: 1 });
      return;
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      reply.header("retry-after", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return v2Error(
        reply,
        429,
        "RATE_LIMITED",
        "Request rate limit exceeded; retry after the window resets",
        true,
        request.id,
        { windowSeconds: RateWindowMs / 1000, limit }
      );
    }
  });

  function scheduleReplay(replayRun: ReplayRunRecord, experiment: InteractiveExperimentDetailRecord): void {
    if (replayTasks.has(replayRun.id) || !["QUEUED", "FAILED"].includes(replayRun.status)) {
      return;
    }
    const task = new Promise<void>((resolve) => {
      setImmediate(() => {
        resolve();
      });
    })
      .then(async () => {
        const pool = requirePool(deps);
        const running = await startReplayRun(pool, replayRun.id);
        await executeHistoricalReplay({
          pool,
          replayRun: running,
          experiment,
          historicalDreamDexClient,
          historicalDreamDexConfig,
          ...(deps.historicalIndexerFetch === undefined ? {} : { historicalIndexerFetch: deps.historicalIndexerFetch }),
          ...(deps.historicalRpcFetch === undefined ? {} : { historicalRpcFetch: deps.historicalRpcFetch })
        });
      })
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : "REPLAY_FAILED";
        if (message.includes("REPLAY_CANCELLED_OR_DEADLINE_EXCEEDED")) {
          return;
        }
        const pool = requirePool(deps);
        if (message.startsWith("SOURCE_BLOCKED:")) {
          await blockReplayRun(pool, {
            replayRunId: replayRun.id,
            errorCode: "SOURCE_BLOCKED",
            checkpoints: { sourcePlane: "MAINNET_HISTORICAL", reason: message }
          });
          return;
        }
        await failReplayRun(pool, {
          replayRunId: replayRun.id,
          errorCode: message.slice(0, 120),
          checkpoints: { sourcePlane: "MAINNET_HISTORICAL", failedAt: new Date().toISOString() }
        });
      })
      .finally(() => {
        replayTasks.delete(replayRun.id);
      });
    replayTasks.set(replayRun.id, task);
  }

  app.addHook("onClose", async () => {
    await Promise.allSettled([...replayTasks.values()]);
  });

  void app.register(helmet);
  void app.register(cookie, { secret: config.SESSION_SECRET });
  void app.register(cors, {
    origin: config.PUBLIC_APP_URL,
    credentials: true
  });
  const staticRoots = [
    join(ModuleDir, "..", "..", "web", "dist"),
    join(ModuleDir, "..", "..", "..", "apps", "web", "dist")
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
      replayWorker: {
        enabled: config.WORKER_ENABLED,
        judgeCriticalPath: config.WORKER_ENABLED ? "BACKGROUND_WORKER_REQUIRED" : "INLINE_API_REPLAY",
        livenessRequired: config.WORKER_ENABLED,
        disclosure:
          config.WORKER_ENABLED
            ? "Worker liveness must be monitored when background replay is enabled."
            : "Background worker is disabled; judge-critical replay requests are executed inline through the API."
      },
      chainId: SOMNIA_SHANNON_CHAIN_ID,
      marketsSdkVersion: DREAMDEX_MARKETS_SDK_VERSION
    };
  });

  app.get("/api/v1/invariants", () => ({
    product: "forward-testing-live-shadow-recent-window-dreamdex-lab",
    verdicts: ["PROMOTE_TO_FORWARD_OBSERVATION", "HOLD", "REJECT", "INSUFFICIENT_EVIDENCE"],
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

  app.get("/api/v2/proof/exg-003", (request, reply) => {
    try {
      return v2Data(buildExg003Proof(), {
        sourcePlane: "SHANNON_EXECUTION",
        chainId: SOMNIA_SHANNON_CHAIN_ID,
        blockchainWrite: false,
        proofAuthority: "sanitized-exg-003-artifacts"
      });
    } catch (error) {
      return v2Error(
        reply,
        503,
        "EXG_003_PROOF_UNAVAILABLE",
        error instanceof Error ? error.message : "EXG-003 proof unavailable",
        false,
        request.id
      );
    }
  });

  app.get("/api/v2/proven-experiments", (request, reply) => {
    try {
      const proven = buildProvenExperiment().provenExperiment;
      return v2Data(
        {
          provenExperiments: [
            {
              slug: proven.slug,
              title: proven.title,
              verdict: proven.assessment.verdict,
              sampleSize: proven.assessment.sampleSize,
              sourcePlane: proven.source.plane,
              policy: proven.experiment.policy,
              route: `/lab/${proven.slug}`,
              evidenceRoute: `/evidence/${proven.slug}`,
              exportPath: proven.reproducibility.exportPath
            }
          ]
        },
        {
          sourcePlane: "MAINNET_HISTORICAL",
          publicProven: true,
          blockchainWrite: false
        }
      );
    } catch (error) {
      return v2Error(
        reply,
        503,
        "PROVEN_EXPERIMENT_UNAVAILABLE",
        error instanceof Error ? error.message : "Proven Experiment unavailable",
        true,
        request.id
      );
    }
  });

  app.get("/api/v2/proven-experiments/:slug", (request, reply) => {
    const params = z.object({ slug: z.literal("proven-experiment") }).safeParse(request.params);
    if (!params.success) {
      return v2Error(reply, 404, "PROVEN_EXPERIMENT_NOT_FOUND", "Proven Experiment was not found", false, request.id);
    }
    try {
      return v2Data(buildProvenExperiment(), {
        sourcePlane: "MAINNET_HISTORICAL",
        publicProven: true,
        blockchainWrite: false,
        verdictAuthority: "captured-server-evaluation-export"
      });
    } catch (error) {
      return v2Error(
        reply,
        503,
        "PROVEN_EXPERIMENT_UNAVAILABLE",
        error instanceof Error ? error.message : "Proven Experiment unavailable",
        true,
        request.id
      );
    }
  });

  app.post("/api/v2/research-session", async (request, reply) => {
    try {
      const pool = requirePool(deps);
      const ensured = await ensureResearchSession(pool, config, request, reply);
      await writeAudit(pool, {
        sessionId: ensured.session.id,
        action: "research_session.ensure",
        targetType: "research_session",
        targetId: ensured.session.id,
        outcome: ensured.created ? "CREATED" : "REFRESHED",
        correlationId: request.id,
        safeMetadata: { csrfVersion: ensured.session.csrfVersion }
      });
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

  app.post("/api/v2/research-session/revoke", async (request, reply) => {
    try {
      requireIdempotencyKey(request.headers);
    } catch {
      return await v2Error(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required", false, request.id);
    }
    try {
      const pool = requirePool(deps);
      const session = await requireResearchSession(pool, request);
      if (session === null) {
        return await v2Error(reply, 401, "RESEARCH_SESSION_REQUIRED", "Active research session is required", false, request.id);
      }
      if (!requireCsrf(request, session)) {
        return await v2Error(reply, 403, "CSRF_TOKEN_INVALID", "Research-session CSRF token is missing or invalid", false, request.id);
      }
      const revoked = await revokeResearchSession(pool, session.id);
      if (revoked) {
        await writeAudit(pool, {
          sessionId: session.id,
          action: "research_session.revoke",
          targetType: "research_session",
          targetId: session.id,
          outcome: "REVOKED",
          correlationId: request.id
        });
      }
      reply.clearCookie(ResearchSessionCookie, sessionCookieOptions(config));
      return v2Data(
        { revoked },
        { applicationWrite: true, blockchainWrite: false, ownership: "research-session" }
      );
    } catch (error) {
      return v2Error(
        reply,
        503,
        "RESEARCH_SESSION_REVOKE_FAILED",
        error instanceof Error ? error.message : "Research session revoke failed",
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
      if (!policySupportedInMode(policy.policyId, policy.version, parsed.data.mode)) {
        return await v2Error(
          reply,
          400,
          "POLICY_PLANE_UNSUPPORTED",
          "Selected policy cannot run in the requested experiment mode",
          false,
          request.id
        );
      }
      const sessionExperimentCount = await countInteractiveExperiments(pool, { sessionId: session.id });
      if (sessionExperimentCount >= MaxExperimentsPerSession) {
        return await v2Error(
          reply,
          429,
          "EXPERIMENT_QUOTA_EXCEEDED",
          "Research-session experiment quota exceeded",
          true,
          request.id,
          { quota: MaxExperimentsPerSession }
        );
      }
      const windowFrom = parsed.data.windowFrom === undefined ? null : new Date(parsed.data.windowFrom);
      const windowTo = parsed.data.windowTo === undefined ? null : new Date(parsed.data.windowTo);
      if (windowFrom !== null && windowTo !== null && windowFrom >= windowTo) {
        return await v2Error(reply, 400, "EXPERIMENT_WINDOW_INVALID", "Historical window start must precede end", false, request.id);
      }
      const effectiveDecisionOffsetSec = parsed.data.decisionOffsetSec;
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
          implementationHash: policy.implementationHash,
          parameters: policy.parameters,
          supportedPlanes: policy.supportedPlanes
        }
      });
      const configPayload = {
        sourcePlane: parsed.data.mode === "HISTORICAL_REPLAY" ? "MAINNET_HISTORICAL" : "SHANNON_FORWARD",
        selectedMarketId: parsed.data.marketId ?? null,
        asset: parsed.data.asset,
        intervalSec: parsed.data.intervalSec,
        windowFrom: windowFrom?.toISOString() ?? null,
        windowTo: windowTo?.toISOString() ?? null,
        decisionOffsetSec: effectiveDecisionOffsetSec,
        decisionBoundaryRule: "decisionAt = max(tradingStart + 1s, expiry - decisionOffsetSec)",
        riskEnvelopeId: parsed.data.riskEnvelopeId,
        policy: {
          policyId: policy.policyId,
          version: policy.version,
          sourceHash: policy.sourceHash
        },
        historicalBookReconstruction: HISTORICAL_BOOK_RECONSTRUCTION_CAPABILITY,
        pnlStatus: "NOT_AVAILABLE"
      };
      const createIdempotencyHash = sha256(
        stableJson({
          route: "POST /api/v2/experiments",
          body: parsed.data
        })
      );
      const created = await createInteractiveExperiment(pool, {
        sessionId: session.id,
        name: parsed.data.name,
        createIdempotencyKey: idempotencyKey,
        createIdempotencyHash,
        configuration: {
          mode: parsed.data.mode,
          assets: [parsed.data.asset],
          intervals: [parsed.data.intervalSec],
          windowFrom,
          windowTo,
          decisionOffsetSec: effectiveDecisionOffsetSec,
          ruleVersion: "interactive-2.0.1-deep-audit",
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
      await writeAudit(pool, {
        sessionId: session.id,
        action: "experiment.create",
        targetType: "experiment",
        targetId: created.experimentId,
        outcome: created.idempotentReplay ? "IDEMPOTENT_REPLAY" : "CREATED",
        correlationId: request.id,
        safeMetadata: {
          mode: parsed.data.mode,
          sourcePlane: configPayload.sourcePlane,
          policyId: policy.policyId,
          policyVersion: policy.version
        }
      });
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
      if (error instanceof Error && error.message === "IDEMPOTENCY_BODY_MISMATCH") {
        return await v2Error(
          reply,
          409,
          "IDEMPOTENCY_BODY_MISMATCH",
          "Idempotency-Key was already used with a different canonical request body",
          false,
          request.id
        );
      }
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
      if (replay !== null && replay.status === "QUEUED") {
        const experiment = await getInteractiveExperiment(pool, {
          sessionId: ensured.session.id,
          experimentId: params.data.experimentId
        });
        if (experiment !== null) {
          scheduleReplay(replay, experiment);
        }
      }
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

  app.get("/api/v2/replay-runs/:replayRunId", async (request, reply) => {
    const params = z.object({ replayRunId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return await v2Error(reply, 400, "REPLAY_RUN_ID_INVALID", "Replay run ID is invalid", false, request.id, params.error.issues);
    }
    try {
      const pool = requirePool(deps);
      const ensured = await ensureResearchSession(pool, config, request, reply);
      const replay = await getOwnedReplayRun(pool, {
        sessionId: ensured.session.id,
        replayRunId: params.data.replayRunId
      });
      if (replay === null) {
        return await v2Error(reply, 404, "REPLAY_RUN_NOT_FOUND", "Replay run was not found", false, request.id);
      }
      return v2Data(
        { replay: serializeReplayRun(replay), csrfToken: ensured.csrfToken },
        { ownership: "research-session", sourcePlane: "MAINNET_HISTORICAL", blockchainWrite: false }
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

  app.post("/api/v2/replay-runs/:replayRunId/cancel", async (request, reply) => {
    const params = z.object({ replayRunId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return await v2Error(reply, 400, "REPLAY_RUN_ID_INVALID", "Replay run ID is invalid", false, request.id, params.error.issues);
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
      const cancelled = await cancelReplayRun(pool, {
        sessionId: session.id,
        replayRunId: params.data.replayRunId
      });
      if (!cancelled) {
        return await v2Error(reply, 404, "REPLAY_RUN_NOT_ACTIVE", "Active replay run was not found", false, request.id);
      }
      await writeAudit(pool, {
        sessionId: session.id,
        action: "replay.cancel",
        targetType: "replay_run",
        targetId: params.data.replayRunId,
        outcome: "CANCELLED",
        correlationId: request.id
      });
      return v2Data(
        { replayRunId: params.data.replayRunId, status: "CANCELLED" },
        { applicationWrite: true, blockchainWrite: false, ownership: "research-session" }
      );
    } catch (error) {
      return v2Error(
        reply,
        503,
        "REPLAY_CANCEL_FAILED",
        error instanceof Error ? error.message : "Replay cancel failed",
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
      if (existing !== null && ["COMPLETED", "SUCCEEDED"].includes(existing.status)) {
        const replay = await getLatestReplayRunForExperiment(pool, {
          sessionId: session.id,
          experimentId: experiment.experimentId
        });
        return v2Data(
          { replay: replay === null ? serializeReplayRun(existing) : serializeReplayRun(replay), idempotentReplay: true },
          { applicationWrite: false, blockchainWrite: false, sourcePlane: "MAINNET_HISTORICAL" }
        );
      }
      if (existing !== null && ["QUEUED", "RUNNING"].includes(existing.status)) {
        return await v2Error(reply, 409, "REPLAY_ALREADY_RUNNING", "Historical qualification is already running", true, request.id);
      }
      const sessionReplayCount = await countReplayRuns(pool, { sessionId: session.id });
      if (sessionReplayCount >= MaxReplayRunsPerSession) {
        return await v2Error(
          reply,
          429,
          "REPLAY_QUOTA_EXCEEDED",
          "Research-session replay quota exceeded",
          true,
          request.id,
          { quota: MaxReplayRunsPerSession }
        );
      }
      const replayRun = await createReplayRun(pool, {
        sessionId: session.id,
        experimentId: experiment.experimentId,
        configurationId: experiment.configuration.id,
        frozenNow: new Date(),
        sourceVersion: ReplaySourceVersion,
        queryVersion: ReplayQueryVersion,
        inputHash,
        idempotencyKey,
        idempotencyHash: sha256(
          stableJson({
            route: "POST /api/v2/experiments/:experimentId/replay",
            experimentId: experiment.experimentId,
            inputHash
          })
        ),
        capability: HISTORICAL_BOOK_RECONSTRUCTION_CAPABILITY,
        checkpoints: {
          sourcePlane: "MAINNET_HISTORICAL",
          antiLookahead: "STRICTLY_BEFORE_DECISION_AT",
          bookReconstruction: HISTORICAL_BOOK_RECONSTRUCTION_CAPABILITY
        }
      });
      scheduleReplay(replayRun, experiment);
      await writeAudit(pool, {
        sessionId: session.id,
        action: "replay.start",
        targetType: "replay_run",
        targetId: replayRun.id,
        outcome: "QUEUED",
        correlationId: request.id,
        safeMetadata: { experimentId: experiment.experimentId, sourcePlane: "MAINNET_HISTORICAL" }
      });
      return await reply.code(202).send(v2Data(
        { replay: serializeReplayRun(replayRun), idempotentReplay: false },
        {
          applicationWrite: true,
          blockchainWrite: false,
          sourcePlane: "MAINNET_HISTORICAL",
          outcomeEmbargo: "outcomes persisted only after decision frame hashes"
        }
      ));
    } catch (error) {
      if (error instanceof Error && error.message === "IDEMPOTENCY_BODY_MISMATCH") {
        return await v2Error(
          reply,
          409,
          "IDEMPOTENCY_BODY_MISMATCH",
          "Idempotency-Key was already used with a different canonical request body",
          false,
          request.id
        );
      }
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

  app.get("/api/v2/experiments/:experimentId/evidence", async (request, reply) => {
    const params = z.object({ experimentId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return await v2Error(reply, 400, "EXPERIMENT_ID_INVALID", "Experiment ID is invalid", false, request.id, params.error.issues);
    }
    try {
      const pool = requirePool(deps);
      const ensured = await ensureResearchSession(pool, config, request, reply);
      const result = await pool.query<AssessmentDetailRow>(
        `
          SELECT
            evidence_assessments.id AS assessment_id,
            metric_runs.id AS metric_run_id,
            experiments.id AS experiment_id,
            experiments.name AS experiment_name,
            evidence_assessments.verdict,
            evidence_assessments.reason_codes,
            metric_runs.sample_size,
            metric_runs.exclusion_count,
            metric_runs.brier_score,
            metric_runs.calibration_bias,
            metric_runs.neutral_baseline_delta,
            metric_runs.execution_metrics,
            metric_runs.pnl_status,
            metric_runs.evidence_plane,
            metric_runs.replay_run_id,
            metric_runs.promotion_scope,
            evidence_assessments.thresholds,
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
      return v2Data(
        {
          ...buildEvidenceGate({ row: result.rows[0] ?? null, experimentId: params.data.experimentId }),
          csrfToken: ensured.csrfToken
        },
        {
          ownership: "research-session",
          sourcePlane: "MAINNET_HISTORICAL",
          verdictAuthority: "server-evaluation-engine"
        }
      );
    } catch (error) {
      return v2Error(
        reply,
        503,
        "EVIDENCE_GATE_UNAVAILABLE",
        error instanceof Error ? error.message : "Evidence Gate unavailable",
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
      if (replay === null || !["COMPLETED", "SUCCEEDED"].includes(replay.status)) {
        return await v2Error(reply, 409, "REPLAY_REQUIRED", "Run historical qualification before evaluating evidence", false, request.id);
      }
      const assessment = await runMetricAssessment({
        pool,
        experimentId: experiment.experimentId,
        policyVersionId: policy.policyVersionId,
        replayRunId: replay.id,
        evidencePlane: "MAINNET_HISTORICAL",
        promotionScope: "PROMOTE_TO_FORWARD_OBSERVATION",
        ruleVersion: "eval-002-historical-replay-v1",
        provenance: {
          replayRunId: replay.id,
          replayOutputHash: replay.outputHash,
          sourcePlane: "MAINNET_HISTORICAL",
          pnlLabel: "REPLAY_COUNTERFACTUAL_OR_NOT_AVAILABLE",
          bookReconstruction: HISTORICAL_BOOK_RECONSTRUCTION_CAPABILITY
        }
      });
      await writeAudit(pool, {
        sessionId: session.id,
        action: "evaluation.create",
        targetType: "experiment",
        targetId: experiment.experimentId,
        outcome: assessment.verdict,
        correlationId: request.id,
        safeMetadata: { assessmentId: assessment.assessmentId, replayRunId: replay.id }
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
      await writeAudit(pool, {
        sessionId: session.id,
        action: "live_shadow.observe",
        targetType: "experiment",
        targetId: experiment.experimentId,
        outcome: "OBSERVED",
        correlationId: request.id,
        safeMetadata: { observedMarkets: result.observed.length, sourcePlane: "SHANNON_FORWARD" }
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

  app.get("/api/v2/comparisons", async (request, reply) => {
    try {
      const pool = requirePool(deps);
      const ensured = await ensureResearchSession(pool, config, request, reply);
      const comparisons = await listComparisons(pool, {
        sessionId: ensured.session.id,
        limit: 20
      });
      return v2Data(
        {
          comparisons,
          csrfToken: ensured.csrfToken
        },
        { ownership: "research-session", comparisonSource: "immutable-assessments" }
      );
    } catch (error) {
      return v2Error(
        reply,
        503,
        "COMPARISON_LIST_UNAVAILABLE",
        error instanceof Error ? error.message : "Comparison list unavailable",
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
      const comparisonCount = await countComparisonSets(pool, { sessionId: session.id });
      if (comparisonCount >= MaxComparisonsPerSession) {
        return await v2Error(
          reply,
          429,
          "COMPARISON_QUOTA_EXCEEDED",
          "Research-session comparison quota exceeded",
          true,
          request.id,
          { quota: MaxComparisonsPerSession }
        );
      }
      const client = await pool.connect();
      let comparisonId: string;
      try {
        await client.query("BEGIN");
        const idempotencyHash = sha256(
          stableJson({
            route: "POST /api/v2/comparisons",
            body: parsed.data
          })
        );
        const existing = await client.query<{ readonly id: string; readonly idempotency_hash: string | null }>(
          `
            SELECT id, idempotency_hash
            FROM comparison_sets
            WHERE created_by_session_id = $1
              AND idempotency_key = $2
            ORDER BY created_at DESC
            LIMIT 1
          `,
          [session.id, idempotencyKey]
        );
        const existingRow = existing.rows[0];
        if (existingRow !== undefined && existingRow.idempotency_hash !== null && existingRow.idempotency_hash !== idempotencyHash) {
          throw new Error("IDEMPOTENCY_BODY_MISMATCH");
        }
        if (existingRow === undefined) {
          const comparison = await client.query<{ id: string }>(
            `
              INSERT INTO comparison_sets(created_by_session_id, name, idempotency_key, idempotency_hash)
              VALUES ($1, $2, $3, $4)
              RETURNING id
            `,
            [session.id, parsed.data.name, idempotencyKey, idempotencyHash]
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
        if (error instanceof Error && error.message === "IDEMPOTENCY_BODY_MISMATCH") {
          return await v2Error(
            reply,
            409,
            "IDEMPOTENCY_BODY_MISMATCH",
            "Idempotency-Key was already used with a different canonical request body",
            false,
            request.id
          );
        }
        throw error;
      } finally {
        client.release();
      }
      const comparison = await loadComparison(pool, { sessionId: session.id, comparisonId });
      await writeAudit(pool, {
        sessionId: session.id,
        action: "comparison.create",
        targetType: "comparison_set",
        targetId: comparisonId,
        outcome: "CREATED",
        correlationId: request.id,
        safeMetadata: { assessmentCount: uniqueIds.length }
      });
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
        frozenAtSeconds: result.value.frozenAtSeconds,
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
      {
        ...(query.data.limit === undefined ? {} : { limit: query.data.limit }),
        fromSec: Math.max(market.value.tradingStartSeconds, query.data.fromSec ?? market.value.tradingStartSeconds),
        toSec: Math.min(market.value.expirySeconds, query.data.toSec ?? market.value.expirySeconds)
      }
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
    return v2Data(
      { candles: candles.value },
      {
        marketId: market.value.stableMarketId,
        marketWindow: {
          fromSec: market.value.tradingStartSeconds,
          toSec: market.value.expirySeconds,
          poolAddress: market.value.poolAddress
        },
        source: market.value.source
      }
    );
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
      const chain = await summarizeChainEvidence(pool);
      return {
        ok: true,
        summary: {
          publicProofAvailable: chain.submittedOrderCount > 0 && chain.terminalOrderCount > 0,
          latestTerminalState: chain.latestTerminalState ?? "UNAVAILABLE",
          fillCount: chain.fillCount,
          evidenceScope: "judge-facing public proof only"
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
    return reply.code(410).send({
      ok: false,
      reasonCode: "LEGACY_MUTATION_GONE",
      message: "Legacy observation mutation is disabled; use the owned v2 live-shadow route"
    });
  });

  app.post("/api/v1/settlements/reconcile", async (request, reply) => {
    return reply.code(410).send({
      ok: false,
      reasonCode: "LEGACY_MUTATION_GONE",
      message: "Global legacy reconciliation is disabled; use the owned v2 experiment route"
    });
  });

  app.post("/api/v1/experiments/:experimentId/evaluate", async (request, reply) => {
    return reply.code(410).send({
      ok: false,
      reasonCode: "LEGACY_MUTATION_GONE",
      message: "Legacy evaluation mutation is disabled; use the owned v2 evaluation route"
    });
  });

  return app;
}
