import { describe, expect, it } from "vitest";
import { loadConfig } from "@edgelab/config";
import { MarketSnapshotSchema } from "@edgelab/domain";
import { assessEvidence } from "@edgelab/metrics";
import { evaluatePolicy, referencePolicies } from "@edgelab/policy-runtime";

const baseEnv = {
  DATABASE_URL: "postgres://edgelab:edgelab@localhost:5432/edgelab",
  PUBLIC_APP_URL: "http://localhost:3000",
  SESSION_SECRET: "0123456789abcdef0123456789abcdef",
  SOMNIA_CHAIN_ID: "50312",
  SOMNIA_RPC_URL: "https://api.infra.testnet.somnia.network/",
  SOMNIA_WS_RPC_URL: "wss://api.infra.testnet.somnia.network/ws",
  DREAMDEX_INDEXER_URL: "https://dev.smk.somnia.host/v1/graphql",
  MARKETS_SDK_VERSION: "0.28.1",
  WORKER_ENABLED: "false"
};

describe("foundation boundaries", () => {
  it("rejects server-side wallet signing configuration", () => {
    const forbiddenName = ["PRIVATE", "KEY"].join("_");
    expect(() => loadConfig({ ...baseEnv, [forbiddenName]: "forbidden" })).toThrow(
      /Forbidden wallet/
    );
  });

  it("accepts a labeled Somnia/DreamDEX snapshot shape", () => {
    const parsed = MarketSnapshotSchema.parse({
      marketId: "0xmarket",
      chainId: 50312,
      asset: "BTC",
      intervalSeconds: 900,
      capturedAt: "2026-08-24T13:00:00.000Z",
      source: {
        sdkVersion: "0.28.1",
        rpcUrl: "https://api.infra.testnet.somnia.network/",
        indexerUrl: "https://dev.smk.somnia.host/v1/graphql",
        evidenceClass: "MOCK"
      },
      book: {
        bids: [],
        asks: []
      }
    });

    expect(parsed.chainId).toBe(50312);
  });

  it("keeps insufficient evidence as a first-class deterministic verdict", () => {
    const assessment = assessEvidence([]);
    expect(assessment.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(assessment.metrics.pnlStatus).toBe("NOT_AVAILABLE");
  });

  it("evaluates reference policies without outcome input", () => {
    const snapshot = MarketSnapshotSchema.parse({
      marketId: "0xmarket",
      chainId: 50312,
      asset: "ETH",
      intervalSeconds: 3600,
      capturedAt: "2026-08-24T13:00:00.000Z",
      source: {
        sdkVersion: "0.28.1",
        rpcUrl: "https://api.infra.testnet.somnia.network/",
        indexerUrl: "https://dev.smk.somnia.host/v1/graphql",
        evidenceClass: "MOCK"
      },
      book: { bids: [{ priceRaw: "1000", quantityRaw: "1000" }], asks: [] }
    });

    const decision = evaluatePolicy(referencePolicies[1], {
      snapshot,
      decidedAt: "2026-08-24T13:00:01.000Z",
      snapshotHash: "a".repeat(64)
    });

    expect(decision.forecastPUp).toBe(0.54);
    expect(decision.policyHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
