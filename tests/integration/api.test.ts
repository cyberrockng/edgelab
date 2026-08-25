import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "@edgelab/server";
import { createPool, runMigrations } from "@edgelab/db";
import type { RuntimeConfig } from "@edgelab/config";
import { LoginChallengeSchema, type SignatureVerifier } from "@edgelab/auth";
import type { BinaryMarket } from "@somnia-chain/markets-sdk";
import type { DreamDexSdkClient, HistoricalDreamDexSdkClient, HistoricalIndexerFetch } from "@edgelab/dreamdex";
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
  SOMNIA_MAINNET_CHAIN_ID: 5031,
  SOMNIA_MAINNET_RPC_URL: "https://api.infra.mainnet.somnia.network",
  DREAMDEX_MAINNET_INDEXER_URL: "https://prd.smk.somnia.host/v1/graphql",
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
const V2CapabilitiesSchema = z.object({
  data: z.object({
    planes: z.array(
      z.object({
        id: z.string(),
        chainId: z.number(),
        writePolicy: z.string()
      })
    ),
    dreamDex: z.object({
      historicalBookReconstruction: z.string()
    })
  })
});
const V2PoliciesSchema = z.object({
  data: z.object({
    policies: z.array(z.object({ policyId: z.string(), version: z.string() }))
  })
});
const V2HistoricalPageSchema = z.object({
  data: z.object({
    markets: z.array(z.object({ stableMarketId: z.string() }))
  }),
  meta: z.object({
    page: z.object({ limit: z.number(), offset: z.number() }),
    hasMore: z.boolean(),
    source: z.object({ plane: z.string() })
  })
});
const V2LiveMarketsSchema = z.object({
  data: z.object({
    markets: z.array(
      z.object({
        source: z.object({ chainId: z.number() })
      })
    )
  }),
  meta: z.object({ plane: z.string() })
});
const V2SessionSchema = z.object({
  data: z.object({
    session: z.object({
      id: z.string().uuid(),
      expiresAt: z.string(),
      csrfVersion: z.number()
    }),
    csrfToken: z.string().min(32)
  })
});
const V2ExperimentSchema = z.object({
  data: z.object({
    experiment: z.object({
      experimentId: z.string().uuid(),
      name: z.string(),
      configuration: z.object({
        mode: z.string(),
        assets: z.array(z.string()),
        intervals: z.array(z.number()),
        config: z.object({
          sourcePlane: z.string(),
          historicalBookReconstruction: z.string(),
          pnlStatus: z.string()
        })
      }),
      policies: z.array(z.object({ policyId: z.string(), version: z.string(), role: z.string() }))
    }),
    idempotentReplay: z.boolean().optional()
  })
});
const V2ReplaySchema = z.object({
  data: z.object({
    replay: z
      .object({
        id: z.string().uuid(),
        status: z.string(),
        selectedCount: z.number(),
        processedCount: z.number(),
        scoredCount: z.number(),
        excludedCount: z.number(),
        outputHash: z.string().nullable(),
        decisions: z
          .array(
            z.object({
              marketId: z.string(),
              action: z.string(),
              forecastPUp: z.number().nullable(),
              outcomeResult: z.string().nullable(),
              frameHash: z.string()
            })
          )
          .optional()
      })
      .nullable(),
    idempotentReplay: z.boolean().optional()
  })
});
const V2AssessmentSchema = z.object({
  data: z.object({
    assessment: z.object({
      verdict: z.enum(["PROMOTE", "HOLD", "REJECT", "INSUFFICIENT_EVIDENCE"]),
      reasonCodes: z.array(z.string()),
      sampleSize: z.number(),
      exclusionCount: z.number(),
      pnlStatus: z.enum(["NOT_AVAILABLE", "AVAILABLE"]),
      metricRunId: z.string().uuid().optional(),
      assessmentId: z.string().uuid().optional()
    })
  })
});
const V2LatestAssessmentSchema = z.object({
  data: z.object({
    assessment: V2AssessmentSchema.shape.data.shape.assessment.nullable()
  })
});
const apiMarketId = `0x${"9".repeat(61)}abc`;

