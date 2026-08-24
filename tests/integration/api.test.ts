import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "@edgelab/server";
import { createPool, runMigrations } from "@edgelab/db";
import type { RuntimeConfig } from "@edgelab/config";
import { LoginChallengeSchema, type SignatureVerifier } from "@edgelab/auth";
import { z } from "zod";

const connectionString =
  process.env.TEST_DATABASE_URL ?? "postgres://edgelab:edgelab@localhost:55432/edgelab";

const pool = createPool({ connectionString, max: 4, statementTimeoutMs: 5000 });
const account = `0x${"7".repeat(40)}`;

const config: RuntimeConfig = {
  NODE_ENV: "test",
  PORT: 3000,
  DATABASE_URL: connectionString,
  PUBLIC_APP_URL: "http://localhost:3000",
  SESSION_SECRET: "0123456789abcdef0123456789abcdef",
  SOMNIA_CHAIN_ID: 50312,
  SOMNIA_RPC_URL: "https://api.infra.testnet.somnia.network/",
  SOMNIA_WS_RPC_URL: "wss://api.infra.testnet.somnia.network/ws",
  DREAMDEX_INDEXER_URL: "https://dev.smk.somnia.host/v1/graphql",
  MARKETS_SDK_VERSION: "0.28.1",
  WORKER_ENABLED: false,
  LOG_LEVEL: "error",
  BUILD_COMMIT: "api-test"
};

const verifier: SignatureVerifier = {
  verify(input) {
    expect(input.address).toBe(account);
    expect(input.message).toContain("Sign in to EdgeLab");
    return Promise.resolve(input.signature === "0xsigned");
  }
};
const ChallengeResponseSchema = z.object({
  ok: z.literal(true),
  challenge: LoginChallengeSchema
});

async function resetPublicSchema(): Promise<void> {
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
}

describe("API-001 server contracts", () => {
  beforeAll(async () => {
    await resetPublicSchema();
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("exposes health, readiness, and product invariants", async () => {
    const app = buildApp(config, { pool });
    const health = await app.inject({ method: "GET", url: "/healthz" });
    const ready = await app.inject({ method: "GET", url: "/readyz" });
    const invariants = await app.inject({ method: "GET", url: "/api/v1/invariants" });
    await app.close();

    expect(health.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ ok: true, database: "ok", chainId: 50312 });
    expect(invariants.json()).toMatchObject({
      boundaries: {
        serviceSignsTransactions: false,
        fabricatedFills: false,
        pnlWithoutFillAndSettlement: false
      }
    });
  });

  it("creates wallet challenges and rejects nonce replay", async () => {
    const app = buildApp(config, { consumedNonces: new Set(), signatureVerifier: verifier });
    const challengeResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/challenge",
      payload: { purpose: "login", account }
    });
    const challengeBody = ChallengeResponseSchema.parse(challengeResponse.json());
    const firstVerify = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify",
      payload: { challenge: challengeBody.challenge, signature: "0xsigned", account }
    });
    const replayVerify = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify",
      payload: { challenge: challengeBody.challenge, signature: "0xsigned", account }
    });
    await app.close();

    expect(challengeResponse.statusCode).toBe(200);
    expect(challengeBody.challenge.statement).toBe("Sign in to EdgeLab. This does not authorize a transaction.");
    expect(firstVerify.statusCode).toBe(200);
    expect(replayVerify.statusCode).toBe(401);
    expect(replayVerify.json()).toMatchObject({ reasonCode: "NONCE_REPLAYED" });
  });

  it("requires idempotency keys for mutating workflow endpoints", async () => {
    const app = buildApp(config);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/settlements/reconcile"
    });
    await app.close();

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      reasonCode: "SETTLEMENT_REQUEST_REJECTED"
    });
  });

  it("summarizes evidence counts without exposing raw secrets", async () => {
    const app = buildApp(config, { pool });
    const response = await app.inject({ method: "GET", url: "/api/v1/evidence/summary" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      counts: {
        experiments: 0,
        episodes: 0,
        snapshots: 0,
        decisions: 0
      },
      chain: {
        submittedOrderCount: 0,
        fillCount: 0,
        terminalOrderCount: 0,
        openOrderCount: 0,
        latestTerminalState: null,
        tradeabilityStatus: "NOT_EVALUATED"
      }
    });
  });
});
