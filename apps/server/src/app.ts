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
  createInteractiveExperiment,
  createResearchSession,
  findActiveResearchSessionByTokenHash,
  getInteractiveExperiment,
  listInteractiveExperiments,
  rotateResearchSessionCsrf,
  upsertPolicyVersion,
  type InteractiveExperimentDetailRecord,
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
  type HistoricalIndexerFetch,
  type HistoricalMarketFilters,
  type HistoricalPageOptions,
  type HistoricalTimeWindowPageOptions,
  type MainnetHistoricalDreamDexConfig
} from "@edgelab/dreamdex";
import { runMetricAssessment } from "@edgelab/evaluate";
import { observeExperiment } from "@edgelab/observe";
import { createPolicyManifest, referencePolicies, type PolicyAdapter } from "@edgelab/policy-runtime";
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

function policySupportedInMode(policyId: string, mode: "HISTORICAL_REPLAY" | "LIVE_SHADOW"): boolean {
  return mode === "LIVE_SHADOW" || policyId !== "reference-book-tilt";
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
        policies: policyAdapters.map((adapter) => ({
          ...createPolicyManifest(adapter),
          supportedPlanes:
            adapter.policyId === "reference-book-tilt"
              ? ["SHANNON_FORWARD"]
              : ["MAINNET_HISTORICAL", "SHANNON_FORWARD"],
          description:
            adapter.policyId === "reference-book-tilt"
              ? "Captured-book tilt baseline. Historical use remains disabled until book reconstruction is verified."
              : "Neutral watch-only baseline for calibration and workflow validation."
        }))
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
      const policy = policyAdapters.find(
        (adapter) => adapter.policyId === parsed.data.policyId && adapter.version === parsed.data.policyVersion
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
      const policyManifest = createPolicyManifest(policy);
      const policyVersionId = await upsertPolicyVersion(pool, {
        ...policyManifest,
        manifest: {
          ...policyManifest,
          supportedPlanes:
            policy.policyId === "reference-book-tilt"
              ? ["SHANNON_FORWARD"]
              : ["MAINNET_HISTORICAL", "SHANNON_FORWARD"]
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
          sourceHash: policyManifest.sourceHash
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