const binaryMarket: BinaryMarket = {
  id: "0xapi-market",
  marketType: "BINARY",
  poolAddress: "0x0000000000000000000000000000000000000a99",
  lastPrice: null,
  lastTradeAt: null,
  cumulativeBaseVolume: "0",
  cumulativeQuoteVolume: "0",
  tradeCount: "4",
  baseDecimals: 6,
  quoteDecimals: 6,
  createdAtTimestamp: "1787570000",
  marketId: apiMarketId,
  marketAddress: "0x0000000000000000000000000000000000000b99",
  yesTokenId: "1",
  noTokenId: "2",
  collateral: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E",
  asset: "BTC",
  question: "Will BTC close up?",
  status: "Finalized",
  oracleQuestion: "BTC up?",
  oracleQuestionId: "1",
  strike: "100000",
  tradingStart: "1787566400",
  expiry: "1787570000",
  winningOutcome: 0,
  payoutNumerators: null,
  payoutDenominator: null,
  resolvedAtBlock: null,
  resolvedAtTimestamp: null,
  createdByTx: null,
  creator: null,
  voided: false,
  backing: "0",
  nonce: "58",
  finalized: true,
  netBacking: null,
  context: "0x",
  intervalSec: "3600",
  interval: "1h",
  operatorId: 1,
  venueId: "0x4d41494e"
};

function historicalClient(): HistoricalDreamDexSdkClient {
  return {
    countBinaryMarkets() {
      return Promise.resolve(4);
    },
    listPastBinaryMarkets(opts) {
      return Promise.resolve([
        binaryMarket,
        { ...binaryMarket, marketId: `0x${"8".repeat(61)}abc` }
      ].slice(0, opts?.limit ?? 25));
    },
    getBinaryMarket(id) {
      return Promise.resolve(id.toLowerCase() === apiMarketId.toLowerCase() ? binaryMarket : null);
    },
    getMarketResolution() {
      return Promise.resolve({
        events: [{ status: "Resolved" }],
        reference: null,
        openingAnswer: { numericValue: "100" },
        closingAnswer: { numericValue: "101" }
      });
    },
    getMarketStatusHistory() {
      return Promise.resolve([
        {
          oldStatus: "Trading",
          newStatus: "Resolved",
          blockNumber: "100",
          timestamp: "1787570001",
          txHash: "0xresolved"
        }
      ]);
    },
    getOpeningPrices(ids) {
      return Promise.resolve(Object.fromEntries(ids.map((id) => [id, "100000"])));
    },
    getCandles() {
      return Promise.resolve([
        {
          bucketStart: "1787566400",
          openPrice: "100",
          high: "110",
          low: "90",
          closePrice: "105",
          baseVolume: "25",
          quoteVolume: "2500",
          tradeCount: 2
        }
      ]);
    },
    getFills() {
      return Promise.resolve([]);
    }
  };
}

function liveClient(): DreamDexSdkClient {
  return {
    listLiveBinaryMarkets() {
      return Promise.resolve([{ ...binaryMarket, status: "Trading", finalized: false, winningOutcome: null }]);
    },
    getBinaryBookParams() {
      return Promise.resolve({ tickSize: 1000n, lotSize: 1000n, minQuantity: 1000n });
    },
    getLiveBinaryOrderBookByMarket() {
      return { yesBids: [], yesAsks: [], noBids: [], noAsks: [] };
    },
    getBinaryMarket() {
      return Promise.resolve(binaryMarket);
    }
  };
}

const historicalIndexerFetch: HistoricalIndexerFetch = () =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        data: {
          Order: [
            {
              id: "order-1",
              orderId: "101",
              market_id: apiMarketId,
              side: "BUY_YES",
              isBid: true,
              price: "10000",
              fullQuantity: "1000000",
              filledQuantity: "250000",
              quantityRemaining: "750000",
              status: "Cancelled",
              rested: true,
              expireTimestampNs: "1787570100000000000",
              placedAtBlock: "44",
              placedAtTimestamp: "1787566500",
              lastUpdatedAtBlock: "55",
              lastUpdatedAtTimestamp: "1787566600",
              placedTxHash: "0xplaced"
            }
          ],
          Fill: [
            {
              id: "fill-1",
              market_id: apiMarketId,
              pool: binaryMarket.poolAddress,
              fillPrice: "10100",
              quantity: "500000",
              quoteQuantity: "5050",
              kind: "DIRECT_YES",
              makerOrderId: "101",
              makerRemainingQuantity: "500000",
              makerSide: "SELL_YES",
              takerOrderId: "201",
              takerRemainingQuantity: "0",
              takerSide: "BUY_YES",
              takerIsBid: true,
              timestamp: "1787569500",
              blockNumber: "90",
              logIndex: 3,
              txHash: "0xfill"
            }
          ]
        }
      })
  });

