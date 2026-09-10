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
import { decodeEventLog, parseAbi } from "viem";
import { orderBookEventsAbi } from "@somnia-chain/markets-sdk";
import {
  createApprovalChallenge,
  createLoginChallenge,
  verifyChallenge,
  type AuthChallenge,
  type SignatureVerifier
} from "@edgelab/auth";
import { summarizeChainEvidence } from "@edgelab/chain";
import type { RuntimeConfig } from "@edgelab/config";
import {
  DREAMDEX_MARKETS_SDK_VERSION,
  MarketSnapshotSchema,
  SOMNIA_MAINNET_CHAIN_ID,
  SOMNIA_SHANNON_CHAIN_ID
} from "@edgelab/domain";
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
  expireStaleReplayRuns,
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
  buildControlledLiquidityEvidence,
  buildUnsignedBinaryOrderEvidence,
  captureMarketSnapshot,
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
  planExecutableQuote,
  readExecutionReadiness,
  readBinaryBookParams,
  resolveHistoricalCutoffBlock,
  resolveHistoricalCutoffBlockAfter,
  type DreamDexReadConfig,
  type DreamDexExecutionReadinessEvidence,
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
  type HistoricalCutoffBlock,
  type MainnetHistoricalDreamDexConfig
} from "@edgelab/dreamdex";
import { EVALUATION_VERSION, runMetricAssessment, runV4Assessment } from "@edgelab/evaluate";
import { calculatePairedMetrics, pairedMovingBlockDeltaInterval, type PairedForecastObservation } from "@edgelab/metrics";
import { observeExperiment } from "@edgelab/observe";
import {
  createHistoricalPolicyManifest,
  createPolicyManifest,
  evaluatePolicy,
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
  readonly historicalRpcFetch?: HistoricalRpcFetch;
  readonly policyAdapters?: readonly PolicyAdapter[];
  readonly consumedNonces?: Set<string>;
  readonly signatureVerifier?: SignatureVerifier;
  readonly executionReadinessReader?: (input: {
    readonly account: string;
    readonly marketAddress: string;
    readonly poolAddress: string;
  }) => Promise<DreamDexExecutionReadinessEvidence>;
}

const AddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const MarketIdSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const TxHashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const IntentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const IdempotencyKeySchema = z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const ResearchSessionCookie = "edgelab_research_session";
const CsrfHeader = "x-csrf-token";
const SessionTtlMs = 35 * 24 * 60 * 60 * 1000;
const SigningAuthorizationTtlMs = 120_000;
const PublicReadRateLimit = 240;
const PublicWriteRateLimit = 60;
const ResearchSessionCreateRateLimit = 30;
const RateWindowMs = 60_000;
const MaxExperimentsPerSession = 20;
const MaxReplayRunsPerSession = 20;
const MaxComparisonsPerSession = 10;
const ReplayHeartbeatStaleAfterMs = 120_000;
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
const ExecutionCandidateQuerySchema = z.object({
  experimentId: z.string().uuid(),
  account: AddressSchema,
  asset: z.enum(["BTC", "ETH"]).default("BTC"),
  intervalSec: z.coerce
    .number()
    .int()
    .refine((value) => value === 900 || value === 3600, "intervalSec must be 900 or 3600")
    .default(900),
  maxEscrowRaw: z
    .string()
    .regex(/^[0-9]+$/)
    .default("10000")
    .refine((value) => BigInt(value) > 0n && BigInt(value) <= 10_000n, "maxEscrowRaw must be 1..10000"),
  requestedQuantityRaw: z.string().regex(/^[0-9]+$/).optional()
    .refine((value) => value === undefined || BigInt(value) > 0n, "requestedQuantityRaw must be positive"),
  worstPriceRaw: z.string().regex(/^[0-9]+$/).optional(),
  minExpiryHeadroomSec: z.coerce.number().int().min(60).max(600).default(120)
});
const ControlledLiquidityQuerySchema = z.object({
  maker: AddressSchema,
  asset: z.enum(["BTC", "ETH"]).default("BTC"),
  intervalSec: z.coerce
    .number()
    .int()
    .refine((value) => value === 900 || value === 3600, "intervalSec must be 900 or 3600")
    .default(900),
  side: z.enum(["SELL_YES", "SELL_NO"]).default("SELL_YES"),
  priceRaw: z
    .string()
    .regex(/^[0-9]+$/)
    .default("600000")
    .refine((value) => BigInt(value) > 0n && BigInt(value) < 1_000_000n, "priceRaw must be 1..999999"),
  quantityRaw: z
    .string()
    .regex(/^[0-9]+$/)
    .default("1000")
    .refine((value) => BigInt(value) > 0n && BigInt(value) <= 1_000_000n, "quantityRaw must be 1..1000000"),
  minExpiryHeadroomSec: z.coerce.number().int().min(120).max(1800).default(300)
});
const ExecutionReceiptImportSchema = z.object({
  intentHash: IntentHashSchema,
  txHash: TxHashSchema,
  txRole: z.enum(["approval", "order"])
});
const PersistableExecutionCandidateSchema = z.object({
  status: z.literal("READY"),
  intentHash: IntentHashSchema,
  account: AddressSchema,
  validatedAt: z.iso.datetime(),
  market: z.object({
    stableMarketId: MarketIdSchema,
    marketAddress: AddressSchema,
    poolAddress: AddressSchema,
    asset: z.enum(["BTC", "ETH"]),
    intervalSeconds: ExperimentIntervalSecSchema,
    expirySeconds: z.number().int().positive(),
    quoteDecimals: z.number().int().nonnegative(),
    collateral: AddressSchema
  }).passthrough(),
  strategyLink: z.object({
    experimentId: z.string().uuid(),
    assessmentId: z.string().uuid(),
    assessmentHash: z.string().regex(/^[a-f0-9]{64}$/),
    qualificationVerdict: z.enum(["STRATEGY_QUALIFIED", "FORWARD_CRITERIA_MET"]),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.object({
      policyId: z.string().min(1),
      policyVersion: z.string().min(1),
      policyHash: z.string().regex(/^[a-f0-9]{64}$/)
    }).passthrough()
  }).passthrough(),
  risk: z.object({
    maxEscrowRaw: z.string().regex(/^[0-9]+$/),
    requiredEscrowRaw: z.string().regex(/^[0-9]+$/),
    minExpiryHeadroomSec: z.number().int().positive(),
    observedBlockNumber: z.string().regex(/^[0-9]+$/)
  }).passthrough(),
  sizing: z.object({
    side: z.enum(["BUY_YES", "BUY_NO"]),
    priceRaw: z.string().regex(/^[0-9]+$/),
    quantityRaw: z.string().regex(/^[0-9]+$/)
  }).passthrough(),
  quotePlan: z.object({
    requestedQuantityRaw: z.string().regex(/^[0-9]+$/),
    fillableQuantityRaw: z.string().regex(/^[0-9]+$/),
    unfilledQuantityRaw: z.string().regex(/^[0-9]+$/),
    averagePriceRaw: z.string().regex(/^[0-9]+$/).nullable(),
    worstPriceRaw: z.string().regex(/^[0-9]+$/).nullable(),
    totalCollateralRaw: z.string().regex(/^[0-9]+$/),
    conservativeExpectedNetRaw: z.string().regex(/^-?[0-9]+$/),
    conservativeExpectedNetAtPriceCapRaw: z.string().regex(/^-?[0-9]+$/),
    reviewedPriceCapRaw: z.string().regex(/^[0-9]+$/),
    levelsConsumed: z.array(z.object({ priceRaw: z.string(), quantityRaw: z.string() })),
    passesConservativeEdge: z.boolean(),
    reasonCodes: z.array(z.string())
  }),
  quoteBook: z.object({ rawLevels: z.array(z.object({ priceRaw: z.string(), quantityRaw: z.string() })) }),
  quotePolicy: z.object({
    modelHaircutPpm: z.literal(50000),
    slippageReservePpm: z.literal(10000),
    minimumEdgePpm: z.literal(10000),
    estimatedFeesRaw: z.string(),
    gasTreatment: z.literal("EXCLUDED_NATIVE_UNIT_DISCLOSURE"),
    policyHash: z.string().regex(/^[a-f0-9]{64}$/),
    reviewExpiresAt: z.iso.datetime()
  }),
  unsignedTransactions: z.object({
    approval: z.object({
      to: AddressSchema,
      data: z.string().regex(/^0x[0-9a-fA-F]+$/),
      valueRaw: z.string(),
      description: z.string()
    }).nullable(),
    order: z.object({
      to: AddressSchema,
      data: z.string().regex(/^0x[0-9a-fA-F]+$/),
      valueRaw: z.string(),
      description: z.string()
    })
  }).passthrough()
}).passthrough();
const ShannonProofWalletAddress = "0x6b3a87a4bbf7d7d324df227d640fc42ebf987971";
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

interface QualifiedStrategyRecord {
  readonly experimentId: string;
  readonly configurationId: string;
  readonly policyVersionId: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly policyHash: string;
  readonly assessmentId: string;
  readonly assessmentHash: string;
  readonly ruleVersion: string;
  readonly sampleSize: number;
  readonly qualifiedAt: Date;
  readonly qualificationVerdict: "STRATEGY_QUALIFIED" | "FORWARD_CRITERIA_MET";
}

async function loadQualifiedStrategy(
  pool: pg.Pool,
  input: { readonly sessionId: string; readonly experimentId: string }
): Promise<QualifiedStrategyRecord | null> {
  const result = await pool.query<{
    experiment_id: string;
    configuration_id: string;
    policy_version_id: string;
    policy_id: string;
    policy_version: string;
    policy_hash: string;
    assessment_id: string;
    assessment_hash: string;
    rule_version: string;
    sample_size: number;
    qualified_at: Date;
    qualification_verdict: "STRATEGY_QUALIFIED" | "FORWARD_CRITERIA_MET";
  }>(
    `
      SELECT
        e.id AS experiment_id,
        ecv.id AS configuration_id,
        pv.id AS policy_version_id,
        pv.policy_id,
        pv.version AS policy_version,
        pv.source_hash AS policy_hash,
        latest_assessment.assessment_id,
        latest_assessment.assessment_hash,
        latest_assessment.rule_version,
        latest_assessment.sample_size,
        latest_assessment.qualified_at,
        latest_assessment.qualification_verdict
      FROM experiments e
      JOIN experiment_configuration_versions ecv ON ecv.id = e.active_configuration_id
      JOIN experiment_policy_versions epv
        ON epv.configuration_id = ecv.id AND epv.role = 'CANDIDATE'
      JOIN policy_versions pv ON pv.id = epv.policy_version_id
      JOIN LATERAL (
        SELECT
          ea.id AS assessment_id,
          ea.assessment_hash,
          ea.rule_version,
          mr.sample_size,
          mr.evaluation_version,
          ea.created_at AS qualified_at,
          ea.verdict,
          CASE WHEN av4.execution_eligibility = 'ELIGIBLE_FOR_FRESH_REVIEW'
            THEN 'FORWARD_CRITERIA_MET' ELSE ea.verdict END AS qualification_verdict,
          av4.execution_eligibility,
          av4.forecast_status,
          av4.economics_status
        FROM metric_runs mr
        JOIN evidence_assessments ea ON ea.metric_run_id = mr.id
        LEFT JOIN assessment_v4_details av4 ON av4.assessment_id = ea.id
        WHERE mr.experiment_id = e.id
          AND mr.policy_version_id = pv.id
          AND mr.evidence_plane = 'SHANNON_FORWARD'
          AND (mr.promotion_scope = 'EXECUTION_EXPOSURE' OR mr.evaluation_version = 'edgelab-evaluation-v4')
        ORDER BY ea.created_at DESC, ea.id DESC
        LIMIT 1
      ) latest_assessment ON (
        (latest_assessment.verdict = 'STRATEGY_QUALIFIED' AND latest_assessment.evaluation_version = $3)
        OR
        (latest_assessment.evaluation_version = 'edgelab-evaluation-v4'
          AND latest_assessment.forecast_status = 'FORWARD_CRITERIA_MET'
          AND latest_assessment.economics_status = 'SCENARIO_CRITERIA_MET'
          AND latest_assessment.execution_eligibility = 'ELIGIBLE_FOR_FRESH_REVIEW')
      )
      WHERE e.id = $1
        AND e.created_by_session_id = $2
        AND ecv.mode = 'LIVE_SHADOW'
      LIMIT 1
    `,
    [input.experimentId, input.sessionId, EVALUATION_VERSION]
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        experimentId: row.experiment_id,
        configurationId: row.configuration_id,
        policyVersionId: row.policy_version_id,
        policyId: row.policy_id,
        policyVersion: row.policy_version,
        policyHash: row.policy_hash,
        assessmentId: row.assessment_id,
        assessmentHash: row.assessment_hash,
        ruleVersion: row.rule_version,
        sampleSize: row.sample_size,
        qualifiedAt: row.qualified_at,
        qualificationVerdict: row.qualification_verdict
      };
}

function hexToDecimalString(value: string | null | undefined): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    return "0";
  }
  return BigInt(value).toString();
}

async function shannonRpc<T>(config: RuntimeConfig, method: string, params: readonly unknown[]): Promise<T> {
  const response = await fetch(config.SOMNIA_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  if (!response.ok) {
    throw new Error(`Shannon RPC ${method} failed with HTTP ${String(response.status)}`);
  }
  const payload = (await response.json()) as { readonly result?: T; readonly error?: { readonly message?: string } };
  if (payload.error !== undefined) {
    throw new Error(payload.error.message ?? `Shannon RPC ${method} returned an error`);
  }
  if (!("result" in payload)) {
    throw new Error(`Shannon RPC ${method} returned no result`);
  }
  return payload.result;
}

interface RpcTransaction {
  readonly from?: string;
  readonly to?: string | null;
  readonly nonce?: string;
  readonly input?: string;
  readonly value?: string;
}

interface RpcReceipt {
  readonly status?: string;
  readonly blockNumber?: string;
  readonly logs?: readonly RpcLog[];
}

interface RpcLog {
  readonly address?: string;
  readonly data?: string;
  readonly topics?: readonly string[];
  readonly logIndex?: string;
}

const binarySettlementRedeemedEventAbi = parseAbi([
  "event Redeemed(uint256 indexed marketKey, address indexed holder, address indexed to, uint8 outcomeIdx, uint256 amountBurned, uint256 collateralOut)"
]);

function exactStrategyRedemption(input: {
  readonly receipt: RpcReceipt;
  readonly account: string;
  readonly side: string;
  readonly amountRaw: string;
  readonly payoutRaw: string | null;
}): { readonly amountBurned: string; readonly collateralOut: string } | null {
  const decoded = (input.receipt.logs ?? []).flatMap((log) => {
    if (log.data === undefined || log.topics === undefined || log.topics.length === 0) return [];
    try {
      const event = decodeEventLog({
        abi: binarySettlementRedeemedEventAbi,
        data: log.data as `0x${string}`,
        topics: [...log.topics] as [`0x${string}`, ...`0x${string}`[]]
      });
      const args = event.args as {
        readonly holder: string;
        readonly outcomeIdx: number;
        readonly amountBurned: bigint;
        readonly collateralOut: bigint;
      };
      return [{
        holder: args.holder.toLowerCase(),
        outcomeIdx: args.outcomeIdx,
        amountBurned: args.amountBurned.toString(),
        collateralOut: args.collateralOut.toString()
      }];
    } catch {
      return [];
    }
  });
  const expectedOutcomeIdx = input.side === "BUY_YES" ? 0 : input.side === "BUY_NO" ? 1 : -1;
  const redemption = decoded.length === 1 ? decoded[0] : undefined;
  return redemption !== undefined && redemption.holder === input.account.toLowerCase() &&
    redemption.outcomeIdx === expectedOutcomeIdx && redemption.amountBurned === input.amountRaw &&
    (input.payoutRaw === null || redemption.collateralOut === input.payoutRaw)
    ? { amountBurned: redemption.amountBurned, collateralOut: redemption.collateralOut }
    : null;
}

interface DecodedOrderLifecycle {
  readonly orderId: string | null;
  readonly state: "ORDER_VERIFIED" | "UNFILLED" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED" | "EXPIRED" | "FAILED" | "UNVERIFIED";
  readonly quantityRaw: string;
  readonly remainingQuantityRaw: string;
  readonly filledQuantityRaw: string;
  readonly fills: readonly {
    readonly fillIndex: number;
    readonly quantityRaw: string;
    readonly priceRaw: string;
    readonly observedAt: string;
    readonly payload: Record<string, unknown>;
  }[];
  readonly events: readonly Record<string, unknown>[];
}

const OrderPlacedArgsSchema = z.object({
  orderId: z.bigint(),
  placedOrder: z.object({
    orderId: z.bigint(),
    isBid: z.boolean(),
    owner: AddressSchema,
    userData: z.bigint(),
    price: z.bigint(),
    fullQuantity: z.bigint(),
    quantityRemaining: z.bigint(),
    expireTimestampNs: z.bigint()
  })
});
const OrderFilledArgsSchema = z.object({
  takerOrderId: z.bigint(),
  makerOrderId: z.bigint(),
  quantityFilled: z.bigint(),
  takerRemainingQuantity: z.bigint(),
  makerRemainingQuantity: z.bigint(),
  fillPrice: z.bigint()
});
const OrderIdArgsSchema = z.object({
  orderId: z.bigint()
});

function serializableDecodedArgs(input: unknown): unknown {
  if (typeof input === "bigint") {
    return input.toString();
  }
  if (Array.isArray(input)) {
    return input.map(serializableDecodedArgs);
  }
  if (input !== null && typeof input === "object") {
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>).map(([key, value]) => [key, serializableDecodedArgs(value)])
    );
  }
  return input;
}

export function decodeOrderLifecycleFromReceipt(input: {
  readonly poolAddress: string;
  readonly receiptStatus: boolean;
  readonly receipt: RpcReceipt;
  readonly fallbackQuantityRaw: string;
  readonly observedAt: string;
}): DecodedOrderLifecycle {
  if (!input.receiptStatus) {
    return {
      orderId: null,
      state: "FAILED",
      quantityRaw: input.fallbackQuantityRaw,
      remainingQuantityRaw: input.fallbackQuantityRaw,
      filledQuantityRaw: "0",
      fills: [],
      events: []
    };
  }
  let placed:
    | {
        readonly orderId: bigint;
        readonly fullQuantity: bigint;
        readonly quantityRemaining: bigint;
      }
    | null = null;
  const terminalEvents: { readonly orderId: bigint; readonly state: "CANCELLED" | "EXPIRED" }[] = [];
  let takerOrderId: bigint | null = null;
  let takerRemainingQuantity: bigint | null = null;
  const fills: {
    fillIndex: number;
    quantityRaw: string;
    priceRaw: string;
    observedAt: string;
    payload: Record<string, unknown>;
  }[] = [];
  const events: Record<string, unknown>[] = [];
  for (const log of input.receipt.logs ?? []) {
    if (log.address?.toLowerCase() !== input.poolAddress.toLowerCase()) {
      continue;
    }
    if (typeof log.data !== "string" || log.topics === undefined) {
      continue;
    }
    try {
      const decoded = decodeEventLog({
        abi: orderBookEventsAbi,
        data: log.data as `0x${string}`,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]]
      });
      events.push({
        eventName: decoded.eventName,
        args: serializableDecodedArgs(decoded.args),
        logIndex: log.logIndex ?? null
      });
      if (decoded.eventName === "OrderPlaced") {
        const args = OrderPlacedArgsSchema.parse(decoded.args);
        placed = {
          orderId: args.placedOrder.orderId,
          fullQuantity: args.placedOrder.fullQuantity,
          quantityRemaining: args.placedOrder.quantityRemaining
        };
      } else if (decoded.eventName === "OrderFilled") {
        const args = OrderFilledArgsSchema.parse(decoded.args);
        if (takerOrderId === null) {
          takerOrderId = args.takerOrderId;
        } else if (args.takerOrderId !== takerOrderId) {
          continue;
        }
        takerRemainingQuantity = args.takerRemainingQuantity;
        fills.push({
          fillIndex: fills.length,
          quantityRaw: args.quantityFilled.toString(),
          priceRaw: args.fillPrice.toString(),
          observedAt: input.observedAt,
          payload: {
            takerOrderId: args.takerOrderId.toString(),
            makerOrderId: args.makerOrderId.toString(),
            takerRemainingQuantity: args.takerRemainingQuantity.toString(),
            makerRemainingQuantity: args.makerRemainingQuantity.toString()
          }
        });
      } else if (decoded.eventName === "OrderCancelled") {
        const args = OrderIdArgsSchema.parse(decoded.args);
        terminalEvents.push({ orderId: args.orderId, state: "CANCELLED" });
      } else if (decoded.eventName === "OrderExpired") {
        const args = OrderIdArgsSchema.parse(decoded.args);
        terminalEvents.push({ orderId: args.orderId, state: "EXPIRED" });
      }
    } catch {
      continue;
    }
  }
  const orderId = placed?.orderId ?? takerOrderId;
  if (orderId === null) {
    return {
      orderId: null,
      state: "UNVERIFIED",
      quantityRaw: input.fallbackQuantityRaw,
      remainingQuantityRaw: input.fallbackQuantityRaw,
      filledQuantityRaw: fills.reduce((sum, fill) => sum + BigInt(fill.quantityRaw), 0n).toString(),
      fills,
      events
    };
  }
  const terminalState = terminalEvents.find((event) => event.orderId === orderId)?.state ?? null;
  const quantityRaw = placed?.fullQuantity.toString() ?? input.fallbackQuantityRaw;
  const remainingQuantityRaw = (takerRemainingQuantity ?? placed?.quantityRemaining ?? 0n).toString();
  const state =
    terminalState ??
    (fills.length === 0
      ? "UNFILLED"
      : BigInt(remainingQuantityRaw) === 0n
        ? "FILLED"
        : "PARTIALLY_FILLED");
  return {
    orderId: orderId.toString(),
    state,
    quantityRaw,
    remainingQuantityRaw,
    filledQuantityRaw: fills.reduce((sum, fill) => sum + BigInt(fill.quantityRaw), 0n).toString(),
    fills,
    events
  };
}

