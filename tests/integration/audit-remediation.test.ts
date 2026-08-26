import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { RuntimeConfig } from "@edgelab/config";
import type {
  DreamDexSdkClient,
  HistoricalMarketEvidence,
  HistoricalOrderEvidence
} from "@edgelab/dreamdex";
import { buildHistoricalDecisionFrame } from "@edgelab/replay";
import { buildApp } from "@edgelab/server";

const config: RuntimeConfig = {
  NODE_ENV: "test",
  PORT: 3000,
  DATABASE_URL: "postgres://unused:unused@localhost:5432/unused",
  PUBLIC_APP_URL: "http://localhost:3000",
  SESSION_SECRET: "audit-remediation-test-secret-0001",
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
  BUILD_COMMIT: "audit-remediation-test"
};

const source = {
  plane: "MAINNET_HISTORICAL",
  chainId: 5031,
  rpcUrl: config.SOMNIA_MAINNET_RPC_URL,
  indexerUrl: config.DREAMDEX_MAINNET_INDEXER_URL,
  sdkVersion: "0.28.1",
  evidenceClass: "CAPTURED",
  retrievedAt: "2026-08-25T11:15:00.000Z",
  writePolicy: "read-only-no-mainnet-signer"
} as const;

const market: HistoricalMarketEvidence = {
  stableMarketId: `0x${"4".repeat(64)}`,
  marketAddress: "0x0000000000000000000000000000000000000a44",
  poolAddress: "0x0000000000000000000000000000000000000b44",
  nonce: "44",
  asset: "BTC",
  question: "Will BTC close up?",
  status: "Finalized",
  finalized: true,
  winningOutcome: "YES",
  intervalSeconds: 3600,
  tradingStartSeconds: 1787566400,
  expirySeconds: 1787570000,
  collateral: "0x0000000000000000000000000000000000000001",
  quoteDecimals: 6,
  tradeCount: 1,
  openingPriceRaw: "100000",
  source
};

function historicalOrder(overrides: Partial<HistoricalOrderEvidence> = {}): HistoricalOrderEvidence {
  return {
    id: "order-before",
    orderId: "101",
    marketId: market.stableMarketId,
    side: "BUY_YES",
    isBid: true,
    priceRaw: "10000",
    fullQuantityRaw: "1000000",
    filledQuantityRaw: "0",
    remainingQuantityRaw: "1000000",
    status: "Open",
    rested: true,
    expireTimestampNs: "1787570100000000000",
    placedAtBlock: "44",
    placedAtTimestampSeconds: 1787566500,
    lastUpdatedAtBlock: "44",
    lastUpdatedAtTimestampSeconds: 1787566500,
    placedTxHash: "0xplaced",
    source,
    ...overrides
  };
}

describe("System 3 P0 remediation regressions", () => {
  it("AUD-001 ignores an order's post-cutoff lifecycle summary", () => {
    const baseInput = {
      market,
      decisionAt: "2026-08-24T10:17:00.000Z",
      cutoffBlock: "100",
      quoteDecimals: 6,
      openingPrice: null,
      candles: [],
      fills: []
    } as const;
    const visibleAtCutoff = buildHistoricalDecisionFrame({
      ...baseInput,
      orders: [historicalOrder()]
    });
    const finalizedAfterCutoff = buildHistoricalDecisionFrame({
      ...baseInput,
      orders: [
        historicalOrder({
          status: "Expired",
          remainingQuantityRaw: "0",
          lastUpdatedAtBlock: "101",
          lastUpdatedAtTimestampSeconds: 1787567900
        })
      ]
    });

    expect(finalizedAfterCutoff.frame).toEqual(visibleAtCutoff.frame);
    expect(finalizedAfterCutoff.frameHash).toBe(visibleAtCutoff.frameHash);
    expect(finalizedAfterCutoff.frame.orders).toHaveLength(1);
  });

  it("AUD-002 disables every obsolete public legacy mutation before database access", async () => {
    let databaseCalls = 0;
    const sentinelPool = {
      query() {
        databaseCalls += 1;
        throw new Error("AUDIT_DB_REACHED");
      }
    } as unknown as pg.Pool;
    const dreamDexClient = {} as DreamDexSdkClient;
    const app = buildApp(config, {
      pool: sentinelPool,
      dreamDexClient,
      dreamDexConfig: {
        rpcUrl: config.SOMNIA_RPC_URL,
        wsRpcUrl: config.SOMNIA_WS_RPC_URL,
        indexerUrl: config.DREAMDEX_INDEXER_URL,
        chainId: config.SOMNIA_CHAIN_ID,
        sdkVersion: config.MARKETS_SDK_VERSION
      }
    });
    const experimentId = "00000000-0000-4000-8000-000000000001";
    const requests = [
      app.inject({
        method: "POST",
        url: `/api/v1/experiments/${experimentId}/observe`,
        headers: { "idempotency-key": "audit-observe-001" }
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/settlements/reconcile",
        headers: { "idempotency-key": "audit-reconcile-001" }
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/experiments/${experimentId}/evaluate`,
        headers: { "idempotency-key": "audit-evaluate-001" },
        payload: {
          policyVersionId: "00000000-0000-4000-8000-000000000002",
          ruleVersion: "evidence-gate-v1"
        }
      })
    ];
    const responses = await Promise.all(requests);
    await app.close();

    expect(responses.map((response) => response.statusCode)).toEqual([410, 410, 410]);
    expect(databaseCalls).toBe(0);
  });
});