function v2Deps() {
  return {
    dreamDexClient: liveClient(),
    dreamDexConfig: {
      rpcUrl: config.SOMNIA_RPC_URL,
      wsRpcUrl: config.SOMNIA_WS_RPC_URL,
      indexerUrl: config.DREAMDEX_INDEXER_URL,
      chainId: config.SOMNIA_CHAIN_ID,
      sdkVersion: config.MARKETS_SDK_VERSION
    },
    historicalDreamDexClient: historicalClient(),
    historicalDreamDexConfig: {
      rpcUrl: config.SOMNIA_MAINNET_RPC_URL,
      indexerUrl: config.DREAMDEX_MAINNET_INDEXER_URL,
      chainId: config.SOMNIA_MAINNET_CHAIN_ID,
      sdkVersion: config.MARKETS_SDK_VERSION
    },
    historicalIndexerFetch
  };
}

function cookieHeader(response: { headers: Record<string, string | string[] | undefined> }): string {
  const raw = response.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

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

  it("exposes v2 capabilities and policy metadata without signer capability", async () => {
    const app = buildApp(config, v2Deps());
    const capabilities = await app.inject({ method: "GET", url: "/api/v2/capabilities" });
    const policies = await app.inject({ method: "GET", url: "/api/v2/policies" });
    await app.close();

    expect(capabilities.statusCode).toBe(200);
    const capabilitiesBody = V2CapabilitiesSchema.parse(capabilities.json());
    expect(capabilitiesBody.data.planes).toContainEqual(
      expect.objectContaining({
        id: "MAINNET_HISTORICAL",
        chainId: 5031,
        writePolicy: "read-only-no-mainnet-signer"
      })
    );
    expect(capabilitiesBody.data.dreamDex.historicalBookReconstruction).toBe("SOURCE_INCOMPLETE");
    expect(policies.statusCode).toBe(200);
    const policiesBody = V2PoliciesSchema.parse(policies.json());
    expect(policiesBody.data.policies).toContainEqual(
      expect.objectContaining({ policyId: "reference-neutral", version: "1.0.0" })
    );
    expect(policiesBody.data.policies).toContainEqual(
      expect.objectContaining({ policyId: "historical-last-trade", version: "1.0.0" })
    );
  });

  it("serves bounded historical market pages and count envelopes", async () => {
    const app = buildApp(config, v2Deps());
    const count = await app.inject({ method: "GET", url: "/api/v2/mainnet/history/markets/count?asset=BTC" });
    const page = await app.inject({
      method: "GET",
      url: "/api/v2/mainnet/history/markets?asset=BTC&status=Finalized&limit=1&offset=0"
    });
    const invalid = await app.inject({
      method: "GET",
      url: "/api/v2/mainnet/history/markets?limit=101"
    });
    await app.close();

    expect(count.statusCode).toBe(200);
    expect(count.json()).toMatchObject({ data: { count: 4, countRelation: "EXACT" } });
    expect(page.statusCode).toBe(200);
    const pageBody = V2HistoricalPageSchema.parse(page.json());
    expect(pageBody.data.markets[0]?.stableMarketId).toBe(apiMarketId.toLowerCase());
    expect(pageBody.meta.page).toEqual({ limit: 1, offset: 0 });
    expect(pageBody.meta.hasMore).toBe(true);
    expect(pageBody.meta.source.plane).toBe("MAINNET_HISTORICAL");
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      error: { code: "DREAMDEX_HISTORICAL_BOUNDS_INVALID", retryable: false }
    });
  });

  it("serves historical market detail, resolution, lifecycle, candles, orders, and fills", async () => {
    const app = buildApp(config, v2Deps());
    const detail = await app.inject({ method: "GET", url: `/api/v2/mainnet/history/markets/${apiMarketId}` });
    const resolution = await app.inject({
      method: "GET",
      url: `/api/v2/mainnet/history/markets/${apiMarketId}/resolution`
    });
    const lifecycle = await app.inject({
      method: "GET",
      url: `/api/v2/mainnet/history/markets/${apiMarketId}/status-history`
    });
    const candles = await app.inject({
      method: "GET",
      url: `/api/v2/mainnet/history/markets/${apiMarketId}/candles?intervalSeconds=3600&limit=1`
    });
    const orders = await app.inject({
      method: "GET",
      url: `/api/v2/mainnet/history/markets/${apiMarketId}/orders?limit=1`
    });
    const fills = await app.inject({
      method: "GET",
      url: `/api/v2/mainnet/history/markets/${apiMarketId}/fills?limit=1`
    });
    await app.close();

    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ data: { market: { stableMarketId: apiMarketId.toLowerCase() } } });
    expect(resolution.statusCode).toBe(200);
    expect(resolution.json()).toMatchObject({ meta: { usage: "display-only-not-policy-input" } });
    expect(lifecycle.statusCode).toBe(200);
    expect(lifecycle.json()).toMatchObject({ data: { statusHistory: [expect.objectContaining({ newStatus: "Resolved" })] } });
    expect(candles.statusCode).toBe(200);
    expect(candles.json()).toMatchObject({ data: { candles: [expect.objectContaining({ closePriceRaw: "105" })] } });
    expect(orders.statusCode).toBe(200);
    expect(orders.json()).toMatchObject({ data: { orders: [expect.objectContaining({ remainingQuantityRaw: "750000" })] } });
    expect(fills.statusCode).toBe(200);
    expect(fills.json()).toMatchObject({ data: { fills: [expect.objectContaining({ fillPriceRaw: "10100" })] } });
  });

  it("keeps reconstructed historical book endpoint fail-closed", async () => {
    const app = buildApp(config, v2Deps());
    const response = await app.inject({
      method: "GET",
      url: `/api/v2/mainnet/history/markets/${apiMarketId}/reconstructed-book?atBlock=100`
    });
    await app.close();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "DREAMDEX_HISTORICAL_CAPABILITY_UNVERIFIED",
        retryable: false,
        details: {
          capability: "SOURCE_INCOMPLETE",
          nativeStoredSnapshots: false
        }
      }
    });
  });

  it("exposes v2 Shannon live markets with forward provenance", async () => {
    const app = buildApp(config, v2Deps());
    const response = await app.inject({ method: "GET", url: "/api/v2/shannon/markets/live" });
    await app.close();

    expect(response.statusCode).toBe(200);
    const responseBody = V2LiveMarketsSchema.parse(response.json());
    expect(responseBody.data.markets[0]?.source.chainId).toBe(50312);
    expect(responseBody.meta.plane).toBe("SHANNON_FORWARD");
  });

  it("creates and reloads session-owned experiments without wallet access", async () => {
    const app = buildApp(config, { ...v2Deps(), pool });
    const session = await app.inject({ method: "POST", url: "/api/v2/research-session" });
    const sessionBody = V2SessionSchema.parse(session.json());
    const cookies = cookieHeader(session);
    const payload = {
      name: "Judge BTC hourly replay",
      mode: "HISTORICAL_REPLAY",
      asset: "BTC",
      intervalSec: 3600,
      policyId: "reference-neutral",
      policyVersion: "1.0.0",
      marketId: apiMarketId,
      riskEnvelopeId: "WATCH_ONLY_BOUNDED"
    };
    const create = await app.inject({
      method: "POST",
      url: "/api/v2/experiments",
      headers: {
        cookie: cookies,
        "x-csrf-token": sessionBody.data.csrfToken,
        "idempotency-key": "api-create-judge-btc"
      },
      payload
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v2/experiments",
      headers: {
        cookie: cookies,
        "x-csrf-token": sessionBody.data.csrfToken,
        "idempotency-key": "api-create-judge-btc"
      },
      payload
    });
    const createBody = V2ExperimentSchema.parse(create.json());
    const duplicateBody = V2ExperimentSchema.parse(duplicate.json());
    const detail = await app.inject({
      method: "GET",
      url: `/api/v2/experiments/${createBody.data.experiment.experimentId}`,
      headers: { cookie: cookies }
    });
    const otherSession = await app.inject({ method: "POST", url: "/api/v2/research-session" });
    const denied = await app.inject({
      method: "GET",
      url: `/api/v2/experiments/${createBody.data.experiment.experimentId}`,
      headers: { cookie: cookieHeader(otherSession) }
    });
    await app.close();

    expect(session.statusCode).toBe(200);
    expect(create.statusCode).toBe(201);
    expect(createBody.data.experiment.name).toBe("Judge BTC hourly replay");
    expect(createBody.data.experiment.configuration.config.sourcePlane).toBe("MAINNET_HISTORICAL");
    expect(createBody.data.experiment.configuration.config.historicalBookReconstruction).toBe("SOURCE_INCOMPLETE");
    expect(createBody.data.experiment.configuration.config.pnlStatus).toBe("NOT_AVAILABLE");
    expect(createBody.data.experiment.policies[0]).toMatchObject({
      policyId: "reference-neutral",
      version: "1.0.0",
      role: "CANDIDATE"
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicateBody.data.idempotentReplay).toBe(true);
    expect(duplicateBody.data.experiment.experimentId).toBe(createBody.data.experiment.experimentId);
    expect(detail.statusCode).toBe(200);
    expect(V2ExperimentSchema.parse(detail.json()).data.experiment.experimentId).toBe(
      createBody.data.experiment.experimentId
    );
    expect(denied.statusCode).toBe(404);
  });

  it("runs historical replay, persists decisions, and evaluates from replay evidence", async () => {
    const app = buildApp(config, { ...v2Deps(), pool });
    const session = await app.inject({ method: "POST", url: "/api/v2/research-session" });
    const sessionBody = V2SessionSchema.parse(session.json());
    const cookies = cookieHeader(session);
    const create = await app.inject({
      method: "POST",
      url: "/api/v2/experiments",
      headers: {
        cookie: cookies,
        "x-csrf-token": sessionBody.data.csrfToken,
        "idempotency-key": "api-create-replay-002"
      },
      payload: {
        name: "Replay 002 historical last trade",
        mode: "HISTORICAL_REPLAY",
        asset: "BTC",
        intervalSec: 3600,
        policyId: "historical-last-trade",
        policyVersion: "1.0.0",
        marketId: apiMarketId,
        riskEnvelopeId: "WATCH_ONLY_BOUNDED"
      }
    });
    const experimentId = V2ExperimentSchema.parse(create.json()).data.experiment.experimentId;
    const replay = await app.inject({
      method: "POST",
      url: `/api/v2/experiments/${experimentId}/replay`,
      headers: {
        cookie: cookies,
        "x-csrf-token": sessionBody.data.csrfToken,
        "idempotency-key": "api-run-replay-002"
      }
    });
    const replayBody = V2ReplaySchema.parse(replay.json());
    const evaluate = await app.inject({
      method: "POST",
      url: `/api/v2/experiments/${experimentId}/evaluate`,
      headers: {
        cookie: cookies,
        "x-csrf-token": sessionBody.data.csrfToken,
        "idempotency-key": "api-evaluate-replay-002"
      }
    });
    const assessmentBody = V2AssessmentSchema.parse(evaluate.json());
    const replayReload = await app.inject({
      method: "GET",
      url: `/api/v2/experiments/${experimentId}/replay`,
      headers: { cookie: cookies }
    });
    const latest = await app.inject({
      method: "GET",
      url: `/api/v2/experiments/${experimentId}/evaluation/latest`,
      headers: { cookie: cookies }
    });
    await app.close();

    expect(create.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replayBody.data.replay).toMatchObject({
      status: "SUCCEEDED",
      selectedCount: 1,
      processedCount: 1,
      scoredCount: 1,
      excludedCount: 0
    });
    expect(replayBody.data.replay?.outputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(replayBody.data.replay?.decisions?.[0]).toMatchObject({
      marketId: apiMarketId.toLowerCase(),
      action: "WATCH_ONLY",
      outcomeResult: "YES"
    });
    expect(replayBody.data.replay?.decisions?.[0]?.frameHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(replayBody)).not.toContain("closingAnswer");
    expect(replayReload.statusCode).toBe(200);
    expect(V2ReplaySchema.parse(replayReload.json()).data.replay?.status).toBe("SUCCEEDED");
    expect(evaluate.statusCode).toBe(200);
    expect(assessmentBody.data.assessment.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(assessmentBody.data.assessment.reasonCodes).toContain("MIN_SAMPLE_NOT_MET");
    expect(assessmentBody.data.assessment.sampleSize).toBe(1);
    expect(assessmentBody.data.assessment.pnlStatus).toBe("NOT_AVAILABLE");
    expect(latest.statusCode).toBe(200);
    expect(V2LatestAssessmentSchema.parse(latest.json()).data.assessment?.verdict).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("rejects experiment writes without the current research-session csrf token", async () => {
    const app = buildApp(config, { ...v2Deps(), pool });
    const session = await app.inject({ method: "POST", url: "/api/v2/research-session" });
    const rejected = await app.inject({
      method: "POST",
      url: "/api/v2/experiments",
      headers: {
        cookie: cookieHeader(session),
        "idempotency-key": "api-create-missing-csrf"
      },
      payload: {
        name: "Missing csrf replay",
        mode: "HISTORICAL_REPLAY",
        asset: "BTC",
        intervalSec: 3600,
        policyId: "reference-neutral",
        policyVersion: "1.0.0",
        riskEnvelopeId: "WATCH_ONLY_BOUNDED"
      }
    });
    await app.close();

    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).toMatchObject({
      error: { code: "CSRF_TOKEN_INVALID", retryable: false }
    });
  });
});