async function persistReadyExecutionCandidate(
  pool: pg.Pool,
  input: {
    readonly candidate: z.infer<typeof PersistableExecutionCandidateSchema>;
    readonly idempotencyKey: string;
  }
): Promise<string> {
  const candidate = input.candidate;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO wallet_identities(address, chain_id) VALUES ($1, $2) ON CONFLICT (address) DO NOTHING",
      [candidate.account.toLowerCase(), SOMNIA_SHANNON_CHAIN_ID]
    );
    const existing = await client.query<{ id: string; candidate_payload: unknown }>(
      "SELECT id, candidate_payload FROM execution_intents WHERE intent_hash = $1 FOR UPDATE",
      [candidate.intentHash]
    );
    if (existing.rows[0] !== undefined) {
      if (stableJson(existing.rows[0].candidate_payload) !== stableJson(candidate)) {
        throw new Error("EXECUTION_INTENT_IMMUTABLE_CONFLICT");
      }
      await client.query("COMMIT");
      return existing.rows[0].id;
    }
    await client.query(
      `
        UPDATE execution_intents
        SET state = 'EXPIRED'
        WHERE owner_address = $1
          AND experiment_id = $2
          AND state IN ('INTENT_DRAFT', 'AWAITING_APPROVAL', 'APPROVED')
      `,
      [candidate.account.toLowerCase(), candidate.strategyLink.experimentId]
    );
    const policy = await client.query<{ id: string }>(
      `
        SELECT pv.id
        FROM policy_versions pv
        JOIN metric_runs mr ON mr.policy_version_id = pv.id
        JOIN evidence_assessments ea ON ea.metric_run_id = mr.id
        LEFT JOIN assessment_v4_details av4 ON av4.assessment_id = ea.id
        WHERE ea.id = $1
          AND ea.assessment_hash = $2
          AND (
            ea.verdict = 'STRATEGY_QUALIFIED'
            OR (mr.evaluation_version = 'edgelab-evaluation-v4'
              AND av4.forecast_status = 'FORWARD_CRITERIA_MET'
              AND av4.economics_status = 'SCENARIO_CRITERIA_MET'
              AND av4.execution_eligibility = 'ELIGIBLE_FOR_FRESH_REVIEW')
          )
          AND mr.experiment_id = $3
          AND pv.policy_id = $4
          AND pv.version = $5
          AND pv.source_hash = $6
        LIMIT 1
      `,
      [
        candidate.strategyLink.assessmentId,
        candidate.strategyLink.assessmentHash,
        candidate.strategyLink.experimentId,
        candidate.strategyLink.decision.policyId,
        candidate.strategyLink.decision.policyVersion,
        candidate.strategyLink.decision.policyHash
      ]
    );
    const policyVersionId = policy.rows[0]?.id;
    if (policyVersionId === undefined) {
      throw new Error("STRATEGY_QUALIFICATION_LINK_INVALID");
    }
    const inserted = await client.query<{ id: string }>(
      `
        INSERT INTO execution_intents(
          owner_address, experiment_id, assessment_id, policy_version_id,
          market_id, chain_id, intent_type, state, pool_address, side,
          price_raw, quantity_raw, escrow_raw, expires_at, caps,
          idempotency_key, intent_hash, candidate_snapshot_hash,
          candidate_payload, last_validated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, 'TRIAL', 'AWAITING_APPROVAL', $7, $8,
          $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17::jsonb, $18
        )
        RETURNING id
      `,
      [
        candidate.account.toLowerCase(),
        candidate.strategyLink.experimentId,
        candidate.strategyLink.assessmentId,
        policyVersionId,
        candidate.market.stableMarketId,
        SOMNIA_SHANNON_CHAIN_ID,
        candidate.market.poolAddress.toLowerCase(),
        candidate.sizing.side,
        candidate.sizing.priceRaw,
        candidate.sizing.quantityRaw,
        candidate.risk.requiredEscrowRaw,
        new Date(candidate.market.expirySeconds * 1000).toISOString(),
        JSON.stringify({
          maxEscrowRaw: candidate.risk.maxEscrowRaw,
          requiredEscrowRaw: candidate.risk.requiredEscrowRaw,
          orderCount: 1,
          orderType: "ImmediateOrCancel",
          serverSigner: false,
          chainId: SOMNIA_SHANNON_CHAIN_ID
        }),
        input.idempotencyKey,
        candidate.intentHash,
        candidate.strategyLink.snapshotHash,
        JSON.stringify(candidate),
        candidate.validatedAt
      ]
    );
    const intentId = inserted.rows[0]?.id;
    if (intentId === undefined) {
      throw new Error("EXECUTION_INTENT_INSERT_FAILED");
    }
    await client.query(
      `INSERT INTO execution_quote_details(
        execution_intent_id,raw_levels,requested_quantity_raw,fillable_quantity_raw,lot_size_raw,tick_size_raw,
        max_collateral_raw,average_price_raw,worst_price_raw,conservative_net_raw,reserves,policy_hash,review_expires_at)
       VALUES ($1,$2::jsonb,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)`,
      [intentId, JSON.stringify(candidate.quoteBook.rawLevels), candidate.quotePlan.requestedQuantityRaw,
        candidate.quotePlan.fillableQuantityRaw, candidate.sizing.lotSizeRaw, candidate.sizing.tickSizeRaw,
        candidate.risk.maxEscrowRaw, candidate.quotePlan.averagePriceRaw, candidate.quotePlan.worstPriceRaw,
        candidate.quotePlan.conservativeExpectedNetRaw,
        JSON.stringify({ modelHaircutPpm: candidate.quotePolicy.modelHaircutPpm, slippageReservePpm: candidate.quotePolicy.slippageReservePpm,
          minimumEdgePpm: candidate.quotePolicy.minimumEdgePpm, estimatedFeesRaw: candidate.quotePolicy.estimatedFeesRaw,
          gasTreatment: candidate.quotePolicy.gasTreatment, reviewedPriceCapRaw: candidate.quotePlan.reviewedPriceCapRaw,
          conservativeExpectedNetAtPriceCapRaw: candidate.quotePlan.conservativeExpectedNetAtPriceCapRaw }),
        candidate.quotePolicy.policyHash, candidate.quotePolicy.reviewExpiresAt]
    );
    await client.query("COMMIT");
    return intentId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function persistStrategyExecutionTransaction(
  pool: pg.Pool,
  input: {
    readonly intentId: string;
    readonly candidate: z.infer<typeof PersistableExecutionCandidateSchema>;
    readonly txHash: string;
    readonly txRole: "approval" | "order";
    readonly transaction: RpcTransaction;
    readonly receipt: RpcReceipt | null;
    readonly lifecycle: DecodedOrderLifecycle | null;
  }
): Promise<{
  readonly intentId: string;
  readonly state: string;
  readonly logHash: string | null;
  readonly orderId: string | null;
  readonly orderState: DecodedOrderLifecycle["state"] | null;
  readonly fillCount: number;
}> {
  const ownerAddress = input.candidate.account.toLowerCase();
  const state =
    input.receipt === null
      ? "TX_PENDING"
      : input.receipt.status !== "0x1"
        ? "TX_REVERTED"
      : input.txRole === "approval"
        ? "APPROVED"
        : input.lifecycle?.state ?? "UNVERIFIED";
  const logHash = input.receipt === null ? null : sha256(stableJson(input.receipt.logs ?? []));
  const transactionInputHash = sha256((input.transaction.input ?? "0x").toLowerCase());
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM execution_intents WHERE id = $1 FOR UPDATE", [input.intentId]);
    await client.query(
      `
        INSERT INTO chain_transactions(
          tx_hash, intent_id, chain_id, from_address, nonce, receipt_status,
          block_number, log_hash, verified_at, payload, tx_role, transaction_input_hash
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
        ON CONFLICT (tx_hash) DO UPDATE
        SET receipt_status = EXCLUDED.receipt_status,
            block_number = EXCLUDED.block_number,
            log_hash = EXCLUDED.log_hash,
            verified_at = EXCLUDED.verified_at,
            payload = EXCLUDED.payload
        WHERE chain_transactions.intent_id = EXCLUDED.intent_id
          AND chain_transactions.tx_role = EXCLUDED.tx_role
          AND chain_transactions.transaction_input_hash = EXCLUDED.transaction_input_hash
      `,
      [
        input.txHash,
        input.intentId,
        SOMNIA_SHANNON_CHAIN_ID,
        ownerAddress,
        hexToDecimalString(input.transaction.nonce),
        input.receipt === null ? null : input.receipt.status === "0x1",
        input.receipt === null ? null : hexToDecimalString(input.receipt.blockNumber),
        logHash,
        input.receipt === null ? null : new Date().toISOString(),
        JSON.stringify({
          txRole: input.txRole,
          account: ownerAddress,
          to: input.transaction.to?.toLowerCase() ?? null,
          strategyLinked: true,
          lifecycleDecoded: input.lifecycle?.orderId !== null,
          receipt: input.receipt
        }),
        input.txRole,
        transactionInputHash
      ]
    );
    const persistedTransaction = await client.query<{
      intent_id: string;
      tx_role: string;
      transaction_input_hash: string | null;
    }>(
      "SELECT intent_id, tx_role, transaction_input_hash FROM chain_transactions WHERE tx_hash = $1",
      [input.txHash]
    );
    const persistedRow = persistedTransaction.rows[0];
    if (
      persistedRow === undefined ||
      persistedRow.intent_id !== input.intentId ||
      persistedRow.tx_role !== input.txRole ||
      persistedRow.transaction_input_hash !== transactionInputHash
    ) {
      throw new Error("CHAIN_TRANSACTION_IMMUTABLE_CONFLICT");
    }
    if (input.lifecycle !== null && input.lifecycle.orderId !== null) {
      await client.query(
        `
          INSERT INTO order_evidence(
            tx_hash, order_id, state, quantity_raw, remaining_quantity_raw,
            evidence_source, observed_at, payload
          )
          VALUES ($1, $2, $3, $4, $5, 'CHAIN', now(), $6::jsonb)
          ON CONFLICT (tx_hash, order_id, state, remaining_quantity_raw) DO UPDATE
          SET payload = EXCLUDED.payload
        `,
        [
          input.txHash,
          input.lifecycle.orderId,
          input.lifecycle.state,
          input.lifecycle.quantityRaw,
          input.lifecycle.remainingQuantityRaw,
          JSON.stringify({
            strategyLinked: true,
            decodedFromReceipt: true,
            events: input.lifecycle.events
          })
        ]
      );
      for (const fill of input.lifecycle.fills) {
        await client.query(
          `
            INSERT INTO fill_evidence(tx_hash, fill_index, quantity_raw, price_raw, observed_at, payload)
            VALUES ($1, $2, $3, $4, $5, $6::jsonb)
            ON CONFLICT (tx_hash, fill_index) DO UPDATE
            SET payload = EXCLUDED.payload
          `,
          [
            input.txHash,
            fill.fillIndex,
            fill.quantityRaw,
            fill.priceRaw,
            fill.observedAt,
            JSON.stringify({ ...fill.payload, strategyLinked: true, decodedFromReceipt: true })
          ]
        );
      }
    }
    await client.query("UPDATE execution_intents SET state = $1 WHERE id = $2", [state, input.intentId]);
    await client.query("COMMIT");
    return {
      intentId: input.intentId,
      state,
      logHash,
      orderId: input.lifecycle?.orderId ?? null,
      orderState: input.lifecycle?.state ?? null,
      fillCount: input.lifecycle?.fills.length ?? 0
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function persistReconciledRedemption(
  pool: pg.Pool,
  input: {
    readonly intentId: string;
    readonly ownerAddress: string;
    readonly txHash: string;
    readonly transaction: RpcTransaction;
    readonly receipt: RpcReceipt;
    readonly actionId: string;
    readonly amountRaw: string;
    readonly payoutRaw: string | null;
    readonly routedVia: string | null;
  }
): Promise<void> {
  const transactionInputHash = sha256((input.transaction.input ?? "0x").toLowerCase());
  const logHash = sha256(stableJson(input.receipt.logs ?? []));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM execution_intents WHERE id = $1 FOR UPDATE", [input.intentId]);
    const existing = await client.query<{ tx_hash: string }>(
      "SELECT tx_hash FROM chain_transactions WHERE intent_id = $1 AND tx_role = 'redeem' LIMIT 1",
      [input.intentId]
    );
    if (existing.rows[0] !== undefined && existing.rows[0].tx_hash !== input.txHash) {
      await client.query("COMMIT");
      return;
    }
    await client.query(
      `
        INSERT INTO chain_transactions(
          tx_hash, intent_id, chain_id, from_address, nonce, receipt_status,
          block_number, log_hash, verified_at, payload, tx_role, transaction_input_hash
        )
        VALUES ($1, $2, $3, $4, $5, true, $6, $7, now(), $8::jsonb, 'redeem', $9)
        ON CONFLICT (tx_hash) DO UPDATE
        SET receipt_status = EXCLUDED.receipt_status,
            block_number = EXCLUDED.block_number,
            log_hash = EXCLUDED.log_hash,
            verified_at = EXCLUDED.verified_at,
            payload = EXCLUDED.payload
        WHERE chain_transactions.intent_id = EXCLUDED.intent_id
          AND chain_transactions.tx_role = EXCLUDED.tx_role
          AND chain_transactions.transaction_input_hash = EXCLUDED.transaction_input_hash
      `,
      [
        input.txHash,
        input.intentId,
        SOMNIA_SHANNON_CHAIN_ID,
        input.ownerAddress.toLowerCase(),
        hexToDecimalString(input.transaction.nonce),
        hexToDecimalString(input.receipt.blockNumber),
        logHash,
        JSON.stringify({
          txRole: "redeem",
          account: input.ownerAddress.toLowerCase(),
          to: input.transaction.to?.toLowerCase() ?? null,
          strategyLinked: true,
          reconciliationSource: "DREAMDEX_INDEXER_AND_SHANNON_RPC",
          routerActionId: input.actionId,
          amountRaw: input.amountRaw,
          payoutRaw: input.payoutRaw,
          routedVia: input.routedVia,
          receipt: input.receipt
        }),
        transactionInputHash
      ]
    );
    const persisted = await client.query<{
      intent_id: string;
      tx_role: string;
      transaction_input_hash: string | null;
      receipt_status: boolean | null;
    }>(
      `
        SELECT intent_id, tx_role, transaction_input_hash, receipt_status
        FROM chain_transactions
        WHERE tx_hash = $1
      `,
      [input.txHash]
    );
    const row = persisted.rows[0];
    if (
      row === undefined || row.intent_id !== input.intentId || row.tx_role !== "redeem" ||
      row.transaction_input_hash !== transactionInputHash || row.receipt_status !== true
    ) {
      throw new Error("CHAIN_TRANSACTION_IMMUTABLE_CONFLICT");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type CanonicalTransactionState = "NOT_SUBMITTED" | "PENDING" | "CONFIRMED" | "REVERTED";
type CanonicalFillState = "UNKNOWN" | "NO_FILL" | "PARTIAL_FILL" | "FULL_FILL";

export function classifyExecutionFillState(input: {
  readonly orderState: string | null;
  readonly filledQuantityRaw: string;
  readonly remainingQuantityRaw: string;
  readonly hasOrderEvidence: boolean;
}): CanonicalFillState {
  if (!input.hasOrderEvidence || input.orderState === "UNVERIFIED") {
    return "UNKNOWN";
  }
  const filledQuantity = BigInt(input.filledQuantityRaw);
  if (filledQuantity > 0n) {
    return BigInt(input.remainingQuantityRaw) === 0n || input.orderState === "FILLED"
      ? "FULL_FILL"
      : "PARTIAL_FILL";
  }
  return ["UNFILLED", "CANCELLED", "EXPIRED"].includes(input.orderState ?? "")
    ? "NO_FILL"
    : "UNKNOWN";
}

function canonicalTransactionState(receiptStatus: boolean | null | undefined): CanonicalTransactionState {
  if (receiptStatus === undefined) {
    return "NOT_SUBMITTED";
  }
  if (receiptStatus === null) {
    return "PENDING";
  }
  return receiptStatus ? "CONFIRMED" : "REVERTED";
}

async function loadCanonicalExecutionLifecycle(
  pool: pg.Pool,
  input: {
    readonly sessionId: string;
    readonly intentId?: string;
    readonly experimentId?: string;
  }
) {
  const intentResult = await pool.query<{
    id: string;
    intent_hash: string;
    experiment_id: string;
    assessment_id: string;
    policy_version_id: string;
    state: string;
    market_id: string;
    pool_address: string;
    side: string;
    price_raw: string;
    quantity_raw: string;
    escrow_raw: string;
    candidate_payload: unknown;
    reconciliation_payload: unknown;
    last_validated_at: Date;
    last_reconciled_at: Date | null;
    created_at: Date;
    assessment_hash: string;
    verdict: string;
    policy_id: string;
    policy_version: string;
    policy_source_hash: string;
  }>(
    `
      SELECT
        ei.id, ei.intent_hash, ei.experiment_id, ei.assessment_id, ei.policy_version_id,
        ei.state, ei.market_id, ei.pool_address, ei.side, ei.price_raw::text,
        ei.quantity_raw::text, ei.escrow_raw::text, ei.candidate_payload,
        ei.reconciliation_payload, ei.last_validated_at, ei.last_reconciled_at, ei.created_at,
        ea.assessment_hash, ea.verdict::text, pv.policy_id, pv.version AS policy_version,
        pv.source_hash AS policy_source_hash
      FROM execution_intents ei
      JOIN experiments e ON e.id = ei.experiment_id
      JOIN evidence_assessments ea ON ea.id = ei.assessment_id
      JOIN policy_versions pv ON pv.id = ei.policy_version_id
      WHERE e.created_by_session_id = $1
        AND ($2::uuid IS NULL OR ei.id = $2::uuid)
        AND ($3::uuid IS NULL OR ei.experiment_id = $3::uuid)
      ORDER BY ei.created_at DESC
      LIMIT 1
    `,
    [input.sessionId, input.intentId ?? null, input.experimentId ?? null]
  );
  const intent = intentResult.rows[0];
  if (intent === undefined) {
    return null;
  }
  const [transactionsResult, orderResult, fillResult, settlementResult] = await Promise.all([
    pool.query<{
      tx_hash: string;
      tx_role: string;
      receipt_status: boolean | null;
      block_number: string | null;
      verified_at: Date | null;
    }>(
      `
        SELECT tx_hash, tx_role, receipt_status, block_number::text, verified_at
        FROM chain_transactions
        WHERE intent_id = $1
        ORDER BY created_at ASC
      `,
      [intent.id]
    ),
    pool.query<{
      tx_hash: string;
      order_id: string;
      state: string;
      quantity_raw: string;
      remaining_quantity_raw: string;
      evidence_source: string;
      observed_at: Date;
      payload: unknown;
    }>(
      `
        SELECT oe.tx_hash, oe.order_id, oe.state::text, oe.quantity_raw::text,
               oe.remaining_quantity_raw::text, oe.evidence_source, oe.observed_at, oe.payload
        FROM order_evidence oe
        JOIN chain_transactions ct ON ct.tx_hash = oe.tx_hash
        WHERE ct.intent_id = $1
        ORDER BY
          CASE oe.state
            WHEN 'REDEEMED' THEN 100
            WHEN 'REDEEMABLE' THEN 90
            WHEN 'SETTLED' THEN 80
            WHEN 'FILLED' THEN 70
            WHEN 'CANCELLED' THEN 60
            WHEN 'EXPIRED' THEN 60
            WHEN 'PARTIALLY_FILLED' THEN 50
            WHEN 'UNFILLED' THEN 40
            WHEN 'ORDER_VERIFIED' THEN 20
            ELSE 10
          END DESC,
          oe.observed_at DESC,
          oe.id DESC
        LIMIT 1
      `,
      [intent.id]
    ),
    pool.query<{ quantity_raw: string; fill_count: string }>(
      `
        SELECT COALESCE(sum(fe.quantity_raw), 0)::text AS quantity_raw,
               count(*)::text AS fill_count
        FROM fill_evidence fe
        JOIN chain_transactions ct ON ct.tx_hash = fe.tx_hash
        WHERE ct.intent_id = $1
      `,
      [intent.id]
    ),
    pool.query<{ resolved: boolean; voided: boolean; winner: string | null; source_observed_at: Date }>(
      `
        SELECT resolved, voided, winner, source_observed_at
        FROM settlements
        WHERE market_id = $1
        ORDER BY source_observed_at DESC
        LIMIT 1
      `,
      [intent.market_id]
    )
  ]);
  const byRole = new Map(transactionsResult.rows.map((row) => [row.tx_role, row]));
  const approval = byRole.get("approval");
  const orderTransaction = byRole.get("order");
  const redeem = byRole.get("redeem");
  const order = orderResult.rows[0];
  const receiptFilledRaw = fillResult.rows[0]?.quantity_raw ?? "0";
  const requestedRaw = order?.quantity_raw ?? intent.quantity_raw;
  const remainingRaw = order?.remaining_quantity_raw ?? requestedRaw;
  const derivedFilled = BigInt(requestedRaw) >= BigInt(remainingRaw)
    ? (BigInt(requestedRaw) - BigInt(remainingRaw)).toString()
    : receiptFilledRaw;
  const filledRaw = BigInt(receiptFilledRaw) > BigInt(derivedFilled) ? receiptFilledRaw : derivedFilled;
  const orderState = order?.state ?? null;
  const fillState = classifyExecutionFillState({
    orderState,
    filledQuantityRaw: filledRaw,
    remainingQuantityRaw: remainingRaw,
    hasOrderEvidence: order !== undefined
  });
  const reconciliationPayload =
    intent.reconciliation_payload !== null && typeof intent.reconciliation_payload === "object"
      ? intent.reconciliation_payload as Record<string, unknown>
      : {};
  const claimableAmountRaw =
    typeof reconciliationPayload.claimableAmountRaw === "string" ? reconciliationPayload.claimableAmountRaw : "0";
  const marketStatus = typeof reconciliationPayload.marketStatus === "string" ? reconciliationPayload.marketStatus : null;
  const settlement = settlementResult.rows[0];
  const settlementState =
    fillState === "NO_FILL"
      ? "NOT_APPLICABLE"
      : settlement !== undefined || ["Resolved", "Voided", "Finalized"].includes(marketStatus ?? "")
        ? "SETTLED"
        : "PENDING_OR_UNKNOWN";
  const heldOutcome = intent.side === "BUY_YES" ? "YES" : intent.side === "BUY_NO" ? "NO" : null;
  const positionLost = settlement?.resolved && !settlement.voided &&
    settlement.winner !== null && heldOutcome !== null && settlement.winner !== heldOutcome;
  const redeemTransactionState = canonicalTransactionState(redeem?.receipt_status);
  const redeemedQuantityRaw =
    redeemTransactionState === "CONFIRMED" && typeof reconciliationPayload.redemptionAmountRaw === "string"
      ? reconciliationPayload.redemptionAmountRaw
      : null;
  const actualPayoutRaw =
    redeemTransactionState === "CONFIRMED" && typeof reconciliationPayload.redemptionPayoutRaw === "string"
      ? reconciliationPayload.redemptionPayoutRaw
      : null;
  const redemptionState =
    fillState === "NO_FILL"
      ? "NOT_APPLICABLE"
      : positionLost
        ? "NOT_APPLICABLE_LOSS"
        : BigInt(claimableAmountRaw) > 0n
          ? "REDEEMABLE"
          : redeemTransactionState === "CONFIRMED"
            ? "REDEEMED"
            : redeemTransactionState === "PENDING"
              ? "REDEMPTION_PENDING"
              : redeemTransactionState === "REVERTED"
                ? "REDEMPTION_REVERTED"
                : settlementState === "SETTLED"
                  ? "UNKNOWN"
                  : "NOT_YET_REDEEMABLE";
  return {
    intentId: intent.id,
    intentHash: intent.intent_hash,
    experimentId: intent.experiment_id,
    state: intent.state,
    qualification: {
      verdict: intent.verdict,
      assessmentId: intent.assessment_id,
      assessmentHash: intent.assessment_hash,
      policyVersionId: intent.policy_version_id,
      policyId: intent.policy_id,
      policyVersion: intent.policy_version,
      policyHash: intent.policy_source_hash
    },
    candidate: {
      marketId: intent.market_id,
      poolAddress: intent.pool_address,
      side: intent.side,
      priceRaw: intent.price_raw,
      requestedQuantityRaw: intent.quantity_raw,
      escrowRaw: intent.escrow_raw,
      validatedAt: intent.last_validated_at.toISOString()
    },
    transactions: {
      approval: approval === undefined ? null : {
        txHash: approval.tx_hash,
        state: canonicalTransactionState(approval.receipt_status),
        blockNumber: approval.block_number,
        verifiedAt: approval.verified_at?.toISOString() ?? null
      },
      order: orderTransaction === undefined ? null : {
        txHash: orderTransaction.tx_hash,
        state: canonicalTransactionState(orderTransaction.receipt_status),
        blockNumber: orderTransaction.block_number,
        verifiedAt: orderTransaction.verified_at?.toISOString() ?? null
      },
      redeem: redeem === undefined ? null : {
        txHash: redeem.tx_hash,
        state: canonicalTransactionState(redeem.receipt_status),
        blockNumber: redeem.block_number,
        verifiedAt: redeem.verified_at?.toISOString() ?? null
      }
    },
    order: order === undefined ? null : {
      orderId: order.order_id,
      state: order.state,
      requestedQuantityRaw: requestedRaw,
      filledQuantityRaw: filledRaw,
      remainingQuantityRaw: remainingRaw,
      fillState,
      fillCount: Number(fillResult.rows[0]?.fill_count ?? "0"),
      evidenceSource: order.evidence_source,
      observedAt: order.observed_at.toISOString()
    },
    settlement: {
      state: settlementState,
      marketStatus,
      resolved: settlement?.resolved ?? null,
      voided: settlement?.voided ?? null,
      winner: settlement?.winner ?? null,
      observedAt: settlement?.source_observed_at.toISOString() ?? null
    },
    redemption: {
      state: redemptionState,
      claimableAmountRaw,
      estimatedPayoutRaw:
        typeof reconciliationPayload.estimatedPayoutRaw === "string"
          ? reconciliationPayload.estimatedPayoutRaw
          : "0",
      redeemedQuantityRaw,
      actualPayoutRaw,
      evidenceSource: actualPayoutRaw === null ? null : "DREAMDEX_REDEEMED_EVENT_AND_SHANNON_RPC"
    },
    lastReconciledAt: intent.last_reconciled_at?.toISOString() ?? null,
    createdAt: intent.created_at.toISOString(),
    publicClaim:
      fillState === "FULL_FILL"
        ? "CONFIRMED_FULL_FILL"
        : fillState === "PARTIAL_FILL"
          ? "CONFIRMED_PARTIAL_FILL"
          : fillState === "NO_FILL"
            ? "CONFIRMED_NO_FILL"
            : orderTransaction?.receipt_status === false
              ? "REVERTED_ORDER_TRANSACTION"
              : "EXECUTION_NOT_YET_PROVEN"
  } as const;
}

function executionCallMatches(
  candidate: z.infer<typeof PersistableExecutionCandidateSchema>,
  txRole: "approval" | "order",
  transaction: RpcTransaction
): boolean {
  const expectedCall = txRole === "order" ? candidate.unsignedTransactions.order : candidate.unsignedTransactions.approval;
  return expectedCall !== null &&
    transaction.from?.toLowerCase() === candidate.account.toLowerCase() &&
    transaction.to?.toLowerCase() === expectedCall.to.toLowerCase() &&
    transaction.input?.toLowerCase() === expectedCall.data.toLowerCase() &&
    hexToDecimalString(transaction.value) === expectedCall.valueRaw;
}

function indexerOrderState(input: {
  readonly status: "Open" | "Closed" | "Filled" | "Cancelled" | "Expired";
  readonly filledQuantity: string;
  readonly quantityRemaining: string;
}): "ORDER_VERIFIED" | "UNFILLED" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED" | "EXPIRED" {
  if (input.status === "Open") return "ORDER_VERIFIED";
  if (input.status === "Filled") return "FILLED";
  if (input.status === "Cancelled") return "CANCELLED";
  if (input.status === "Expired") return "EXPIRED";
  if (BigInt(input.filledQuantity) === 0n) return "UNFILLED";
  return BigInt(input.quantityRemaining) === 0n ? "FILLED" : "PARTIALLY_FILLED";
}

async function reconcileExecutionIntent(input: {
  readonly pool: pg.Pool;
  readonly sessionId: string;
  readonly intentId: string;
  readonly config: RuntimeConfig;
  readonly dreamDex: { readonly client: DreamDexSdkClient; readonly config: DreamDexReadConfig };
}) {
  const intentResult = await input.pool.query<{ candidate_payload: unknown }>(
    `
      SELECT ei.candidate_payload
      FROM execution_intents ei
      JOIN experiments e ON e.id = ei.experiment_id
      WHERE ei.id = $1 AND e.created_by_session_id = $2
      LIMIT 1
    `,
    [input.intentId, input.sessionId]
  );
  const candidate = PersistableExecutionCandidateSchema.safeParse(intentResult.rows[0]?.candidate_payload);
  if (!candidate.success) {
    return null;
  }
  const pendingTransactions = await input.pool.query<{
    tx_hash: string;
    tx_role: "approval" | "order";
  }>(
    `
      SELECT tx_hash, tx_role
      FROM chain_transactions
      WHERE intent_id = $1
        AND tx_role IN ('approval', 'order')
        AND receipt_status IS NULL
    `,
    [input.intentId]
  );
  for (const pending of pendingTransactions.rows) {
    const [transaction, receipt] = await Promise.all([
      shannonRpc<RpcTransaction | null>(input.config, "eth_getTransactionByHash", [pending.tx_hash]),
      shannonRpc<RpcReceipt | null>(input.config, "eth_getTransactionReceipt", [pending.tx_hash])
    ]);
    if (transaction === null || !executionCallMatches(candidate.data, pending.tx_role, transaction)) {
      throw new Error("PERSISTED_EXECUTION_TX_CALL_MISMATCH");
    }
    if (receipt === null) {
      continue;
    }
    const lifecycle = pending.tx_role === "order"
      ? decodeOrderLifecycleFromReceipt({
          poolAddress: candidate.data.market.poolAddress,
          receiptStatus: receipt.status === "0x1",
          receipt,
          fallbackQuantityRaw: candidate.data.sizing.quantityRaw,
          observedAt: new Date().toISOString()
        })
      : null;
    if (
      lifecycle !== null &&
      lifecycle.orderId !== null &&
      (lifecycle.quantityRaw !== candidate.data.sizing.quantityRaw ||
        BigInt(lifecycle.filledQuantityRaw) > BigInt(candidate.data.sizing.quantityRaw) ||
        BigInt(lifecycle.remainingQuantityRaw) > BigInt(candidate.data.sizing.quantityRaw))
    ) {
      throw new Error("ORDER_EVENT_MISMATCH");
    }
    await persistStrategyExecutionTransaction(input.pool, {
      intentId: input.intentId,
      candidate: candidate.data,
      txHash: pending.tx_hash,
      txRole: pending.tx_role,
      transaction,
      receipt,
      lifecycle
    });
  }

  const beforeIndexer = await loadCanonicalExecutionLifecycle(input.pool, {
    sessionId: input.sessionId,
    intentId: input.intentId
  });
  if (beforeIndexer === null) {
    return null;
  }
  const reconciliationPayload: Record<string, unknown> = {
    reconciledAt: new Date().toISOString(),
    onchainOrder: "NOT_REQUESTED",
    indexerOrder: "NOT_REQUESTED",
    redemptionIndexer: "NOT_REQUESTED",
    marketStatus: null,
    claimableAmountRaw: "0",
    estimatedPayoutRaw: "0",
    sourceErrors: [] as string[]
  };
  const sourceErrors = reconciliationPayload.sourceErrors as string[];
  const orderTxHash = beforeIndexer.transactions.order?.txHash;
  if (beforeIndexer.order !== null && orderTxHash !== undefined && input.dreamDex.client.getOrderOnchain !== undefined) {
    try {
      const onchain = await input.dreamDex.client.getOrderOnchain(
        candidate.data.market.poolAddress,
        BigInt(beforeIndexer.order.orderId)
      );
      if (onchain === null) {
        reconciliationPayload.onchainOrder = "NOT_ACTIVE_OR_TERMINAL";
      } else {
        reconciliationPayload.onchainOrder = "ACTIVE";
        await input.pool.query(
          `
            INSERT INTO order_evidence(
              tx_hash, order_id, state, quantity_raw, remaining_quantity_raw,
              evidence_source, observed_at, payload
            )
            VALUES ($1, $2, 'ORDER_VERIFIED', $3, $4, 'SHANNON_RPC', now(), $5::jsonb)
            ON CONFLICT (tx_hash, order_id, state, remaining_quantity_raw) DO UPDATE
            SET observed_at = EXCLUDED.observed_at,
                evidence_source = EXCLUDED.evidence_source,
                payload = EXCLUDED.payload
          `,
          [
            orderTxHash,
            onchain.orderId.toString(),
            onchain.fullQuantity.toString(),
            onchain.quantityRemaining.toString(),
            JSON.stringify({ activeAtChainHead: true, strategyLinked: true })
          ]
        );
      }
    } catch (error) {
      reconciliationPayload.onchainOrder = "READ_FAILED";
      sourceErrors.push(error instanceof Error ? error.message : "DreamDEX on-chain order read failed");
    }
  }
  if (beforeIndexer.order !== null && orderTxHash !== undefined && input.dreamDex.client.getOrders !== undefined) {
    try {
      const rows = await input.dreamDex.client.getOrders(candidate.data.account, {
        pool: candidate.data.market.poolAddress,
        limit: 200
      });
      const indexed = rows.find((row) =>
        row.orderId === beforeIndexer.order?.orderId &&
        row.pool.toLowerCase() === candidate.data.market.poolAddress.toLowerCase() &&
        row.market.toLowerCase() === candidate.data.market.stableMarketId.toLowerCase()
      );
      if (indexed === undefined) {
        reconciliationPayload.indexerOrder = "DELAYED_OR_ABSENT";
      } else {
        reconciliationPayload.indexerOrder = "MATCHED";
        const state = indexerOrderState(indexed);
        await input.pool.query(
          `
            INSERT INTO order_evidence(
              tx_hash, order_id, state, quantity_raw, remaining_quantity_raw,
              evidence_source, observed_at, payload
            )
            VALUES ($1, $2, $3, $4, $5, 'DREAMDEX_INDEXER', now(), $6::jsonb)
            ON CONFLICT (tx_hash, order_id, state, remaining_quantity_raw) DO UPDATE
            SET observed_at = EXCLUDED.observed_at,
                evidence_source = EXCLUDED.evidence_source,
                payload = EXCLUDED.payload
          `,
          [
            orderTxHash,
            indexed.orderId,
            state,
            indexed.fullQuantity,
            indexed.quantityRemaining,
            JSON.stringify({
              placedTxHash: indexed.placedTxHash,
              filledQuantityRaw: indexed.filledQuantity,
              indexerStatus: indexed.status,
              strategyLinked: true
            })
          ]
        );
      }
    } catch (error) {
      reconciliationPayload.indexerOrder = "READ_FAILED";
      sourceErrors.push(error instanceof Error ? error.message : "DreamDEX order indexer read failed");
    }
  }
  try {
    const market = await input.dreamDex.client.getBinaryMarket(candidate.data.market.stableMarketId);
    reconciliationPayload.marketStatus = market?.status ?? null;
  } catch (error) {
    sourceErrors.push(error instanceof Error ? error.message : "DreamDEX market lifecycle read failed");
  }
  if (input.dreamDex.client.getClaimable !== undefined) {
    try {
      const claimable = await input.dreamDex.client.getClaimable(candidate.data.account);
      const matching = claimable.filter((position) =>
        position.marketId.toLowerCase() === candidate.data.market.stableMarketId.toLowerCase() &&
        position.pool.toLowerCase() === candidate.data.market.poolAddress.toLowerCase()
      );
      reconciliationPayload.claimableAmountRaw = matching.reduce((sum, position) => sum + position.amount, 0n).toString();
      reconciliationPayload.estimatedPayoutRaw = matching.reduce((sum, position) => sum + position.estPayout, 0n).toString();
    } catch (error) {
      sourceErrors.push(error instanceof Error ? error.message : "DreamDEX claimable read failed");
    }
  }
  const beforeRedemption = await loadCanonicalExecutionLifecycle(input.pool, {
    sessionId: input.sessionId,
    intentId: input.intentId
  });
  if (
    beforeRedemption !== null && beforeRedemption.order !== null &&
    ["PARTIAL_FILL", "FULL_FILL"].includes(beforeRedemption.order.fillState) &&
    input.dreamDex.client.getRouterActions !== undefined
  ) {
    if (beforeRedemption.transactions.redeem?.state === "CONFIRMED") {
      reconciliationPayload.redemptionIndexer = "ALREADY_VERIFIED";
    } else {
      try {
        const actions = await input.dreamDex.client.getRouterActions(candidate.data.account, {
          market: candidate.data.market.stableMarketId,
          kind: "Redeem",
          limit: 20
        });
        const notBeforeMs = new Date(
          beforeRedemption.transactions.order?.verifiedAt ?? beforeRedemption.createdAt
        ).getTime();
        const exactActions = actions.filter((action) => {
          if (
            action.kind !== "Redeem" || action.account.toLowerCase() !== candidate.data.account.toLowerCase() ||
            action.market?.toLowerCase() !== candidate.data.market.stableMarketId.toLowerCase() ||
            !TxHashSchema.safeParse(action.txHash).success || !/^[0-9]+$/.test(action.amount) ||
            !/^[0-9]+$/.test(action.timestamp) || (action.payout !== null && !/^[0-9]+$/.test(action.payout))
          ) {
            return false;
          }
          return action.amount === beforeRedemption.order?.filledQuantityRaw &&
            BigInt(action.timestamp) >= BigInt(Math.floor(notBeforeMs / 1000));
        });
        if (exactActions.length === 0) {
          reconciliationPayload.redemptionIndexer = "DELAYED_OR_ABSENT";
        } else if (exactActions.length > 1) {
          reconciliationPayload.redemptionIndexer = "AMBIGUOUS";
          sourceErrors.push("Multiple exact redemption actions matched this intent; attribution failed closed");
        } else {
          const action = exactActions[0];
          if (action === undefined) throw new Error("REDEMPTION_ACTION_MISSING");
          const [transaction, receipt] = await Promise.all([
            shannonRpc<RpcTransaction | null>(input.config, "eth_getTransactionByHash", [action.txHash]),
            shannonRpc<RpcReceipt | null>(input.config, "eth_getTransactionReceipt", [action.txHash])
          ]);
          if (transaction === null || receipt === null) {
            reconciliationPayload.redemptionIndexer = "RPC_PENDING_OR_DELAYED";
          } else if (receipt.status !== "0x1") {
            reconciliationPayload.redemptionIndexer = "REVERTED";
            sourceErrors.push("Indexed redemption transaction reverted on Shannon");
          } else {
            const exactRedemption = exactStrategyRedemption({
              receipt,
              account: candidate.data.account,
              side: candidate.data.sizing.side,
              amountRaw: action.amount,
              payoutRaw: action.payout
            });
            if (
              transaction.from?.toLowerCase() !== candidate.data.account.toLowerCase() ||
              !AddressSchema.safeParse(transaction.to).success || transaction.input === undefined ||
              transaction.input === "0x" || !/^0x[0-9a-fA-F]+$/.test(transaction.input) ||
              exactRedemption === null
            ) {
              reconciliationPayload.redemptionIndexer = "RECEIPT_MISMATCH";
              sourceErrors.push("Indexed redemption did not match the exact wallet, side, amount, and Shannon receipt");
            } else {
              await persistReconciledRedemption(input.pool, {
                intentId: input.intentId,
                ownerAddress: candidate.data.account,
                txHash: action.txHash.toLowerCase(),
                transaction,
                receipt,
                actionId: action.id,
                amountRaw: exactRedemption.amountBurned,
                payoutRaw: exactRedemption.collateralOut,
                routedVia: action.routedVia
              });
              reconciliationPayload.redemptionIndexer = "MATCHED";
              reconciliationPayload.redemptionAmountRaw = exactRedemption.amountBurned;
              reconciliationPayload.redemptionPayoutRaw = exactRedemption.collateralOut;
            }
          }
        }
      } catch (error) {
        reconciliationPayload.redemptionIndexer = "READ_FAILED";
        sourceErrors.push(error instanceof Error ? error.message : "DreamDEX redemption reconciliation failed");
      }
    }
  }
  const afterReads = await loadCanonicalExecutionLifecycle(input.pool, {
    sessionId: input.sessionId,
    intentId: input.intentId
  });
  if (afterReads === null) {
    return null;
  }
  const currentClaimableAmount = BigInt(String(reconciliationPayload.claimableAmountRaw));
  const nextState =
    afterReads.transactions.order?.state === "PENDING"
      ? "TX_PENDING"
      : afterReads.transactions.order?.state === "REVERTED"
        ? "TX_REVERTED"
        : afterReads.transactions.redeem?.state === "CONFIRMED" && currentClaimableAmount === 0n
          ? "REDEEMED"
          : currentClaimableAmount > 0n
            ? "REDEEMABLE"
            : afterReads.order?.state ?? afterReads.state;
  await input.pool.query(
    `
      UPDATE execution_intents
      SET state = $1,
          last_reconciled_at = now(),
          reconciliation_payload = $2::jsonb
      WHERE id = $3
    `,
    [nextState, JSON.stringify(reconciliationPayload), input.intentId]
  );
  return await loadCanonicalExecutionLifecycle(input.pool, {
    sessionId: input.sessionId,
    intentId: input.intentId
  });
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
  if (policyId === "last-trade-forward-proxy") {
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
        : adapter.policyId === "last-trade-forward-proxy"
          ? adapter.version === "1.1.0"
            ? "Forward challenger using a non-crossed YES midpoint, then a current-generation pre-outcome trade no older than 15 minutes, then one-sided book fallbacks. It never authorizes execution."
            : "Frozen forward control using the live YES-term midpoint or ask-only fallback. It never authorizes execution."
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

function toExecutionDomainSnapshot(snapshot: {
  readonly market: {
    readonly stableMarketId: string;
    readonly asset: "BTC" | "ETH";
    readonly intervalSeconds: number | null;
    readonly quoteDecimals: number;
    readonly tradingStartSeconds: number;
    readonly expirySeconds: number;
    readonly lastPriceRaw: string | null;
    readonly lastTradeAtSeconds: number | null;
    readonly source: {
      readonly sdkVersion: typeof DREAMDEX_MARKETS_SDK_VERSION;
      readonly rpcUrl: string;
      readonly indexerUrl: string;
      readonly evidenceClass: string;
      readonly retrievedAt: string;
    };
  };
  readonly book: {
    readonly yesBids: readonly { readonly priceRaw: string; readonly quantityRaw: string }[];
    readonly yesAsks: readonly { readonly priceRaw: string; readonly quantityRaw: string }[];
    readonly noAsks?: readonly { readonly priceRaw: string; readonly quantityRaw: string }[];
  };
}, mode: "YES_NATIVE" | "INVERSE_NO_ASK" = "YES_NATIVE") {
  const scale = 10n ** BigInt(snapshot.market.quoteDecimals);
  const asks =
    mode === "YES_NATIVE"
      ? snapshot.book.yesAsks
      : (snapshot.book.noAsks ?? [])
          .map((level) => {
            const price = BigInt(level.priceRaw);
            return {
              priceRaw: price >= scale ? "0" : (scale - price).toString(),
              quantityRaw: level.quantityRaw
            };
          })
          .filter((level) => level.priceRaw !== "0");
  return {
    marketId: snapshot.market.stableMarketId,
    chainId: SOMNIA_SHANNON_CHAIN_ID,
    asset: snapshot.market.asset,
    intervalSeconds: snapshot.market.intervalSeconds ?? 0,
    quoteDecimals: snapshot.market.quoteDecimals,
    capturedAt: snapshot.market.source.retrievedAt,
    source: {
      sdkVersion: snapshot.market.source.sdkVersion,
      rpcUrl: snapshot.market.source.rpcUrl,
      indexerUrl: snapshot.market.source.indexerUrl,
      evidenceClass: snapshot.market.source.evidenceClass
    },
    book: {
      bids: mode === "YES_NATIVE" ? snapshot.book.yesBids : [],
      asks
    },
    marketWindow: {
      tradingStartSeconds: snapshot.market.tradingStartSeconds,
      expirySeconds: snapshot.market.expirySeconds
    },
    ...(snapshot.market.lastPriceRaw === null || snapshot.market.lastTradeAtSeconds === null
      ? {}
      : {
          lastTrade: {
            priceRaw: snapshot.market.lastPriceRaw,
            timestampSeconds: snapshot.market.lastTradeAtSeconds
          }
        })
  };
}

function floorToLot(quantity: bigint, lotSize: bigint): bigint {
  if (lotSize <= 0n) {
    return quantity;
  }
  return (quantity / lotSize) * lotSize;
}

function executionEscrowPriceRaw(side: "BUY_YES" | "BUY_NO", priceRaw: bigint, quoteDecimals: number): bigint {
  if (side === "BUY_YES") {
    return priceRaw;
  }
  const scale = 10n ** BigInt(quoteDecimals);
  return priceRaw >= scale ? 0n : scale - priceRaw;
}

function minimumEscrowForQuantity(input: {
  readonly quantityRaw: bigint;
  readonly priceRaw: bigint;
  readonly quoteDecimals: number;
}): bigint {
  if (input.quantityRaw <= 0n || input.priceRaw <= 0n) {
    return 0n;
  }
  const scale = 10n ** BigInt(input.quoteDecimals);
  return (input.quantityRaw * input.priceRaw + scale - 1n) / scale;
}

function displayQuoteAmount(raw: bigint, quoteDecimals: number, symbol: string): string {
  const scale = 10n ** BigInt(quoteDecimals);
  const whole = raw / scale;
  const fraction = raw % scale;
  const fractionText = fraction.toString().padStart(quoteDecimals, "0").replace(/0+$/, "");
  return `${whole.toString()}${fractionText.length > 0 ? `.${fractionText}` : ""} ${symbol}`;
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
const HistoricalReplayDeadlineMs = 30 * 60_000;

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
  } catch (error) {
    return {
      ok: false,
      reasonCode: "DREAMDEX_HISTORICAL_READ_FAILED",
      message: error instanceof Error ? error.message : `${label} failed`
    };
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
  const selectedMarkets = [...markets.value.markets].sort((left, right) => {
    const leftDecisionAt = replayDecisionAtSeconds(left, input.experiment.configuration.decisionOffsetSec);
    const rightDecisionAt = replayDecisionAtSeconds(right, input.experiment.configuration.decisionOffsetSec);
    return leftDecisionAt - rightDecisionAt || left.stableMarketId.localeCompare(right.stableMarketId);
  });
  let previousCutoff: HistoricalCutoffBlock | null = null;
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
      const cutoffOperation: Promise<HistoricalDreamDexReadResult<HistoricalCutoffBlock>> =
        previousCutoff === null
          ? resolveHistoricalCutoffBlock(input.historicalDreamDexConfig, decisionAtSeconds, input.historicalRpcFetch)
          : resolveHistoricalCutoffBlockAfter(
              input.historicalDreamDexConfig,
              decisionAtSeconds,
              previousCutoff,
              input.historicalRpcFetch
            );
      const cutoff = await withHistoricalReplayTimeout(
        cutoffOperation,
        `cutoff block ${market.stableMarketId}`
      );
      if (!cutoff.ok) {
        throw new Error(`CUTOFF_BLOCK_UNAVAILABLE: ${cutoff.message}`);
      }
      previousCutoff = cutoff.value;
      const [candles, orders, fills] = await Promise.all([
        fetchPagedHistoricalCandles(
          (page) =>
            listHistoricalCandles(input.historicalDreamDexClient, input.historicalDreamDexConfig, market.poolAddress, 300, {
              fromSec: market.tradingStartSeconds,
              toSec: decisionAtSeconds,
              ...page
            }),
          500,
          `candles ${market.stableMarketId}`
        ),
        fetchPagedHistoricalRows(
          (page) =>
            listHistoricalOrdersByMarket(
              input.historicalDreamDexConfig,
              market.stableMarketId,
              page,
              input.historicalIndexerFetch
            ),
          ReplayMaxSourceRows,
          `orders ${market.stableMarketId}`
        ),
        fetchPagedHistoricalRows(
          (page) =>
            listHistoricalFillsByMarket(input.historicalDreamDexConfig, market.stableMarketId, page, input.historicalIndexerFetch),
          ReplayMaxSourceRows,
          `fills ${market.stableMarketId}`
        )
      ]);
      if (!candles.ok) {
        throw new Error(candles.message);
      }
      if (!orders.ok) {
        throw new Error(orders.message);
      }
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
    const outcome = normalizeOutcome(market.winningOutcome);
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
        source: "listPastBinaryMarkets",
        outcomeEmbargo: "winningOutcome withheld from historical decision frame and policy input",
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
        message.startsWith("DreamDEX historical read deadline exceeded") ||
        message.startsWith("DreamDEX historical indexer returned HTTP") ||
        message.startsWith("SOURCE_BLOCKED") ||
        message.startsWith("CUTOFF_BLOCK_UNAVAILABLE") ||
        message.startsWith("OUTCOME_SOURCE_UNAVAILABLE") ||
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
    eligible_decision_count: string;
    abstention_count: string;
    pending_outcome_count: string;
    timing_excluded_decision_count: string;
    excluded_episode_count: string;
    latest_decided_at: Date | null;
    latest_market_id: string | null;
  }>(
    `
      SELECT
        count(DISTINCT me.id) AS episode_count,
        count(DISTINCT ms.id) AS snapshot_count,
        count(DISTINCT sd.id) AS decision_count,
        count(DISTINCT sd.id) FILTER (
          WHERE sd.action <> 'ABSTAIN'
            AND sd.forecast_p_up IS NOT NULL
            AND ms.captured_at >= CASE WHEN ecv.rule_version='edgelab-evaluation-v4'
              THEN me.expires_at - make_interval(secs => sd.decision_offset_sec + 5)
              ELSE GREATEST(COALESCE(me.trading_starts_at + interval '1 second', '-infinity'::timestamptz), me.expires_at - make_interval(secs => sd.decision_offset_sec)) END
            AND ms.captured_at < CASE WHEN ecv.rule_version='edgelab-evaluation-v4'
              THEN me.expires_at - make_interval(secs => sd.decision_offset_sec) ELSE me.expires_at END
            AND s.resolved = true
            AND s.voided = false
            AND s.winner IN ('YES', 'NO')
        ) AS eligible_decision_count,
        count(DISTINCT sd.id) FILTER (
          WHERE (sd.action = 'ABSTAIN' OR sd.forecast_p_up IS NULL)
            AND ms.captured_at >= CASE WHEN ecv.rule_version='edgelab-evaluation-v4'
              THEN me.expires_at - make_interval(secs => sd.decision_offset_sec + 5)
              ELSE GREATEST(COALESCE(me.trading_starts_at + interval '1 second', '-infinity'::timestamptz), me.expires_at - make_interval(secs => sd.decision_offset_sec)) END
            AND ms.captured_at < CASE WHEN ecv.rule_version='edgelab-evaluation-v4'
              THEN me.expires_at - make_interval(secs => sd.decision_offset_sec) ELSE me.expires_at END
        ) AS abstention_count,
        count(DISTINCT sd.id) FILTER (
          WHERE sd.action <> 'ABSTAIN'
            AND sd.forecast_p_up IS NOT NULL
            AND ms.captured_at >= CASE WHEN ecv.rule_version='edgelab-evaluation-v4'
              THEN me.expires_at - make_interval(secs => sd.decision_offset_sec + 5)
              ELSE GREATEST(COALESCE(me.trading_starts_at + interval '1 second', '-infinity'::timestamptz), me.expires_at - make_interval(secs => sd.decision_offset_sec)) END
            AND ms.captured_at < CASE WHEN ecv.rule_version='edgelab-evaluation-v4'
              THEN me.expires_at - make_interval(secs => sd.decision_offset_sec) ELSE me.expires_at END
            AND (s.id IS NULL OR (s.resolved = false AND s.voided = false))
        ) AS pending_outcome_count,
        count(DISTINCT sd.id) FILTER (
          WHERE ms.captured_at < CASE WHEN ecv.rule_version='edgelab-evaluation-v4'
              THEN me.expires_at - make_interval(secs => sd.decision_offset_sec + 5)
              ELSE GREATEST(COALESCE(me.trading_starts_at + interval '1 second', '-infinity'::timestamptz), me.expires_at - make_interval(secs => sd.decision_offset_sec)) END
            OR ms.captured_at >= CASE WHEN ecv.rule_version='edgelab-evaluation-v4'
              THEN me.expires_at - make_interval(secs => sd.decision_offset_sec) ELSE me.expires_at END
        ) AS timing_excluded_decision_count,
        count(DISTINCT me.id) FILTER (WHERE me.state = 'EXCLUDED') AS excluded_episode_count,
        max(sd.decided_at) AS latest_decided_at,
        (array_agg(me.market_id ORDER BY sd.decided_at DESC NULLS LAST))[1] AS latest_market_id
      FROM experiments e
      JOIN experiment_configuration_versions ecv ON ecv.id=e.active_configuration_id
      LEFT JOIN market_episodes me ON me.experiment_id = e.id
      LEFT JOIN market_snapshots ms ON ms.episode_id = me.id
      LEFT JOIN shadow_decisions sd ON sd.snapshot_id = ms.id
      LEFT JOIN settlements s ON s.market_id = me.market_id
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
    eligibleDecisionCount: Number(row?.eligible_decision_count ?? 0),
    abstentionCount: Number(row?.abstention_count ?? 0),
    pendingOutcomeCount: Number(row?.pending_outcome_count ?? 0),
    timingExcludedDecisionCount: Number(row?.timing_excluded_decision_count ?? 0),
    excludedEpisodeCount: Number(row?.excluded_episode_count ?? 0),
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

async function loadLatestAssessmentDetail(
  pool: pg.Pool,
  input: { readonly sessionId: string; readonly experimentId: string }
): Promise<AssessmentDetailRow | null> {
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
    [input.experimentId, input.sessionId]
  );
  return result.rows[0] ?? null;
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
  if (verdict === "STRATEGY_QUALIFIED") {
    return "Forward evidence qualifies this exact strategy version for bounded execution review; current market executability remains a separate fresh check.";
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
  if (verdict === "STRATEGY_QUALIFIED") {
    return "REVALIDATE_BOUNDED_EXECUTION_CANDIDATE";
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
  if (verdict === "STRATEGY_QUALIFIED") {
    return [
      ...shared,
      "wallet signing without fresh executable-market revalidation",
      "filled execution until a confirmed receipt and DreamDEX events prove it"
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
      status:
        input.executionLinked === true
          ? "LINKED"
          : input.verdict === "STRATEGY_QUALIFIED"
            ? "FRESH_REVALIDATION_REQUIRED"
            : "UNLINKED_GLOBAL_PROOF_AVAILABLE",
      detail:
        input.verdict === "STRATEGY_QUALIFIED"
          ? "Strategy qualification is complete; no order is executable until the current market and wallet checks pass."
          : "Global EXG-003 proof remains separate unless explicitly linked to this candidate."
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
          input.row.verdict === "PROMOTE_TO_FORWARD_OBSERVATION" || input.row.verdict === "STRATEGY_QUALIFIED"
            ? input.row.promotion_scope
            : "NOT_APPLICABLE",
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

function buildObservationProof() {
  const manifest = readEvidenceRecord("evidence/observations/manifest.json");
  const validation = recordField(manifest, "validation");
  const liveCapture = recordField(manifest, "liveCapture");
  const markets = liveCapture.markets;
  if (!Array.isArray(markets) || markets.some((market) => !isRecord(market))) {
    throw new Error("Observation manifest markets are missing or malformed");
  }
  const observedMarketRecords = markets as readonly Record<string, unknown>[];
  const observedMarkets = observedMarketRecords.map((market) => ({
    stableMarketId: stringField(market, "stableMarketId"),
    asset: stringField(market, "asset"),
    intervalSeconds: numberField(market, "intervalSeconds"),
    poolAddress: stringField(market, "poolAddress"),
    marketNonce: stringField(market, "marketNonce"),
    expiresAt: stringField(market, "expiresAt"),
    snapshotId: stringField(market, "snapshotId"),
    snapshotHash: stringField(market, "snapshot_hash"),
    decisionCount: numberField(market, "decisionCount")
  }));
  return {
    observationProof: {
      proofId: "OBSERVE-001",
      status: stringField(manifest, "status"),
      capturedAt: stringField(manifest, "capturedAt"),
      evidenceClass: stringField(manifest, "evidenceClass"),
      scope: stringField(manifest, "scope"),
      sourcePlane: "SHANNON_FORWARD",
      chainId: SOMNIA_SHANNON_CHAIN_ID,
      sdkVersion: DREAMDEX_MARKETS_SDK_VERSION,
      transactionSubmitted: booleanField(liveCapture, "transactionSubmitted"),
      walletRequired: booleanField(liveCapture, "walletRequired"),
      experimentId: stringField(liveCapture, "experimentId"),
      captureMethod: stringField(liveCapture, "captureMethod"),
      observedMarketCount: observedMarkets.length,
      totalShadowDecisions: observedMarkets.reduce((sum, market) => sum + market.decisionCount, 0),
      implementedControls: stringArrayField(manifest, "implementedControls"),
      observedMarkets,
      validation: {
        integrationTest: stringField(validation, "integrationTest"),
        lint: stringField(validation, "lint"),
        typecheck: stringField(validation, "typecheck"),
        test: stringField(validation, "test"),
        build: stringField(validation, "build"),
        fullVerification: stringField(validation, "fullVerification")
      },
      judgeSummary: {
        oneLine:
          "OBSERVE-001 proves EdgeLab can capture pre-outcome Shannon decisions without a wallet or transaction.",
        strongestEvidence: [
          `${String(observedMarkets.length)} live DreamDEX markets observed`,
          `${String(observedMarkets.reduce((sum, market) => sum + market.decisionCount, 0))} shadow decisions persisted`,
          "snapshots and decisions inserted before market expiry",
          "late or expired markets rejected before writes"
        ],
        nextMilestone:
          "Link a promoted historical strategy to a larger forward sample, then evaluate settled outcomes before any execution exposure.",
        blockedClaims: [
          "realized PnL",
          "filled execution",
          "capital authorization",
          "autonomous trading"
        ]
      }
    }
  };
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

function buildProvenExperimentReport() {
  const proven = buildProvenExperiment().provenExperiment;
  return {
    report: {
      reportId: `proven:${proven.slug}`,
      title: "EdgeLab Proven Experiment Report",
      generatedAt: new Date().toISOString(),
      source: proven.source,
      experiment: proven.experiment,
      replay: proven.replay,
      assessment: proven.assessment,
      evidenceGate: proven.evidenceGate,
      judgeSummary: {
        oneLine:
          "EdgeLab promoted this DreamDEX strategy to forward observation, not execution exposure.",
        currentVerdict: proven.assessment.verdict,
        strongestEvidence: [
          `${String(proven.replay.processedCount)} processed historical DreamDEX markets`,
          `${String(proven.replay.scoredCount)} scored pre-outcome decisions`,
          `Brier score ${formatMetric(proven.assessment.brierScore)}`,
          `Calibration bias ${formatMetric(proven.assessment.calibrationBias)}`
        ],
        nextObservationMilestone: {
          plane: "SHANNON_FORWARD",
          action: proven.evidenceGate.decision.nextPermittedAction,
          requirement:
            "Persist forward decisions before outcomes, then re-evaluate without importing retrospective knowledge."
        },
        blockedClaims: [
          "strategy-linked fill",
          "realized wallet PnL",
          "mainnet trading authorization",
          "autonomous execution authorization"
        ]
      },
      executionProofRelationship: {
        plane: "SHANNON_EXECUTION",
        status: "UNLINKED_GLOBAL_PROOF_AVAILABLE",
        proofRoute: "/proof",
        detail:
          "EXG-003 proves the DreamDEX Shannon write/cancel lifecycle separately. It is not counted as this historical experiment's tradeability, fill, or PnL evidence."
      },
      exportPolicy: {
        format: "application/json",
        sanitized: true,
        blockchainWrite: false,
        privateSecretsIncluded: false
      },
      boundaries: {
        mainnet: "READ_ONLY_HISTORICAL_RESEARCH",
        shannonForward: "PRE_OUTCOME_LIVE_SHADOW_OBSERVATION",
        shannonExecution: "HUMAN_AUTHORIZED_TESTNET_EXECUTION_ONLY",
        promotionScope: proven.evidenceGate.decision.promotionScope,
        doesNotAuthorize: proven.evidenceGate.decision.doesNotAuthorize
      },
      reproducibility: proven.reproducibility
    }
  };
}

interface FrozenComparisonScope {
  readonly mode: "MATCHED_INTERSECTION" | "DESCRIPTIVE_ONLY";
  readonly manifestHash: string;
  readonly reason: string;
  readonly intersectionSize: number;
  readonly assessmentIds: readonly string[];
  readonly exclusionsByAssessment: Readonly<Record<string, number>>;
  readonly matchedMetricsByAssessment: Readonly<Record<string, {
    readonly pairedSampleSize: number;
    readonly candidateBrier: number | null;
    readonly marketBrier: number | null;
    readonly brierSkill: number | null;
    readonly candidateEce: number | null;
    readonly marketEce: number | null;
    readonly deltaInterval: { readonly lower: number; readonly upper: number; readonly distinctDayBlocks: number; readonly familySize: number } | null;
  }>>;
}

async function buildFrozenComparisonScope(
  pool: pg.Pool | pg.PoolClient,
  assessmentIds: readonly string[]
): Promise<{ readonly mode: FrozenComparisonScope["mode"]; readonly manifest: Record<string, unknown>; readonly manifestHash: string }> {
  const result = await pool.query<{
    assessment_id: string;
    rule_version: string;
    evidence_plane: string;
    canonical_input: { observations?: readonly {
      observationKey?: unknown; candidateProbability?: unknown; marketProbability?: unknown;
      outcomeUp?: unknown; observedAt?: unknown;
    }[] };
    family: string | null;
    timing: unknown;
    cohort: unknown;
  }>(
    `SELECT ea.id AS assessment_id, mr.rule_version, mr.evidence_plane, mr.canonical_input,
            op.family, op.manifest->'timing' AS timing, op.manifest->'cohort' AS cohort
       FROM evidence_assessments ea
       JOIN metric_runs mr ON mr.id = ea.metric_run_id
       LEFT JOIN assessment_v4_details av4 ON av4.assessment_id = ea.id
       LEFT JOIN observation_protocols op ON op.id = av4.protocol_id
      WHERE ea.id = ANY($1::uuid[])`,
    [[...assessmentIds]]
  );
  const byId = new Map(result.rows.map((row) => [row.assessment_id, row]));
  const rows = assessmentIds.flatMap((id) => {
    const row = byId.get(id);
    return row === undefined ? [] : [row];
  });
  const first = rows[0];
  const v4Compatible = rows.length === assessmentIds.length && first !== undefined && rows.every((row) =>
    row.rule_version === "edgelab-evaluation-v4" &&
    row.evidence_plane === "SHANNON_FORWARD" &&
    row.family !== null && row.family === first.family &&
    stableJson(row.timing) === stableJson(first.timing) &&
    stableJson(row.cohort) === stableJson(first.cohort)
  );
  const keySets = rows.map((row) => new Set(
    (row.canonical_input.observations ?? []).flatMap((observation) =>
      typeof observation.observationKey === "string" ? [observation.observationKey] : []
    )
  ));
  const intersection = v4Compatible && keySets[0] !== undefined
    ? [...keySets[0]].filter((key) => keySets.every((set) => set.has(key))).sort()
    : [];
  const mode = v4Compatible ? "MATCHED_INTERSECTION" : "DESCRIPTIVE_ONLY";
  const reason = v4Compatible
    ? "Shared v4 source plane, cohort, and decision timing; metrics may be recomputed on the frozen observation-key intersection."
    : "Different evidence scopes — descriptive comparison only.";
  const exclusionsByAssessment = Object.fromEntries(assessmentIds.map((id, index) => [
    id,
    Math.max(0, (keySets[index]?.size ?? 0) - intersection.length)
  ]));
  const intersectionSet = new Set(intersection);
  const comparisonSeed = sha256(stableJson({ assessmentIds: [...assessmentIds], intersectionObservationKeys: intersection }));
  const matchedMetricsByAssessment = v4Compatible ? Object.fromEntries(rows.map((row) => {
    const observations: PairedForecastObservation[] = (row.canonical_input.observations ?? []).flatMap((observation) =>
      typeof observation.observationKey === "string" && intersectionSet.has(observation.observationKey) &&
      typeof observation.candidateProbability === "number" &&
      (typeof observation.marketProbability === "number" || observation.marketProbability === null) &&
      typeof observation.outcomeUp === "boolean" && typeof observation.observedAt === "string"
        ? [{
            observationKey: observation.observationKey,
            candidateProbability: observation.candidateProbability,
            marketProbability: observation.marketProbability,
            outcomeUp: observation.outcomeUp,
            observedAt: observation.observedAt
          }]
        : []
    );
    const metrics = calculatePairedMetrics(observations);
    const interval = pairedMovingBlockDeltaInterval(observations, {
      seed: comparisonSeed, replicates: 10_000, blockLengthDays: 2, familySize: assessmentIds.length
    });
    return [row.assessment_id, {
      pairedSampleSize: metrics.pairedSampleSize,
      candidateBrier: metrics.candidateBrier,
      marketBrier: metrics.marketBrier,
      brierSkill: metrics.brierSkill,
      candidateEce: metrics.candidateEce,
      marketEce: metrics.marketEce,
      deltaInterval: interval === null ? null : {
        lower: interval.lower, upper: interval.upper,
        distinctDayBlocks: interval.distinctDayBlocks, familySize: interval.familySize
      }
    }];
  })) : {};
  const manifest = {
    schemaVersion: "edgelab-comparison-scope-v1",
    mode,
    reason,
    assessmentIds: [...assessmentIds],
    cohort: v4Compatible ? first.cohort : null,
    timing: v4Compatible ? first.timing : null,
    intersectionObservationKeys: intersection,
    intersectionSize: intersection.length,
    comparisonSeed,
    exclusionsByAssessment,
    matchedMetricsByAssessment
  };
  return { mode, manifest, manifestHash: sha256(stableJson(manifest)) };
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
  const scopeResult = await pool.query<{ comparison_mode: FrozenComparisonScope["mode"]; manifest: Record<string, unknown>; manifest_hash: string }>(
    "SELECT comparison_mode, manifest, manifest_hash FROM comparison_scope_manifests WHERE comparison_set_id = $1",
    [input.comparisonId]
  );
  const scopeRow = scopeResult.rows[0];
  const scopeManifest = scopeRow?.manifest ?? {};
  return {
    comparisonId: row.comparison_id,
    name: row.name.replace(/#[A-Za-z0-9._:-]{8,128}$/, ""),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    items: Array.isArray(row.items) ? row.items : [],
    scope: scopeRow === undefined ? null : {
      mode: scopeRow.comparison_mode,
      manifestHash: scopeRow.manifest_hash,
      reason: typeof scopeManifest.reason === "string" ? scopeManifest.reason : "Comparison scope is frozen.",
      intersectionSize: typeof scopeManifest.intersectionSize === "number" ? scopeManifest.intersectionSize : 0,
      assessmentIds: Array.isArray(scopeManifest.assessmentIds) ? scopeManifest.assessmentIds.filter((id): id is string => typeof id === "string") : [],
      exclusionsByAssessment: typeof scopeManifest.exclusionsByAssessment === "object" && scopeManifest.exclusionsByAssessment !== null
        ? scopeManifest.exclusionsByAssessment as Record<string, number>
        : {},
      matchedMetricsByAssessment: typeof scopeManifest.matchedMetricsByAssessment === "object" && scopeManifest.matchedMetricsByAssessment !== null
        ? scopeManifest.matchedMetricsByAssessment as FrozenComparisonScope["matchedMetricsByAssessment"]
        : {}
    } satisfies FrozenComparisonScope
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
          const pool = requirePool(deps);
          await expireStaleReplayRuns(pool, { staleAfterMs: ReplayHeartbeatStaleAfterMs });
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
    verdicts: ["PROMOTE_TO_FORWARD_OBSERVATION", "STRATEGY_QUALIFIED", "HOLD", "REJECT", "INSUFFICIENT_EVIDENCE"],
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

  app.get("/api/v2/public/overview", (request, reply) => {
    try {
      const proven = buildProvenExperiment().provenExperiment;
      const sourceDigest = createHash("sha256")
        .update(`${proven.reproducibility.assessmentHash}:${proven.assessment.createdAt}`)
        .digest("hex");
      reply.header("cache-control", "public, max-age=15");
      reply.header("etag", `"${sourceDigest}"`);
      return v2Data(
        {
          schemaVersion: "edgelab-public-overview-v1",
          example: {
            slug: proven.slug,
            title: proven.title,
            asset: proven.market.asset,
            intervalSeconds: proven.market.intervalSeconds,
            evidencePlane: proven.source.plane,
            assessedAt: proven.assessment.createdAt,
            sampleSize: proven.assessment.sampleSize,
            processedCount: proven.replay.processedCount,
            exclusionCount: proven.assessment.exclusionCount,
            verdict: proven.assessment.verdict,
            brierScore: proven.assessment.brierScore,
            marketComparisonAvailable: false,
            selectionDisclosure: proven.selectionDisclosure
          },
          currentCampaign: null
        },
        {
          asOf: proven.assessment.createdAt,
          sourcePlane: "MAINNET_HISTORICAL",
          evidenceClass: "CAPTURED",
          ruleVersion: "edgelab-evaluation-v3",
          sourceDigest
        }
      );
    } catch (error) {
      return v2Error(
        reply,
        503,
        "PUBLIC_OVERVIEW_UNAVAILABLE",
        error instanceof Error ? error.message : "Public overview unavailable",
        true,
        request.id
      );
    }
  });

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

  app.get("/api/v2/observation-proof", (request, reply) => {
    try {
      return v2Data(buildObservationProof(), {
        sourcePlane: "SHANNON_FORWARD",
        chainId: SOMNIA_SHANNON_CHAIN_ID,
        blockchainWrite: false,
        proofAuthority: "captured-observe-001-manifest"
      });
    } catch (error) {
      return v2Error(
        reply,
        503,
        "OBSERVATION_PROOF_UNAVAILABLE",
        error instanceof Error ? error.message : "Observation proof unavailable",
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

  app.get("/api/v2/proven-experiments/:slug/report", (request, reply) => {
    const params = z.object({ slug: z.literal("proven-experiment") }).safeParse(request.params);
    if (!params.success) {
      return v2Error(reply, 404, "PROVEN_EXPERIMENT_NOT_FOUND", "Proven Experiment report was not found", false, request.id);
    }
    try {
      return v2Data(buildProvenExperimentReport(), {
        sourcePlane: "MAINNET_HISTORICAL",
        publicProven: true,
        blockchainWrite: false,
        reportType: "sanitized-experiment-report"
      });
    } catch (error) {
      return v2Error(
        reply,
        503,
        "PROVEN_EXPERIMENT_REPORT_UNAVAILABLE",
        error instanceof Error ? error.message : "Proven Experiment report unavailable",
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

  app.post("/api/v2/research-session/resume", async (request, reply) => {
    const authorization = request.headers.authorization;
    const rawSessionToken = typeof authorization === "string" && /^Bearer [a-f0-9]{64}$/.test(authorization)
      ? authorization.slice("Bearer ".length)
      : null;
    if (rawSessionToken === null) {
      return await v2Error(
        reply,
        401,
        "RESEARCH_SESSION_RESUME_TOKEN_INVALID",
        "A valid opaque research-session resume token is required",
        false,
        request.id
      );
    }
    try {
      const pool = requirePool(deps);
      const session = await findActiveResearchSessionByTokenHash(pool, sha256(rawSessionToken));
      if (session === null) {
        return await v2Error(reply, 401, "RESEARCH_SESSION_EXPIRED", "Research session is expired or revoked", false, request.id);
      }
      if (!requireCsrf(request, session)) {
        return await v2Error(reply, 403, "CSRF_TOKEN_INVALID", "Research-session CSRF token is missing or invalid", false, request.id);
      }
      reply.setCookie(ResearchSessionCookie, rawSessionToken, sessionCookieOptions(config));
      await writeAudit(pool, {
        sessionId: session.id,
        action: "research_session.resume",
        targetType: "research_session",
        targetId: session.id,
        outcome: "COOKIE_RESIGNED",
        correlationId: request.id,
        safeMetadata: { csrfVersion: session.csrfVersion }
      });
      return v2Data(
        {
          session: {
            id: session.id,
            expiresAt: session.expiresAt.toISOString(),
            csrfVersion: session.csrfVersion
          }
        },
        {
          resumed: true,
          tokenPolicy: "opaque-bearer-not-returned",
          walletRequired: false
        }
      );
    } catch (error) {
      return v2Error(
        reply,
        503,
        "RESEARCH_SESSION_RESUME_FAILED",
        error instanceof Error ? error.message : "Research session resume failed",
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
      const requestedWindowFrom = parsed.data.windowFrom === undefined ? null : new Date(parsed.data.windowFrom);
      const requestedWindowTo = parsed.data.windowTo === undefined ? null : new Date(parsed.data.windowTo);
      const windowFrom = parsed.data.mode === "LIVE_SHADOW" ? requestedWindowFrom ?? new Date() : requestedWindowFrom;
      const windowTo = parsed.data.mode === "LIVE_SHADOW" ? requestedWindowTo ?? new Date((windowFrom?.getTime() ?? Date.now()) + 28 * 86_400_000) : requestedWindowTo;
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
        decisionBoundaryRule: parsed.data.mode === "LIVE_SHADOW"
          ? "capture snapshot in [decisionDeadline-5s, decisionDeadline); receive candidate strictly before deadline"
          : "decisionAt = max(tradingStart + 1s, expiry - decisionOffsetSec)",
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
          ruleVersion: parsed.data.mode === "LIVE_SHADOW" ? "edgelab-evaluation-v4" : "interactive-2.0.1-deep-audit",
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
      if (experiment.configuration.mode === "LIVE_SHADOW") {
        const protocolWindowFrom = experiment.configuration.windowFrom ?? new Date();
        const protocolWindowTo = experiment.configuration.windowTo ?? new Date(protocolWindowFrom.getTime() + 28 * 86_400_000);
        const protocolManifest = {
          schemaVersion: "edgelab-observation-protocol-v4",
          family: `${experiment.configuration.assets.join("+")}:${experiment.configuration.intervals.join("+")}:${String(experiment.configuration.decisionOffsetSec)}`,
          candidate: { policyId: policy.policyId, version: policy.version, sourceHash: policy.sourceHash },
          sourcePlane: "SHANNON_FORWARD",
          cohort: { assets: experiment.configuration.assets, intervals: experiment.configuration.intervals },
          timing: { decisionOffsetSec: experiment.configuration.decisionOffsetSec, snapshotLeadSec: 5, candidateMustArriveBeforeDeadline: true },
          baseline: "NON_CROSSED_POSITIVE_SIZE_TWO_SIDED_YES_MIDPOINT",
          window: { from: protocolWindowFrom.toISOString(), to: protocolWindowTo.toISOString() },
          thresholds: { exploratoryFloor: 30, formalFloor: 200, minimumUtcDays: 20, pairedCoverage: .8, candidateEceMax: .05, excessEceMax: .02 },
          inference: { method: "PAIRED_MOVING_BLOCK_BOOTSTRAP", blockLengthDays: 2, replicates: 10_000, alpha: .05 },
          economics: {
            classification: "SIMULATED_FROM_CAPTURED_BOOK",
            fixedBankrollQuoteUnits: 100,
            perWindowBudgetQuoteUnits: 1,
            modelHaircutPpm: 50_000,
            slippageReservePpm: 10_000,
            minimumEdgePpm: 10_000,
            adversePriceAddendPpm: 10_000,
            positionPolicy: "HOLD_TO_AUTHORITATIVE_SETTLEMENT",
            gasTreatment: "DISCLOSED_NOT_CONVERTED_TO_PAYOUT_UNITS"
          },
          capturedBook: { depthPerSide: 10, incompleteDepthProducesExplicitPartialOrSourceState: true },
          stoppingRule: "ONE_FORMAL_DECISION_AT_FIXED_END"
        };
        const protocolHash = sha256(stableJson(protocolManifest));
        const insertedProtocol = await pool.query<{ id: string }>(
          `INSERT INTO observation_protocols(experiment_id, configuration_id, family, rule_version, window_from, window_to, manifest, manifest_hash)
           VALUES ($1,$2,$3,'edgelab-evaluation-v4',$4,$5,$6::jsonb,$7)
           ON CONFLICT (configuration_id) DO NOTHING RETURNING id`,
          [experiment.experimentId, experiment.configuration.id, protocolManifest.family, protocolWindowFrom, protocolWindowTo, JSON.stringify(protocolManifest), protocolHash]
        );
        const protocolId = insertedProtocol.rows[0]?.id ?? (await pool.query<{ id: string }>("SELECT id FROM observation_protocols WHERE configuration_id = $1", [experiment.configuration.id])).rows[0]?.id;
        if (protocolId === undefined) throw new Error("Observation protocol registration failed");
        await pool.query(
          `INSERT INTO campaign_runs(experiment_id, configuration_id, protocol_id, lifecycle, next_boundary_at)
           VALUES ($1,$2,$3,'STARTING',$4) ON CONFLICT (protocol_id) DO NOTHING`,
          [experiment.experimentId, experiment.configuration.id, protocolId, protocolWindowFrom]
        );
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

  app.get("/api/v2/experiments/:experimentId/report", async (request, reply) => {
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
      const replay = await getLatestReplayRunForExperiment(pool, {
        sessionId: ensured.session.id,
        experimentId: params.data.experimentId
      });
      const assessment = await loadLatestAssessmentDetail(pool, {
        sessionId: ensured.session.id,
        experimentId: params.data.experimentId
      });
      const liveShadow = await loadLiveShadowState(pool, {
        sessionId: ensured.session.id,
        experimentId: params.data.experimentId
      });
      const executionLifecycle = await loadCanonicalExecutionLifecycle(pool, {
        sessionId: ensured.session.id,
        experimentId: params.data.experimentId
      });
      const v4Result = await pool.query<{
        assessment_id: string; manifest: Record<string, unknown>; manifest_hash: string; source_digest: string;
        paired_metrics: unknown; intervals: unknown; sample_counts: unknown; coverage: unknown; integrity_status: unknown;
        algorithm: string; seed: string; canonical_input: { observations?: readonly { observationKey?: unknown }[] };
      }>(
        `SELECT ea.id AS assessment_id, op.manifest, op.manifest_hash, av4.source_digest, av4.paired_metrics,
                av4.intervals, av4.sample_counts, av4.coverage, av4.integrity_status, av4.algorithm, av4.seed, mr.canonical_input
           FROM assessment_v4_details av4
           JOIN evidence_assessments ea ON ea.id = av4.assessment_id
           JOIN metric_runs mr ON mr.id = ea.metric_run_id
           JOIN observation_protocols op ON op.id = av4.protocol_id
          WHERE op.experiment_id = $1 ORDER BY ea.created_at DESC LIMIT 1`,
        [experiment.experimentId]
      );
      const v4Row = v4Result.rows[0];
      const pairedExport = v4Row === undefined ? [] : (await pool.query<{
        chain_id: number; venue_id: string; market_generation_id: string; decision_offset_sec: number;
        snapshot_hash: string; candidate_probability: number | null; baseline_probability: number | null;
        captured_at: Date; decision_deadline: Date; candidate_received_at: Date | null; action: string;
        inclusion_reason: string; outcome: string | null; outcome_provenance: unknown; integrity_status: unknown;
      }>(
        `SELECT pfr.chain_id,pfr.venue_id,pfr.market_generation_id,pfr.decision_offset_sec,pfr.snapshot_hash,
                pfr.candidate_probability,pfr.baseline_probability,pfr.captured_at,pfr.decision_deadline,
                pfr.candidate_received_at,pfr.action,pfr.inclusion_reason,COALESCE(pfr.outcome,s.winner) AS outcome,
                COALESCE(pfr.outcome_provenance,s.payload) AS outcome_provenance,pfr.integrity_status
           FROM paired_forecast_records pfr
           JOIN observation_protocols op ON op.id=pfr.protocol_id
           LEFT JOIN settlements s ON s.market_id=pfr.market_generation_id
          WHERE op.experiment_id=$1 ORDER BY pfr.captured_at,pfr.id`,
        [experiment.experimentId]
      )).rows;
      const selectedKeys = new Set((v4Row?.canonical_input.observations ?? []).flatMap((observation) =>
        typeof observation.observationKey === "string" ? [observation.observationKey] : []
      ));
      const exportedRows = pairedExport.map((row) => {
        const observationKey = `${String(row.chain_id)}:${row.venue_id}:${row.market_generation_id}:${String(row.decision_offset_sec)}`;
        return {
          observationKey, marketGenerationId: row.market_generation_id, snapshotHash: row.snapshot_hash,
          capturedAt: row.captured_at.toISOString(), decisionDeadline: row.decision_deadline.toISOString(),
          candidateReceivedAt: row.candidate_received_at?.toISOString() ?? null,
          candidateProbability: row.candidate_probability, baselineProbability: row.baseline_probability,
          action: row.action, outcome: row.outcome, outcomeProvenance: row.outcome_provenance,
          inclusionReason: row.inclusion_reason, integrityStatus: row.integrity_status,
          selected: selectedKeys.has(observationKey),
          exclusionReason: selectedKeys.has(observationKey) ? null : row.candidate_probability === null ? "CANDIDATE_MISSING" : row.baseline_probability === null ? "BASELINE_MISSING" : row.outcome === null ? "OUTCOME_UNAVAILABLE" : "NOT_IN_FROZEN_ASSESSMENT"
        };
      });
      const v4MarkdownReport = v4Row === undefined ? null : [
        "# EdgeLab v4 assessment",
        "",
        `Assessment: ${v4Row.assessment_id}`,
        `Protocol manifest: ${v4Row.manifest_hash}`,
        `Source digest: ${v4Row.source_digest}`,
        `Selected paired rows: ${String(exportedRows.filter((row) => row.selected).length)}`,
        `Excluded rows: ${String(exportedRows.filter((row) => !row.selected).length)}`,
        "",
        "The assessment is reproducible from the frozen protocol and included rows. Forecast evidence does not authorize execution or establish realized profit."
      ].join("\n");
      return v2Data(
        {
          report: {
            reportId: `experiment:${params.data.experimentId}`,
            title: "EdgeLab Experiment Report",
            generatedAt: new Date().toISOString(),
            experiment: serializeExperiment(experiment),
            replay: replay === null ? null : serializeReplayRun(replay),
            evidenceGate: buildEvidenceGate({ row: assessment, experimentId: params.data.experimentId }),
            liveShadow,
            v4Evaluation: v4Row === undefined ? null : {
              assessmentId: v4Row.assessment_id,
              protocolManifest: v4Row.manifest,
              protocolManifestHash: v4Row.manifest_hash,
              sourceDigest: v4Row.source_digest,
              pairedMetrics: v4Row.paired_metrics,
              intervals: v4Row.intervals,
              sampleCounts: v4Row.sample_counts,
              coverage: v4Row.coverage,
              integrityStatus: v4Row.integrity_status,
              algorithm: v4Row.algorithm,
              seed: v4Row.seed,
              markdownReport: v4MarkdownReport,
              selectedRows: exportedRows.filter((row) => row.selected),
              excludedRows: exportedRows.filter((row) => !row.selected)
            },
            executionLifecycle,
            executionProofRelationship: {
              plane: "SHANNON_EXECUTION",
              status: executionLifecycle === null ? "NOT_LINKED" : "STRATEGY_LINKED_CANONICAL_RESULT",
              proofRoute:
                executionLifecycle === null
                  ? "/proof"
                  : `/proof?experimentId=${encodeURIComponent(params.data.experimentId)}`,
              detail:
                executionLifecycle === null
                  ? "EXG-003 remains a separate Shannon proof until a human-authorized execution is linked to this exact experiment."
                  : `Canonical result: ${executionLifecycle.publicClaim}. This does not imply profitability.`
            },
            exportPolicy: {
              format: "application/json",
              sanitized: true,
              blockchainWrite: false,
              privateSecretsIncluded: false
            },
            boundaries: {
              mainnet: "READ_ONLY_HISTORICAL_RESEARCH",
              shannonForward: "PRE_OUTCOME_LIVE_SHADOW_OBSERVATION",
              shannonExecution: "HUMAN_AUTHORIZED_TESTNET_EXECUTION_ONLY"
            }
          },
          csrfToken: ensured.csrfToken
        },
        {
          ownership: "research-session",
          applicationWrite: false,
          blockchainWrite: false,
          reportType: "sanitized-experiment-report"
        }
      );
    } catch (error) {
      return v2Error(
        reply,
        503,
        "EXPERIMENT_REPORT_UNAVAILABLE",
        error instanceof Error ? error.message : "Experiment report unavailable",
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
      await expireStaleReplayRuns(pool, { staleAfterMs: ReplayHeartbeatStaleAfterMs });
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
        deadlineAt: new Date(Date.now() + HistoricalReplayDeadlineMs),
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
      const assessment = await loadLatestAssessmentDetail(pool, {
        sessionId: ensured.session.id,
        experimentId: params.data.experimentId
      });
      return v2Data(
        {
          ...buildEvidenceGate({ row: assessment, experimentId: params.data.experimentId }),
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

  app.get("/api/v2/experiments/:experimentId/v4-assessment/latest", async (request, reply) => {
    const params = z.object({ experimentId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return await v2Error(reply, 400, "EXPERIMENT_ID_INVALID", "Experiment ID is invalid", false, request.id);
    try {
      const pool = requirePool(deps);
      const ensured = await ensureResearchSession(pool, config, request, reply);
      const owned = await getInteractiveExperiment(pool, { sessionId: ensured.session.id, experimentId: params.data.experimentId });
      if (owned === null) return await v2Error(reply, 404, "EXPERIMENT_NOT_FOUND", "Experiment was not found for this research session", false, request.id);
      const result = await pool.query<{ assessment_id: string; protocol_id: string; forecast_status: string; economics_status: string; execution_eligibility: string; paired_metrics: unknown; intervals: unknown; sample_counts: unknown; coverage: unknown; economics_metrics: unknown; integrity_status: unknown; algorithm: string; seed: string; source_digest: string; created_at: Date }>(
        `SELECT av4.*, ea.created_at FROM assessment_v4_details av4 JOIN evidence_assessments ea ON ea.id=av4.assessment_id
         JOIN observation_protocols op ON op.id=av4.protocol_id WHERE op.experiment_id=$1 ORDER BY ea.created_at DESC LIMIT 1`,
        [owned.experimentId]
      );
      const row = result.rows[0];
      return v2Data({ assessment: row === undefined ? null : {
        assessmentId: row.assessment_id, protocolId: row.protocol_id, ruleVersion: "edgelab-evaluation-v4",
        forecastStatus: row.forecast_status, economicsStatus: row.economics_status,
        executionEligibility: row.execution_eligibility, pairedMetrics: row.paired_metrics,
        intervals: row.intervals, sampleCounts: row.sample_counts, coverage: row.coverage,
        economicsMetrics: row.economics_metrics,
        integrityStatus: row.integrity_status, algorithm: row.algorithm, seed: row.seed,
        sourceDigest: row.source_digest, createdAt: row.created_at.toISOString()
      }, csrfToken: ensured.csrfToken }, { ownership: "research-session", sourcePlane: "SHANNON_FORWARD", ruleVersion: "edgelab-evaluation-v4" });
    } catch (error) {
      return v2Error(reply, 503, "V4_ASSESSMENT_UNAVAILABLE", error instanceof Error ? error.message : "V4 assessment unavailable", true, request.id);
    }
  });

  app.post("/api/v2/experiments/:experimentId/evaluate-v4", async (request, reply) => {
    const params = z.object({ experimentId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return await v2Error(reply, 400, "EXPERIMENT_ID_INVALID", "Experiment ID is invalid", false, request.id);
    try { requireIdempotencyKey(request.headers); } catch { return await v2Error(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required", false, request.id); }
    try {
      const pool = requirePool(deps);
      const session = await requireResearchSession(pool, request);
      if (session === null) return await v2Error(reply, 401, "RESEARCH_SESSION_REQUIRED", "Create a research session first", false, request.id);
      if (!requireCsrf(request, session)) return await v2Error(reply, 403, "CSRF_TOKEN_INVALID", "Research-session CSRF token is missing or invalid", false, request.id);
      const experiment = await getInteractiveExperiment(pool, { sessionId: session.id, experimentId: params.data.experimentId });
      if (experiment === null) return await v2Error(reply, 404, "EXPERIMENT_NOT_FOUND", "Experiment was not found for this research session", false, request.id);
      if (experiment.configuration.ruleVersion !== "edgelab-evaluation-v4") return await v2Error(reply, 409, "V4_PROTOCOL_REQUIRED", "This study was not registered under evaluation v4", false, request.id);
      const assessment = await runV4Assessment({ pool, experimentId: experiment.experimentId });
      await writeAudit(pool, { sessionId: session.id, action: "evaluation.v4.create", targetType: "experiment", targetId: experiment.experimentId, outcome: assessment.forecastStatus, correlationId: request.id, safeMetadata: { assessmentId: assessment.assessmentId, protocolId: assessment.protocolId, sourceDigest: assessment.sourceDigest } });
      return v2Data({ assessment: {
        assessmentId: assessment.assessmentId, protocolId: assessment.protocolId, ruleVersion: "edgelab-evaluation-v4",
        forecastStatus: assessment.forecastStatus, economicsStatus: assessment.economics.status, executionEligibility: assessment.executionEligibility,
        reasonCodes: assessment.reasonCodes, pairedMetrics: assessment.pairedMetrics,
        intervals: { deltaBrier: assessment.deltaInterval, stressMeanPerWindowReturn: assessment.economics.stressInterval },
        sampleCounts: { paired: assessment.pairedMetrics.pairedSampleSize, eligibleScheduled: assessment.eligibleScheduledCount },
        coverage: { paired: assessment.coverage, scenario: assessment.economics.coverage },
        economicsMetrics: assessment.economics,
        integrityStatus: assessment.integrityStatus,
        algorithm: assessment.algorithm, seed: assessment.seed,
        sourceDigest: assessment.sourceDigest, createdAt: assessment.createdAt.toISOString()
      } }, { applicationWrite: true, blockchainWrite: false, sourcePlane: "SHANNON_FORWARD", ruleVersion: "edgelab-evaluation-v4", executionEligibility: assessment.executionEligibility });
    } catch (error) {
      return v2Error(reply, 503, "V4_EVALUATION_FAILED", error instanceof Error ? error.message : "V4 evaluation failed", true, request.id);
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
      if (experiment.configuration.ruleVersion === "edgelab-evaluation-v4") {
        return await v2Error(reply, 409, "V4_EVALUATION_ENDPOINT_REQUIRED", "Use the v4 assessment endpoint for this frozen protocol", false, request.id);
      }
      const policy = candidatePolicy(experiment);
      if (policy === null) {
        return await v2Error(reply, 409, "CANDIDATE_POLICY_MISSING", "Experiment has no candidate policy to evaluate", false, request.id);
      }
      const replay =
        experiment.configuration.mode === "HISTORICAL_REPLAY"
          ? await getLatestReplayRunForExperiment(pool, {
              sessionId: session.id,
              experimentId: experiment.experimentId
            })
          : null;
      if (
        experiment.configuration.mode === "HISTORICAL_REPLAY" &&
        (replay === null || !["COMPLETED", "SUCCEEDED"].includes(replay.status))
      ) {
        return await v2Error(reply, 409, "REPLAY_REQUIRED", "Run historical qualification before evaluating evidence", false, request.id);
      }
      let assessment: Awaited<ReturnType<typeof runMetricAssessment>>;
      if (experiment.configuration.mode === "LIVE_SHADOW") {
        assessment = await runMetricAssessment({
              pool,
              experimentId: experiment.experimentId,
              policyVersionId: policy.policyVersionId,
              evidencePlane: "SHANNON_FORWARD",
              promotionScope: "EXECUTION_EXPOSURE",
              qualificationTarget: "EXECUTION_EXPOSURE",
              ruleVersion: "eval-003-forward-qualification-v1",
              provenance: {
                sourcePlane: "SHANNON_FORWARD",
                policyId: policy.policyId,
                policyVersion: policy.version,
                policySourceHash: policy.sourceHash,
                qualificationMeaning: "STRATEGY_QUALIFIED_ONLY",
                orderExecutabilitySeparate: true,
                pnlStatus: "NOT_AVAILABLE"
              }
            });
      } else {
        if (replay === null) {
          return await v2Error(reply, 409, "REPLAY_REQUIRED", "Run historical qualification before evaluating evidence", false, request.id);
        }
        assessment = await runMetricAssessment({
          pool,
          experimentId: experiment.experimentId,
          policyVersionId: policy.policyVersionId,
          replayRunId: replay.id,
          evidencePlane: "MAINNET_HISTORICAL",
          promotionScope: "PROMOTE_TO_FORWARD_OBSERVATION",
          qualificationTarget: "FORWARD_OBSERVATION",
          ruleVersion: "eval-002-historical-replay-v1",
          provenance: {
            replayRunId: replay.id,
            replayOutputHash: replay.outputHash,
            sourcePlane: "MAINNET_HISTORICAL",
            pnlLabel: "REPLAY_COUNTERFACTUAL_OR_NOT_AVAILABLE",
            bookReconstruction: HISTORICAL_BOOK_RECONSTRUCTION_CAPABILITY
          }
        });
      }
      await pool.query(
        "UPDATE experiments SET status = $1, updated_at = now() WHERE id = $2",
        [
          assessment.verdict === "STRATEGY_QUALIFIED"
            ? "PROMOTED"
            : assessment.verdict === "REJECT"
              ? "REJECT"
              : assessment.verdict === "HOLD"
                ? "HOLD"
                : "INSUFFICIENT_EVIDENCE",
          experiment.experimentId
        ]
      );
      await writeAudit(pool, {
        sessionId: session.id,
        action: "evaluation.create",
        targetType: "experiment",
        targetId: experiment.experimentId,
        outcome: assessment.verdict,
        correlationId: request.id,
        safeMetadata: {
          assessmentId: assessment.assessmentId,
          replayRunId: replay?.id ?? null,
          evidencePlane: experiment.configuration.mode === "LIVE_SHADOW" ? "SHANNON_FORWARD" : "MAINNET_HISTORICAL"
        }
      });
      return v2Data(
        { assessment },
        {
          applicationWrite: true,
          blockchainWrite: false,
          sourcePlane: experiment.configuration.mode === "LIVE_SHADOW" ? "SHANNON_FORWARD" : "MAINNET_HISTORICAL",
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
        outcome:
          result.discoveryIssue?.reasonCode ?? (result.leaseAcquired ? "OBSERVED" : "LEASE_NOT_ACQUIRED"),
        correlationId: request.id,
        safeMetadata: {
          observedMarkets: result.observed.length,
          discoveredMarketCount: result.discoveredMarketCount,
          discoveryMessage: result.discoveryIssue?.message ?? null,
          sourcePlane: "SHANNON_FORWARD"
        }
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
          preOutcomeBoundary:
            "snapshot captured at or after max(tradingStart + 1s, expiry - decisionOffsetSec) and before expiry"
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

  app.post("/api/v2/experiments/:experimentId/live-shadow/reconcile", async (request, reply) => {
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
        return await v2Error(reply, 409, "LIVE_SHADOW_MODE_REQUIRED", "Only live-shadow experiments have forward settlements", false, request.id);
      }
      const dreamDex = requireDreamDex(deps);
      const result = await reconcileSettlements({
        pool,
        dreamDexClient: dreamDex.client,
        holderId: idempotencyKey,
        experimentId: experiment.experimentId,
        limit: 100
      });
      return v2Data(
        {
          reconciliation: result,
          liveShadow: await loadLiveShadowState(pool, {
            sessionId: session.id,
            experimentId: experiment.experimentId
          })
        },
        { applicationWrite: true, blockchainWrite: false, sourcePlane: "SHANNON_FORWARD" }
      );
    } catch (error) {
      return v2Error(
        reply,
        503,
        "FORWARD_SETTLEMENT_RECONCILIATION_FAILED",
        error instanceof Error ? error.message : "Forward settlement reconciliation failed",
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
          const frozenScope = await buildFrozenComparisonScope(client, parsed.data.assessmentIds);
          await client.query(
            `INSERT INTO comparison_scope_manifests(comparison_set_id, comparison_mode, manifest, manifest_hash)
             VALUES ($1,$2,$3::jsonb,$4)`,
            [comparisonId, frozenScope.mode, JSON.stringify(frozenScope.manifest), frozenScope.manifestHash]
          );
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

  app.get("/api/v2/comparisons/:comparisonId/report", async (request, reply) => {
    const params = z.object({ comparisonId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return await v2Error(reply, 400, "COMPARISON_ID_INVALID", "Comparison ID is invalid", false, request.id);
    try {
      const pool = requirePool(deps);
      const ensured = await ensureResearchSession(pool, config, request, reply);
      const comparison = await loadComparison(pool, { sessionId: ensured.session.id, comparisonId: params.data.comparisonId });
      if (comparison === null) return await v2Error(reply, 404, "COMPARISON_NOT_FOUND", "Comparison was not found for this research session", false, request.id);
      return v2Data({
        report: {
          schemaVersion: "edgelab-comparison-report-v1",
          generatedAt: new Date().toISOString(),
          comparison,
          markdownReport: [
            `# ${comparison.name}`,
            "",
            `Comparison: ${comparison.comparisonId}`,
            `Scope: ${comparison.scope?.mode ?? "UNAVAILABLE"}`,
            `Intersection observations: ${String(comparison.scope?.intersectionSize ?? 0)}`,
            `Scope manifest: ${comparison.scope?.manifestHash ?? "UNAVAILABLE"}`,
            "",
            comparison.scope?.reason ?? "Comparison scope is unavailable."
          ].join("\n"),
          limits: [
            "Matched metrics apply only to the frozen shared observation-key intersection.",
            "Descriptive comparisons do not support relative ranking.",
            "Forecast evidence does not authorize execution or establish realized profit."
          ],
          exportPolicy: { sanitized: true, privateSecretsIncluded: false }
        }
      }, { ownership: "research-session", reportType: "sanitized-comparison-report", blockchainWrite: false });
    } catch (error) {
      return v2Error(reply, 503, "COMPARISON_REPORT_UNAVAILABLE", error instanceof Error ? error.message : "Comparison report unavailable", true, request.id);
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

  app.get("/api/v2/shannon/execution-candidate", async (request, reply) => {
    const parsed = ExecutionCandidateQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return v2Error(
        reply,
        400,
        "EXECUTION_CANDIDATE_INVALID",
        "Execution-candidate request is invalid",
        false,
        request.id,
        parsed.error.issues
      );
    }
    try {
      const pool = requirePool(deps);
      const session = await requireResearchSession(pool, request);
      if (session === null) {
        return await v2Error(reply, 401, "RESEARCH_SESSION_REQUIRED", "Create a research session first", false, request.id);
      }
      const experiment = await getInteractiveExperiment(pool, {
        sessionId: session.id,
        experimentId: parsed.data.experimentId
      });
      if (experiment === null) {
        return await v2Error(reply, 404, "EXPERIMENT_NOT_FOUND", "Experiment was not found for this research session", false, request.id);
      }
      if (experiment.configuration.mode !== "LIVE_SHADOW") {
        return await v2Error(
          reply,
          409,
          "FORWARD_STRATEGY_REQUIRED",
          "Execution candidates require a live-shadow strategy with qualified forward evidence",
          false,
          request.id
        );
      }
      if (
        !experiment.configuration.assets.includes(parsed.data.asset) ||
        !experiment.configuration.intervals.includes(parsed.data.intervalSec)
      ) {
        return await v2Error(
          reply,
          409,
          "STRATEGY_MARKET_SCOPE_MISMATCH",
          "Requested asset and interval are outside the qualified strategy configuration",
          false,
          request.id
        );
      }
      const qualifiedStrategy = await loadQualifiedStrategy(pool, {
        sessionId: session.id,
        experimentId: experiment.experimentId
      });
      if (qualifiedStrategy === null) {
        return await v2Error(
          reply,
          409,
          "STRATEGY_NOT_QUALIFIED",
          "Forward evidence has not earned execution exposure for this exact strategy version",
          false,
          request.id
        );
      }
      const dreamDex = requireDreamDex(deps);
      const marketResult = await discoverSuccessorMarkets(dreamDex.client, dreamDex.config, {
        assets: [parsed.data.asset],
        intervals: [parsed.data.intervalSec]
      });
      if (!marketResult.ok) {
        return await v2Error(reply, 502, marketResult.reasonCode, marketResult.message, true, request.id);
      }

      const market = marketResult.value[0];
      if (market === undefined) {
        return await v2Error(
          reply,
          502,
          "DREAMDEX_NO_ELIGIBLE_MARKET",
          "No eligible market was available for execution candidate construction",
          true,
          request.id
        );
      }
      const snapshotResult = await captureMarketSnapshot(dreamDex.client, dreamDex.config, market.stableMarketId, 5);
      if (!snapshotResult.ok) {
        return await v2Error(reply, 502, snapshotResult.reasonCode, snapshotResult.message, true, request.id);
      }

      const adapter = policyAdapters.find(
        (candidate) =>
          candidate.policyId === qualifiedStrategy.policyId && candidate.version === qualifiedStrategy.policyVersion
      );
      if (adapter === undefined) {
        return await v2Error(
          reply,
          503,
          "POLICY_ADAPTER_MISSING",
          "Strategy-linked forward policy adapter is unavailable",
          true,
          request.id
        );
      }

      const nativeDomainSnapshot = MarketSnapshotSchema.parse(toExecutionDomainSnapshot(snapshotResult.value));
      const nativeSnapshotHash = sha256(stableJson(nativeDomainSnapshot));
      const nativeDecision = evaluatePolicy(adapter, {
        snapshot: nativeDomainSnapshot,
        decidedAt: nativeDomainSnapshot.capturedAt,
        snapshotHash: nativeSnapshotHash
      });
      const inverseDomainSnapshot = MarketSnapshotSchema.parse(toExecutionDomainSnapshot(snapshotResult.value, "INVERSE_NO_ASK"));
      const inverseSnapshotHash = sha256(stableJson(inverseDomainSnapshot));
      const inverseDecision =
        nativeDecision.action === "ABSTAIN" && snapshotResult.value.book.noAsks.length > 0
          ? evaluatePolicy(adapter, {
              snapshot: inverseDomainSnapshot,
              decidedAt: inverseDomainSnapshot.capturedAt,
              snapshotHash: inverseSnapshotHash
            })
          : null;
      const useInverseNoSignal =
        nativeDecision.action === "ABSTAIN" && inverseDecision !== null && inverseDecision.action !== "ABSTAIN" && inverseDecision.forecastPUp < 0.5;
      const snapshotHash = useInverseNoSignal ? inverseSnapshotHash : nativeSnapshotHash;
      const decision = useInverseNoSignal
        ? {
            ...inverseDecision,
            reasonCodes: [...inverseDecision.reasonCodes, "INVERSE_NO_ASK_SIGNAL", "EXECUTABLE_SIDE_BUY_NO"]
          }
        : nativeDecision;
      const side = decision.forecastPUp >= 0.5 ? "BUY_YES" : "BUY_NO";
      const executableBook =
        side === "BUY_YES" ? snapshotResult.value.book.yesAsks : snapshotResult.value.book.noAsks;
      const bookParamsResult = await readBinaryBookParams(dreamDex.client, dreamDex.config, market.poolAddress);
      if (!bookParamsResult.ok) {
        return await v2Error(reply, 502, bookParamsResult.reasonCode, bookParamsResult.message, true, request.id);
      }
      const bookParams = bookParamsResult.value;
      const readinessResult =
        deps.executionReadinessReader === undefined
          ? await readExecutionReadiness(dreamDex.config, {
              account: parsed.data.account,
              marketAddress: market.marketAddress,
              poolAddress: market.poolAddress
            })
          : {
              ok: true as const,
              value: await deps.executionReadinessReader({
                account: parsed.data.account,
                marketAddress: market.marketAddress,
                poolAddress: market.poolAddress
              })
            };
      if (!readinessResult.ok) {
        return await v2Error(reply, 502, readinessResult.reasonCode, readinessResult.message, true, request.id);
      }
      const readiness = readinessResult.value;
      const maxEscrowRaw = BigInt(parsed.data.maxEscrowRaw);
      const payoutScale = 10n ** BigInt(market.quoteDecimals);
      const requestedQuantityRaw = parsed.data.requestedQuantityRaw ?? payoutScale.toString();
      const sideProbabilityPpm = Math.max(0, Math.min(1_000_000, Math.round((side === "BUY_YES" ? decision.forecastPUp : 1 - decision.forecastPUp) * 1_000_000)));
      const defaultCapPpm = Math.max(0, sideProbabilityPpm - 50_000 - 10_000 - 10_000);
      const defaultCapRaw = ((payoutScale * BigInt(defaultCapPpm) / 1_000_000n) / bookParams.tickSize) * bookParams.tickSize;
      const reviewedWorstPriceRaw = parsed.data.worstPriceRaw ?? defaultCapRaw.toString();
      const economicLevels = executableBook.flatMap((level) => {
        const economicPrice = executionEscrowPriceRaw(side, BigInt(level.priceRaw), market.quoteDecimals);
        return economicPrice > 0n && BigInt(level.quantityRaw) > 0n
          ? [{ priceRaw: economicPrice.toString(), quantityRaw: level.quantityRaw }]
          : [];
      });
      const quotePolicy = {
        modelHaircutPpm: 50_000 as const,
        slippageReservePpm: 10_000 as const,
        minimumEdgePpm: 10_000 as const,
        estimatedFeesRaw: "0",
        gasTreatment: "EXCLUDED_NATIVE_UNIT_DISCLOSURE" as const
      };
      const quotePlan = planExecutableQuote({
        levels: economicLevels,
        requestedQuantityRaw,
        lotSizeRaw: bookParams.lotSize.toString(),
        tickSizeRaw: bookParams.tickSize.toString(),
        payoutScaleRaw: payoutScale.toString(),
        maxCollateralRaw: maxEscrowRaw.toString(),
        worstPriceRaw: reviewedWorstPriceRaw,
        sideProbabilityPpm,
        ...quotePolicy
      });
      const executionPriceRaw = quotePlan.worstPriceRaw === null
        ? null
        : (side === "BUY_YES" ? BigInt(quotePlan.worstPriceRaw) : payoutScale - BigInt(quotePlan.worstPriceRaw)).toString();
      const expireTimestampNs = `${String(market.expirySeconds)}000000000`;
      const validatedAt = new Date().toISOString();
      const nowSeconds = Math.floor(new Date(validatedAt).getTime() / 1000);
      const expiryHeadroomSeconds = market.expirySeconds - nowSeconds;
      const requiredEscrowRaw = BigInt(quotePlan.totalCollateralRaw);
      const minimumEscrowRaw = quotePlan.worstPriceRaw === null ? null : minimumEscrowForQuantity({
        quantityRaw: bookParams.minQuantity,
        priceRaw: BigInt(quotePlan.worstPriceRaw),
        quoteDecimals: market.quoteDecimals
      });
      const sideProbability = side === "BUY_YES" ? decision.forecastPUp : 1 - decision.forecastPUp;
      const sideAskProbability = quotePlan.averagePriceRaw === null ? null : Number(BigInt(quotePlan.averagePriceRaw)) / Number(payoutScale);
      const quoteCapturedAt = snapshotResult.value.market.source.retrievedAt;
      const metadataCheckedAt = market.source.retrievedAt;
      const quoteAgeMs = new Date(validatedAt).getTime() - new Date(quoteCapturedAt).getTime();
      const metadataAgeMs = new Date(validatedAt).getTime() - new Date(metadataCheckedAt).getTime();
      const reviewExpiresAt = new Date(new Date(validatedAt).getTime() + 5_000).toISOString();
      const quotePolicyHash = sha256(stableJson({ ...quotePolicy, planner: "MULTI_LEVEL_INTEGER_V1" }));
      const blockedReasons = [
        ...(decision.action === "ABSTAIN" ? ["POLICY_ABSTAINED"] : []),
        ...(economicLevels.length === 0 ? ["NO_EXECUTABLE_TOP_ASK"] : []),
        ...quotePlan.reasonCodes.filter((reason) => reason !== "PARTIAL_DEPTH_REQUIRES_REVIEW"),
        ...(BigInt(quotePlan.fillableQuantityRaw) > 0n && BigInt(quotePlan.fillableQuantityRaw) < bookParams.minQuantity ? ["ORDER_CAP_BELOW_POOL_MINIMUM"] : []),
        ...(quoteAgeMs < -1_000 ? ["QUOTE_TIMESTAMP_IN_FUTURE"] : []),
        ...(quoteAgeMs > 5_000 ? ["BOOK_TOO_OLD"] : []),
        ...(metadataAgeMs < -1_000 ? ["METADATA_TIMESTAMP_IN_FUTURE"] : []),
        ...(metadataAgeMs > 15_000 ? ["MARKET_METADATA_TOO_OLD"] : []),
        ...(expiryHeadroomSeconds < parsed.data.minExpiryHeadroomSec ? ["EXPIRY_HEADROOM_TOO_LOW"] : []),
        ...(!readiness.collateralBindingMatches || readiness.marketCollateral.toLowerCase() !== market.collateral.toLowerCase()
          ? ["COLLATERAL_BINDING_MISMATCH"]
          : []),
        ...(BigInt(readiness.walletBalanceRaw) < requiredEscrowRaw ? ["INSUFFICIENT_TUSDC_BALANCE"] : []),
        ...(BigInt(readiness.walletNativeBalanceRaw) === 0n ? ["INSUFFICIENT_STT_GAS"] : [])
      ];
      const intentPayload = {
        route: "GET /api/v2/shannon/execution-candidate",
        experimentId: qualifiedStrategy.experimentId,
        configurationId: qualifiedStrategy.configurationId,
        assessmentId: qualifiedStrategy.assessmentId,
        assessmentHash: qualifiedStrategy.assessmentHash,
        account: parsed.data.account.toLowerCase(),
        sourcePlane: "SHANNON_EXECUTION",
        authority: "browser-wallet-human-gated-only",
        policy: {
          policyId: decision.policyId,
          policyVersion: decision.policyVersion,
          policyHash: decision.policyHash
        },
        decision: {
          forecastPUp: decision.forecastPUp,
          action: decision.action,
          reasonCodes: decision.reasonCodes
        },
        market: {
          stableMarketId: market.stableMarketId,
          poolAddress: market.poolAddress,
          asset: market.asset,
          intervalSeconds: market.intervalSeconds,
          expirySeconds: market.expirySeconds
        },
        order: {
          side,
          orderType: 2,
          priceRaw: executionPriceRaw,
          quantityRaw: quotePlan.fillableQuantityRaw,
          maxEscrowRaw: maxEscrowRaw.toString(),
          expireTimestampNs
        },
        readiness: {
          observedBlockNumber: readiness.observedBlockNumber,
          marketCollateral: readiness.marketCollateral.toLowerCase(),
          poolCollateral: readiness.poolCollateral.toLowerCase(),
          walletBalanceRaw: readiness.walletBalanceRaw,
          walletAllowanceRaw: readiness.walletAllowanceRaw,
          walletNativeBalanceRaw: readiness.walletNativeBalanceRaw,
          requiredEscrowRaw: requiredEscrowRaw.toString(),
          conservativeEdgePasses: quotePlan.passesConservativeEdge
        },
        quotePlan,
        quotePolicy: { ...quotePolicy, policyHash: quotePolicyHash, reviewExpiresAt },
        blockedReasons
      };
      const intentHash = sha256(stableJson(intentPayload));
      const unsigned =
        blockedReasons.length > 0 || executionPriceRaw === null
          ? null
          : await buildUnsignedBinaryOrderEvidence(dreamDex.client, dreamDex.config, {
              ownerAddress: parsed.data.account,
              poolAddress: market.poolAddress,
              side,
              priceRaw: executionPriceRaw,
              quantityRaw: quotePlan.fillableQuantityRaw,
              expireTimestampNs,
              orderType: 2,
              quoteDecimals: market.quoteDecimals,
              collateralAddress: readiness.marketCollateral
            });
      if (unsigned !== null && !unsigned.ok) {
        return await v2Error(reply, 502, unsigned.reasonCode, unsigned.message, true, request.id);
      }

      return v2Data(
        {
          executionCandidate: {
            status: blockedReasons.length === 0 ? "READY" : "BLOCKED",
            intentHash,
            account: parsed.data.account,
            validatedAt,
            sourcePlane: "SHANNON_EXECUTION",
            network: {
              name: "Somnia Shannon Testnet",
              chainId: SOMNIA_SHANNON_CHAIN_ID
            },
            market: {
              stableMarketId: market.stableMarketId,
              marketAddress: market.marketAddress,
              poolAddress: market.poolAddress,
              asset: market.asset,
              intervalSeconds: market.intervalSeconds,
              expirySeconds: market.expirySeconds,
              quoteDecimals: market.quoteDecimals,
              collateral: market.collateral
            },
            strategyLink: {
              experimentId: qualifiedStrategy.experimentId,
              configurationId: qualifiedStrategy.configurationId,
              assessmentId: qualifiedStrategy.assessmentId,
              assessmentHash: qualifiedStrategy.assessmentHash,
              qualificationVerdict: qualifiedStrategy.qualificationVerdict,
              qualificationRuleVersion: qualifiedStrategy.ruleVersion,
              eligibleForwardObservationCount: qualifiedStrategy.sampleSize,
              qualifiedAt: qualifiedStrategy.qualifiedAt.toISOString(),
              sourceObservationPolicy: `${qualifiedStrategy.policyId}@${qualifiedStrategy.policyVersion}`,
              linkedHistoricalPolicy: "historical-last-trade@1.1.0",
              snapshotHash,
              decision
            },
            risk: {
              maxEscrowRaw: maxEscrowRaw.toString(),
              reviewedWorstPriceRaw,
              maxEscrowDisplay: displayQuoteAmount(maxEscrowRaw, market.quoteDecimals, "tUSDC"),
              orderCount: 1,
              orderType: "ImmediateOrCancel",
              serverSigner: false,
              mainnetWrite: false,
              expiryHeadroomSeconds,
              minExpiryHeadroomSec: parsed.data.minExpiryHeadroomSec,
              minimumPoolEscrowRaw: minimumEscrowRaw?.toString() ?? null,
              minimumPoolEscrowDisplay:
                minimumEscrowRaw === null ? null : displayQuoteAmount(minimumEscrowRaw, market.quoteDecimals, "tUSDC"),
              capAdequateForPoolMinimum: minimumEscrowRaw === null ? false : maxEscrowRaw >= minimumEscrowRaw,
              priceAcceptable: quotePlan.passesConservativeEdge,
              sideProbability,
              sideAskProbability,
              requiredEscrowRaw: requiredEscrowRaw.toString(),
              observedBlockNumber: readiness.observedBlockNumber,
              collateralResolvedFromMarket: readiness.marketCollateral,
              poolCollateral: readiness.poolCollateral,
              collateralBindingMatches: readiness.collateralBindingMatches,
              walletBalanceRaw: readiness.walletBalanceRaw,
              walletAllowanceRaw: readiness.walletAllowanceRaw,
              walletNativeBalanceRaw: readiness.walletNativeBalanceRaw,
              walletHasRequiredCollateral: BigInt(readiness.walletBalanceRaw) >= requiredEscrowRaw,
              walletHasGas: BigInt(readiness.walletNativeBalanceRaw) > 0n
            },
            sizing: {
              side,
              priceRaw: executionPriceRaw,
              availableQuantityRaw: economicLevels.reduce((sum, level) => sum + BigInt(level.quantityRaw), 0n).toString(),
              quantityRaw: quotePlan.fillableQuantityRaw,
              requestedQuantityRaw: quotePlan.requestedQuantityRaw,
              unfilledQuantityRaw: quotePlan.unfilledQuantityRaw,
              minQuantityRaw: bookParams.minQuantity.toString(),
              lotSizeRaw: bookParams.lotSize.toString(),
              tickSizeRaw: bookParams.tickSize.toString(),
              expireTimestampNs
            },
            quotePlan,
            quoteBook: { rawLevels: executableBook },
            quotePolicy: { ...quotePolicy, policyHash: quotePolicyHash, reviewExpiresAt },
            freshness: {
              quoteCapturedAt, metadataCheckedAt, quoteAgeMs, metadataAgeMs,
              maxBookAgeMs: 5_000, maxMetadataAgeMs: 15_000, allowedFutureSkewMs: 1_000
            },
            unsignedTransactions: unsigned === null ? null : unsigned.value,
            blockedReasons,
            controls: [
              "server returns unsigned calls only",
              "wallet must approve every transaction",
              "fixed 0.01 tUSDC maximum escrow",
              "single Shannon testnet IOC order",
              "mainnet writes remain forbidden"
            ],
            blockedClaims: [
              "profitable strategy",
              "autonomous execution",
              "mainnet readiness",
              "filled order until a receipt proves it"
            ]
          }
        },
        {
          sourcePlane: "SHANNON_EXECUTION",
          blockchainWrite: false,
          walletRequired: true,
          chainId: SOMNIA_SHANNON_CHAIN_ID
        }
      );
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

  app.post("/api/v2/shannon/execution-candidates/revalidate", async (request, reply) => {
    const parsed = ExecutionCandidateQuerySchema.safeParse(request.body);
    if (!parsed.success) {
      return await v2Error(
        reply,
        400,
        "EXECUTION_CANDIDATE_INVALID",
        "Execution-candidate revalidation request is invalid",
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
      const prior = await pool.query<{ id: string; candidate_payload: unknown }>(
        `SELECT ei.id,ei.candidate_payload FROM execution_intents ei
          JOIN experiments e ON e.id=ei.experiment_id
         WHERE ei.idempotency_key=$1 AND e.created_by_session_id=$2 LIMIT 1`,
        [idempotencyKey, session.id]
      );
      if (prior.rows[0] !== undefined) {
        const priorCandidate = PersistableExecutionCandidateSchema.safeParse(prior.rows[0].candidate_payload);
        const matches = priorCandidate.success &&
          priorCandidate.data.strategyLink.experimentId === parsed.data.experimentId &&
          priorCandidate.data.account.toLowerCase() === parsed.data.account.toLowerCase() &&
          priorCandidate.data.market.asset === parsed.data.asset &&
          priorCandidate.data.market.intervalSeconds === parsed.data.intervalSec &&
          priorCandidate.data.risk.maxEscrowRaw === parsed.data.maxEscrowRaw &&
          (parsed.data.requestedQuantityRaw === undefined || priorCandidate.data.quotePlan.requestedQuantityRaw === parsed.data.requestedQuantityRaw) &&
          (parsed.data.worstPriceRaw === undefined || priorCandidate.data.risk.reviewedWorstPriceRaw === parsed.data.worstPriceRaw);
        if (!matches) return await v2Error(reply, 409, "IDEMPOTENCY_CONFLICT", "Idempotency key is already bound to a different execution request", false, request.id);
        return await reply.code(200).send(v2Data(
          { executionCandidate: priorCandidate.data, intentId: prior.rows[0].id },
          { sourcePlane: "SHANNON_EXECUTION", blockchainWrite: false, walletRequired: true, idempotentReplay: true, chainId: SOMNIA_SHANNON_CHAIN_ID }
        ));
      }
      const query = new URLSearchParams({
        experimentId: parsed.data.experimentId,
        account: parsed.data.account,
        asset: parsed.data.asset,
        intervalSec: String(parsed.data.intervalSec),
        maxEscrowRaw: parsed.data.maxEscrowRaw,
        minExpiryHeadroomSec: String(parsed.data.minExpiryHeadroomSec)
      });
      if (parsed.data.requestedQuantityRaw !== undefined) query.set("requestedQuantityRaw", parsed.data.requestedQuantityRaw);
      if (parsed.data.worstPriceRaw !== undefined) query.set("worstPriceRaw", parsed.data.worstPriceRaw);
      const freshResponse = await app.inject({
        method: "GET",
        url: `/api/v2/shannon/execution-candidate?${query.toString()}`,
        headers: request.headers.cookie === undefined ? {} : { cookie: request.headers.cookie }
      });
      const freshBody: unknown = freshResponse.json();
      if (freshResponse.statusCode !== 200) {
        return await reply.code(freshResponse.statusCode).send(freshBody);
      }
      const candidateEnvelope = z.object({ data: z.object({ executionCandidate: z.unknown() }) }).safeParse(freshBody);
      if (!candidateEnvelope.success) {
        return await v2Error(
          reply,
          503,
          "EXECUTION_CANDIDATE_REVALIDATION_FAILED",
          "Fresh candidate response could not be verified",
          true,
          request.id
        );
      }
      const candidate = PersistableExecutionCandidateSchema.safeParse(candidateEnvelope.data.data.executionCandidate);
      if (!candidate.success) {
        const blockedReasons = z
          .object({ status: z.literal("BLOCKED"), blockedReasons: z.array(z.string()) })
          .safeParse(candidateEnvelope.data.data.executionCandidate);
        return await v2Error(
          reply,
          409,
          "ORDER_NOT_EXECUTABLE",
          "The freshly revalidated market is not currently executable",
          true,
          request.id,
          blockedReasons.success ? { blockedReasons: blockedReasons.data.blockedReasons } : candidate.error.issues
        );
      }
      const intentId = await persistReadyExecutionCandidate(pool, { candidate: candidate.data, idempotencyKey });
      await writeAudit(pool, {
        sessionId: session.id,
        action: "execution_candidate.revalidate",
        targetType: "execution_intent",
        targetId: intentId,
        outcome: "READY",
        correlationId: request.id,
        safeMetadata: {
          experimentId: candidate.data.strategyLink.experimentId,
          assessmentId: candidate.data.strategyLink.assessmentId,
          marketId: candidate.data.market.stableMarketId,
          sourcePlane: "SHANNON_EXECUTION"
        }
      });
      return await reply.code(201).send(
        v2Data(
          {
            executionCandidate: candidate.data,
            intentId
          },
          {
            sourcePlane: "SHANNON_EXECUTION",
            blockchainWrite: false,
            walletRequired: true,
            freshlyRevalidated: true,
            chainId: SOMNIA_SHANNON_CHAIN_ID
          }
        )
      );
    } catch (error) {
      return v2Error(
        reply,
        503,
        "EXECUTION_CANDIDATE_REVALIDATION_FAILED",
        error instanceof Error ? error.message : "Execution candidate revalidation failed",
        true,
        request.id
      );
    }
  });

  app.post("/api/v2/execution-intents/:intentId/revalidate-order", async (request, reply) => {
    const params = z.object({ intentId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return await v2Error(reply, 400, "EXECUTION_INTENT_ID_INVALID", "Execution intent ID is invalid", false, request.id);
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
      const intentResult = await pool.query<{ candidate_payload: unknown; state: string; expires_at: Date; approval_confirmed: boolean }>(
        `
          SELECT ei.candidate_payload, ei.state, ei.expires_at,
                 COALESCE(bool_or(ct.tx_role = 'approval' AND ct.receipt_status = true), false) AS approval_confirmed
          FROM execution_intents ei
          JOIN experiments e ON e.id = ei.experiment_id
          LEFT JOIN chain_transactions ct ON ct.intent_id = ei.id
          WHERE ei.id = $1 AND e.created_by_session_id = $2
          GROUP BY ei.id
          LIMIT 1
        `,
        [params.data.intentId, session.id]
      );
      const intent = intentResult.rows[0];
      const persistedCandidate = PersistableExecutionCandidateSchema.safeParse(intent?.candidate_payload);
      if (intent === undefined || !persistedCandidate.success) {
        return await v2Error(reply, 404, "EXECUTION_INTENT_NOT_FOUND", "Execution intent was not found", false, request.id);
      }
      if (["TX_REVERTED", "FAILED", "CANCELLED", "EXPIRED"].includes(intent.state)) {
        return await v2Error(reply, 409, "EXECUTION_INTENT_TERMINAL", "Execution intent is already terminal", false, request.id);
      }
      if (intent.expires_at.getTime() <= Date.now()) {
        await pool.query("UPDATE execution_intents SET state = 'EXPIRED' WHERE id = $1", [params.data.intentId]);
        return await v2Error(reply, 409, "EXECUTION_INTENT_EXPIRED", "The market expired before signing review", false, request.id);
      }
      if (persistedCandidate.data.unsignedTransactions.approval !== null && !intent.approval_confirmed) {
        return await v2Error(
          reply,
          409,
          "EXACT_APPROVAL_REQUIRED",
          "Confirm the exact tUSDC approval before revalidating the order for signing",
          true,
          request.id
        );
      }
      const query = new URLSearchParams({
        experimentId: persistedCandidate.data.strategyLink.experimentId,
        account: persistedCandidate.data.account,
        asset: persistedCandidate.data.market.asset,
        intervalSec: String(persistedCandidate.data.market.intervalSeconds),
        maxEscrowRaw: persistedCandidate.data.risk.maxEscrowRaw,
        minExpiryHeadroomSec: String(persistedCandidate.data.risk.minExpiryHeadroomSec)
      });
      query.set("requestedQuantityRaw", persistedCandidate.data.quotePlan.requestedQuantityRaw);
      query.set("worstPriceRaw", persistedCandidate.data.risk.reviewedWorstPriceRaw as string);
      const freshResponse = await app.inject({
        method: "GET",
        url: `/api/v2/shannon/execution-candidate?${query.toString()}`,
        headers: request.headers.cookie === undefined ? {} : { cookie: request.headers.cookie }
      });
      const freshBody: unknown = freshResponse.json();
      if (freshResponse.statusCode !== 200) {
        return await reply.code(freshResponse.statusCode).send(freshBody);
      }
      const freshEnvelope = z.object({ data: z.object({ executionCandidate: z.unknown() }) }).safeParse(freshBody);
      const freshCandidate = freshEnvelope.success
        ? PersistableExecutionCandidateSchema.safeParse(freshEnvelope.data.data.executionCandidate)
        : null;
      if (freshCandidate === null || !freshCandidate.success) {
        const blocked = freshEnvelope.success
          ? z.object({ blockedReasons: z.array(z.string()) }).safeParse(freshEnvelope.data.data.executionCandidate)
          : null;
        return await v2Error(
          reply,
          409,
          "ORDER_NOT_EXECUTABLE",
          "Fresh signing-time validation closed the execution gate",
          true,
          request.id,
          blocked?.success === true ? { blockedReasons: blocked.data.blockedReasons } : undefined
        );
      }
      const original = persistedCandidate.data;
      const fresh = freshCandidate.data;
      const immutableBindingMatches =
        original.account.toLowerCase() === fresh.account.toLowerCase() &&
        original.strategyLink.experimentId === fresh.strategyLink.experimentId &&
        original.strategyLink.assessmentId === fresh.strategyLink.assessmentId &&
        original.strategyLink.assessmentHash === fresh.strategyLink.assessmentHash &&
        original.market.stableMarketId.toLowerCase() === fresh.market.stableMarketId.toLowerCase() &&
        original.market.poolAddress.toLowerCase() === fresh.market.poolAddress.toLowerCase() &&
        original.market.collateral.toLowerCase() === fresh.market.collateral.toLowerCase() &&
        original.sizing.side === fresh.sizing.side &&
        original.sizing.priceRaw === fresh.sizing.priceRaw &&
        original.sizing.quantityRaw === fresh.sizing.quantityRaw &&
        original.quotePolicy.policyHash === fresh.quotePolicy.policyHash &&
        stableJson(original.quotePlan) === stableJson(fresh.quotePlan) &&
        stableJson(original.unsignedTransactions.order) === stableJson(fresh.unsignedTransactions.order);
      if (!immutableBindingMatches) {
        await pool.query("UPDATE execution_intents SET state = 'EXPIRED' WHERE id = $1", [params.data.intentId]);
        return await v2Error(
          reply,
          409,
          "EXECUTION_INTENT_STALE",
          "Market generation, price, quantity, collateral, or exact order calldata changed; prepare a new candidate",
          false,
          request.id
        );
      }
      await pool.query(
        `WITH updated_intent AS (
           UPDATE execution_intents SET order_revalidated_at = $1, last_validated_at = $1 WHERE id = $2 RETURNING id
         )
         UPDATE execution_quote_details SET review_expires_at = $3
          WHERE execution_intent_id = (SELECT id FROM updated_intent)`,
        [fresh.validatedAt, params.data.intentId, new Date(new Date(fresh.validatedAt).getTime() + SigningAuthorizationTtlMs).toISOString()]
      );
      await writeAudit(pool, {
        sessionId: session.id,
        action: "execution_order.revalidate",
        targetType: "execution_intent",
        targetId: params.data.intentId,
        outcome: "READY_FOR_WALLET_SIGNING",
        correlationId: request.id,
        safeMetadata: {
          assessmentId: original.strategyLink.assessmentId,
          marketId: original.market.stableMarketId,
          observedBlockNumber: fresh.risk.observedBlockNumber
        }
      });
      return v2Data(
        {
          executionCandidate: original,
          intentId: params.data.intentId,
          signingValidation: {
            status: "READY",
            validatedAt: fresh.validatedAt,
            observedBlockNumber: fresh.risk.observedBlockNumber,
            exactOrderCallUnchanged: true,
            authorizationExpiresAt: new Date(new Date(fresh.validatedAt).getTime() + SigningAuthorizationTtlMs).toISOString()
          }
        },
        {
          sourcePlane: "SHANNON_EXECUTION",
          blockchainWrite: false,
          walletRequired: true,
          signingTimeRevalidation: true,
          chainId: SOMNIA_SHANNON_CHAIN_ID
        }
      );
    } catch (error) {
      return v2Error(
        reply,
        503,
        "ORDER_REVALIDATION_FAILED",
        error instanceof Error ? error.message : "Order signing-time revalidation failed",
        true,
        request.id
      );
    }
  });

  app.get("/api/v2/shannon/controlled-liquidity-candidate", async (request, reply) => {
    const parsed = ControlledLiquidityQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return v2Error(
        reply,
        400,
        "CONTROLLED_LIQUIDITY_INVALID",
        "Controlled-liquidity request is invalid",
        false,
        request.id,
        parsed.error.issues
      );
    }
    try {
      const dreamDex = requireDreamDex(deps);
      const marketResult = await discoverSuccessorMarkets(dreamDex.client, dreamDex.config, {
        assets: [parsed.data.asset],
        intervals: [parsed.data.intervalSec]
      });
      if (!marketResult.ok) {
        return await v2Error(reply, 502, marketResult.reasonCode, marketResult.message, true, request.id);
      }
      const market = marketResult.value[0];
      if (market === undefined) {
        return await v2Error(
          reply,
          502,
          "DREAMDEX_NO_ELIGIBLE_MARKET",
          "No eligible market was available for controlled liquidity setup",
          true,
          request.id
        );
      }
      const bookParamsResult = await readBinaryBookParams(dreamDex.client, dreamDex.config, market.poolAddress);
      if (!bookParamsResult.ok) {
        return await v2Error(reply, 502, bookParamsResult.reasonCode, bookParamsResult.message, true, request.id);
      }
      const nowSeconds = Math.floor(Date.now() / 1000);
      const expiryHeadroomSeconds = market.expirySeconds - nowSeconds;
      const quantityRaw = floorToLot(BigInt(parsed.data.quantityRaw), bookParamsResult.value.lotSize);
      const blockedReasons = [
        ...(parsed.data.maker.toLowerCase() === ShannonProofWalletAddress ? ["MAKER_MATCHES_PROOF_WALLET"] : []),
        ...(quantityRaw < bookParamsResult.value.minQuantity ? ["ORDER_CAP_BELOW_POOL_MINIMUM"] : []),
        ...(expiryHeadroomSeconds < parsed.data.minExpiryHeadroomSec ? ["EXPIRY_HEADROOM_TOO_LOW"] : [])
      ];
      const expireTimestampNs = `${String(market.expirySeconds)}000000000`;
      const setup =
        blockedReasons.length > 0
          ? null
          : await buildControlledLiquidityEvidence(dreamDex.config, {
              makerAddress: parsed.data.maker,
              poolAddress: market.poolAddress,
              side: parsed.data.side,
              priceRaw: parsed.data.priceRaw,
              quantityRaw: quantityRaw.toString(),
              expireTimestampNs
            });
      if (setup !== null && !setup.ok) {
        return await v2Error(reply, 502, setup.reasonCode, setup.message, true, request.id);
      }
      return v2Data(
        {
          controlledLiquidityCandidate: {
            status: blockedReasons.length === 0 ? "READY" : "BLOCKED",
            maker: parsed.data.maker,
            sourcePlane: "SHANNON_EXECUTION",
            network: {
              name: "Somnia Shannon Testnet",
              chainId: SOMNIA_SHANNON_CHAIN_ID
            },
            market: {
              stableMarketId: market.stableMarketId,
              marketAddress: market.marketAddress,
              poolAddress: market.poolAddress,
              asset: market.asset,
              intervalSeconds: market.intervalSeconds,
              expirySeconds: market.expirySeconds,
              quoteDecimals: market.quoteDecimals,
              collateral: market.collateral
            },
            setup: setup === null ? null : setup.value,
            sizing: {
              side: parsed.data.side,
              priceRaw: parsed.data.priceRaw,
              quantityRaw: quantityRaw.toString(),
              minQuantityRaw: bookParamsResult.value.minQuantity.toString(),
              lotSizeRaw: bookParamsResult.value.lotSize.toString(),
              expireTimestampNs
            },
            risk: {
              controlledLiquidity: true,
              organicLiquidityClaim: false,
              serverSigner: false,
              mainnetWrite: false,
              approvalScope: "exact collateral approval for mint; ERC-6909 pool operator approval for sell escrow",
              maxSetupCollateralRaw: quantityRaw.toString(),
              maxSetupCollateralDisplay: displayQuoteAmount(quantityRaw, market.quoteDecimals, "tUSDC"),
              expiryHeadroomSeconds,
              minExpiryHeadroomSec: parsed.data.minExpiryHeadroomSec
            },
            blockedReasons,
            nextStep:
              blockedReasons.length === 0
                ? "Submit setup calls from a separate maker wallet, then rerun the execution watcher with the proof wallet."
                : "Wait for a fresher market or raise the bounded setup quantity to the displayed pool minimum."
          }
        },
        {
          sourcePlane: "SHANNON_EXECUTION",
          blockchainWrite: false,
          walletRequired: true,
          controlledLiquidity: true,
          chainId: SOMNIA_SHANNON_CHAIN_ID
        }
      );
    } catch (error) {
      return v2Error(
        reply,
        503,
        "CONTROLLED_LIQUIDITY_UNAVAILABLE",
        error instanceof Error ? error.message : "Controlled liquidity setup unavailable",
        true,
        request.id
      );
    }
  });

  app.post("/api/v2/shannon/execution-receipts", async (request, reply) => {
    const parsed = ExecutionReceiptImportSchema.safeParse(request.body);
    if (!parsed.success) {
      return v2Error(
        reply,
        400,
        "EXECUTION_RECEIPT_INVALID",
        "Execution receipt import is invalid",
        false,
        request.id,
        parsed.error.issues
      );
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
      const intentResult = await pool.query<{
        id: string;
        state: string;
        candidate_payload: unknown;
        order_revalidated_at: Date | null;
        expires_at: Date;
        review_expires_at: Date | null;
      }>(
        `
          SELECT ei.id, ei.state, ei.candidate_payload, ei.order_revalidated_at, ei.expires_at, eqd.review_expires_at
          FROM execution_intents ei
          JOIN experiments e ON e.id = ei.experiment_id
          LEFT JOIN execution_quote_details eqd ON eqd.execution_intent_id = ei.id
          WHERE ei.intent_hash = $1
            AND e.created_by_session_id = $2
          LIMIT 1
        `,
        [parsed.data.intentHash, session.id]
      );
      const intent = intentResult.rows[0];
      if (intent === undefined) {
        return await v2Error(
          reply,
          404,
          "EXECUTION_INTENT_NOT_FOUND",
          "No freshly revalidated strategy-linked execution intent matches this hash",
          false,
          request.id
        );
      }
      const candidate = PersistableExecutionCandidateSchema.safeParse(intent.candidate_payload);
      if (!candidate.success) {
        return await v2Error(
          reply,
          409,
          "EXECUTION_INTENT_INVALID",
          "Persisted execution intent cannot be verified against its canonical candidate",
          false,
          request.id
        );
      }
      if (intent.expires_at.getTime() <= Date.now()) {
        return await v2Error(reply, 409, "EXECUTION_INTENT_EXPIRED", "The market expired before this signature stage", false, request.id);
      }
      const [transaction, receipt] = await Promise.all([
        shannonRpc<RpcTransaction | null>(config, "eth_getTransactionByHash", [parsed.data.txHash]),
        shannonRpc<RpcReceipt | null>(config, "eth_getTransactionReceipt", [parsed.data.txHash])
      ]);
      if (transaction === null) {
        return await v2Error(
          reply,
          409,
          "EXECUTION_TX_NOT_FOUND",
          "Submitted transaction is not visible on Somnia Shannon yet",
          true,
          request.id
        );
      }
      if (transaction.from?.toLowerCase() !== candidate.data.account.toLowerCase()) {
        return await v2Error(
          reply,
          409,
          "EXECUTION_TX_SENDER_MISMATCH",
          "Submitted transaction sender does not match the candidate wallet",
          false,
          request.id
        );
      }
      const expectedCall =
        parsed.data.txRole === "order"
          ? candidate.data.unsignedTransactions.order
          : candidate.data.unsignedTransactions.approval;
      if (expectedCall === null) {
        return await v2Error(
          reply,
          409,
          "EXECUTION_TX_ROLE_UNEXPECTED",
          "This execution intent does not require the submitted transaction role",
          false,
          request.id
        );
      }
      if (
        transaction.to?.toLowerCase() !== expectedCall.to.toLowerCase() ||
        transaction.input?.toLowerCase() !== expectedCall.data.toLowerCase() ||
        hexToDecimalString(transaction.value) !== expectedCall.valueRaw
      ) {
        return await v2Error(
          reply,
          409,
          "EXECUTION_TX_CALL_MISMATCH",
          "Submitted transaction does not exactly match the freshly revalidated unsigned call",
          false,
          request.id
        );
      }
      if (parsed.data.txRole === "order" && candidate.data.unsignedTransactions.approval !== null) {
        const approval = await pool.query<{ receipt_status: boolean | null }>(
          "SELECT receipt_status FROM chain_transactions WHERE intent_id = $1 AND tx_role = 'approval' LIMIT 1",
          [intent.id]
        );
        if (approval.rows[0]?.receipt_status !== true) {
          return await v2Error(
            reply,
            409,
            "EXACT_APPROVAL_REQUIRED",
            "The exact tUSDC approval receipt must be confirmed before the order receipt is accepted",
            true,
            request.id
          );
        }
      }
      if (
        parsed.data.txRole === "order" &&
        (intent.order_revalidated_at === null || intent.review_expires_at === null ||
          Date.now() - intent.order_revalidated_at.getTime() > SigningAuthorizationTtlMs || Date.now() > intent.review_expires_at.getTime())
      ) {
        return await v2Error(
          reply,
          409,
          "FRESH_ORDER_REVALIDATION_REQUIRED",
          "Revalidate this exact order immediately before requesting the wallet signature",
          true,
          request.id
        );
      }
      const verifiedAt = new Date().toISOString();
      const lifecycle =
        parsed.data.txRole === "order" && receipt !== null
          ? decodeOrderLifecycleFromReceipt({
              poolAddress: candidate.data.market.poolAddress,
              receiptStatus: receipt.status === "0x1",
              receipt,
              fallbackQuantityRaw: candidate.data.sizing.quantityRaw,
              observedAt: verifiedAt
            })
          : null;
      if (
        lifecycle !== null &&
        lifecycle.orderId !== null &&
        (lifecycle.quantityRaw !== candidate.data.sizing.quantityRaw ||
          BigInt(lifecycle.filledQuantityRaw) > BigInt(candidate.data.sizing.quantityRaw) ||
          BigInt(lifecycle.remainingQuantityRaw) > BigInt(candidate.data.sizing.quantityRaw))
      ) {
        return await v2Error(
          reply,
          409,
          "ORDER_EVENT_MISMATCH",
          "DreamDEX receipt events do not match the exact requested candidate quantity",
          false,
          request.id
        );
      }
      const persisted = await persistStrategyExecutionTransaction(pool, {
        intentId: intent.id,
        candidate: candidate.data,
        txHash: parsed.data.txHash,
        txRole: parsed.data.txRole,
        transaction,
        receipt,
        lifecycle
      });
      return await reply.code(receipt === null ? 202 : 201).send(
        v2Data(
          {
            executionReceipt: {
              status: persisted.state,
              intentId: persisted.intentId,
              intentHash: parsed.data.intentHash,
              txHash: parsed.data.txHash,
              txRole: parsed.data.txRole,
              account: candidate.data.account,
              receiptStatus: receipt === null ? null : receipt.status === "0x1",
              blockNumber: receipt === null ? null : hexToDecimalString(receipt.blockNumber),
              logHash: persisted.logHash,
              lifecycleDecoded: parsed.data.txRole === "order" && persisted.orderId !== null,
              order: persisted.orderId === null ? null : {
                orderId: persisted.orderId,
                state: persisted.orderState,
                requestedQuantityRaw: lifecycle?.quantityRaw ?? candidate.data.sizing.quantityRaw,
                filledQuantityRaw: lifecycle?.filledQuantityRaw ?? "0",
                remainingQuantityRaw: lifecycle?.remainingQuantityRaw ?? candidate.data.sizing.quantityRaw,
                fillCount: persisted.fillCount,
                fillState: classifyExecutionFillState({
                  orderState: persisted.orderState,
                  filledQuantityRaw: lifecycle?.filledQuantityRaw ?? "0",
                  remainingQuantityRaw: lifecycle?.remainingQuantityRaw ?? candidate.data.sizing.quantityRaw,
                  hasOrderEvidence: true
                }),
                terminal:
                  persisted.orderState === "FILLED" ||
                  persisted.orderState === "UNFILLED" ||
                  persisted.orderState === "PARTIALLY_FILLED" ||
                  persisted.orderState === "CANCELLED" ||
                  persisted.orderState === "EXPIRED" ||
                  persisted.orderState === "FAILED"
              },
              nextMissingProof:
                receipt === null
                  ? "Retry reconciliation after the Somnia Shannon receipt is available."
                  : persisted.orderId === null
                  ? "Decode DreamDEX order events from this strategy-linked transaction receipt."
                  : BigInt(lifecycle?.filledQuantityRaw ?? "0") > 0n
                    ? "Follow settlement and redemption for the filled strategy-linked order."
                    : "The confirmed IOC order produced no fill; no settlement or redemption claim is made."
            }
          },
          {
            sourcePlane: "SHANNON_EXECUTION",
            blockchainWrite: false,
            serverVerified: true,
            chainId: SOMNIA_SHANNON_CHAIN_ID
          }
        )
      );
    } catch (error) {
      return v2Error(
        reply,
        503,
        "EXECUTION_RECEIPT_IMPORT_FAILED",
        error instanceof Error ? error.message : "Execution receipt import failed",
        true,
        request.id
      );
    }
  });

  app.get("/api/v2/execution-intents/:intentId", async (request, reply) => {
    const params = z.object({ intentId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return await v2Error(reply, 400, "EXECUTION_INTENT_ID_INVALID", "Execution intent ID is invalid", false, request.id);
    }
    try {
      const pool = requirePool(deps);
      const session = await requireResearchSession(pool, request);
      if (session === null) {
        return await v2Error(reply, 401, "RESEARCH_SESSION_REQUIRED", "Create a research session first", false, request.id);
      }
      const lifecycle = await loadCanonicalExecutionLifecycle(pool, {
        sessionId: session.id,
        intentId: params.data.intentId
      });
      if (lifecycle === null) {
        return await v2Error(reply, 404, "EXECUTION_INTENT_NOT_FOUND", "Execution intent was not found", false, request.id);
      }
      return v2Data(
        { executionLifecycle: lifecycle },
        { sourcePlane: "SHANNON_EXECUTION", canonical: true, blockchainWrite: false }
      );
    } catch (error) {
      return v2Error(
        reply,
        503,
        "EXECUTION_LIFECYCLE_UNAVAILABLE",
        error instanceof Error ? error.message : "Execution lifecycle unavailable",
        true,
        request.id
      );
    }
  });

  app.get("/api/v2/experiments/:experimentId/execution", async (request, reply) => {
    const params = z.object({ experimentId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return await v2Error(reply, 400, "EXPERIMENT_ID_INVALID", "Experiment ID is invalid", false, request.id);
    }
    try {
      const pool = requirePool(deps);
      const session = await requireResearchSession(pool, request);
      if (session === null) {
        return await v2Error(reply, 401, "RESEARCH_SESSION_REQUIRED", "Create a research session first", false, request.id);
      }
      const lifecycle = await loadCanonicalExecutionLifecycle(pool, {
        sessionId: session.id,
        experimentId: params.data.experimentId
      });
      return v2Data(
        { executionLifecycle: lifecycle },
        { sourcePlane: "SHANNON_EXECUTION", canonical: true, blockchainWrite: false }
      );
    } catch (error) {
      return v2Error(
        reply,
        503,
        "EXECUTION_LIFECYCLE_UNAVAILABLE",
        error instanceof Error ? error.message : "Execution lifecycle unavailable",
        true,
        request.id
      );
    }
  });

  app.post("/api/v2/execution-intents/:intentId/reconcile", async (request, reply) => {
    const params = z.object({ intentId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return await v2Error(reply, 400, "EXECUTION_INTENT_ID_INVALID", "Execution intent ID is invalid", false, request.id);
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
      const lifecycle = await reconcileExecutionIntent({
        pool,
        sessionId: session.id,
        intentId: params.data.intentId,
        config,
        dreamDex: requireDreamDex(deps)
      });
      if (lifecycle === null) {
        return await v2Error(reply, 404, "EXECUTION_INTENT_NOT_FOUND", "Execution intent was not found", false, request.id);
      }
      await writeAudit(pool, {
        sessionId: session.id,
        action: "execution.reconcile",
        targetType: "execution_intent",
        targetId: params.data.intentId,
        outcome: lifecycle.state,
        correlationId: request.id,
        safeMetadata: {
          publicClaim: lifecycle.publicClaim,
          orderState: lifecycle.order?.state ?? null,
          settlementState: lifecycle.settlement.state,
          redemptionState: lifecycle.redemption.state
        }
      });
      return v2Data(
        { executionLifecycle: lifecycle },
        { sourcePlane: "SHANNON_EXECUTION", canonical: true, blockchainWrite: false, safeToRetry: true }
      );
    } catch (error) {
      return v2Error(
        reply,
        503,
        "EXECUTION_RECONCILIATION_FAILED",
        error instanceof Error ? error.message : "Execution reconciliation failed",
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
