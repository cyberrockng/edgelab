import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify from "fastify";
import type pg from "pg";
import {
  createApprovalChallenge,
  createLoginChallenge,
  verifyChallenge,
  type AuthChallenge,
  type SignatureVerifier
} from "@edgelab/auth";
import type { RuntimeConfig } from "@edgelab/config";
import { DREAMDEX_MARKETS_SDK_VERSION, SOMNIA_SHANNON_CHAIN_ID } from "@edgelab/domain";
import { discoverSuccessorMarkets, type DreamDexReadConfig, type DreamDexSdkClient } from "@edgelab/dreamdex";
import { runMetricAssessment } from "@edgelab/evaluate";
import { observeExperiment } from "@edgelab/observe";
import { referencePolicies, type PolicyAdapter } from "@edgelab/policy-runtime";
import { reconcileSettlements } from "@edgelab/settle";
import { z } from "zod";

export interface AppDependencies {
  readonly pool?: pg.Pool;
  readonly dreamDexClient?: DreamDexSdkClient;
  readonly dreamDexConfig?: DreamDexReadConfig;
  readonly policyAdapters?: readonly PolicyAdapter[];
  readonly consumedNonces?: Set<string>;
  readonly signatureVerifier?: SignatureVerifier;
}

const AddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const IntentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
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
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Idempotency-Key header is required");
  }
  return value;
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

export function buildApp(config: RuntimeConfig, deps: AppDependencies = {}) {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"]
    }
  });
  const consumedNonces = deps.consumedNonces ?? new Set<string>();
  const policyAdapters = deps.policyAdapters ?? referencePolicies;

  void app.register(helmet);
  void app.register(cookie, { secret: config.SESSION_SECRET });
  void app.register(cors, {
    origin: config.PUBLIC_APP_URL,
    credentials: true
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
        }
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
