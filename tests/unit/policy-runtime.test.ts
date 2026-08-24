import { describe, expect, it } from "vitest";
import { MarketSnapshotSchema } from "@edgelab/domain";
import {
  PolicyRuntimeError,
  createPolicyManifest,
  createPolicyRegistry,
  evaluatePolicy,
  referencePolicies,
  type PolicyAdapter
} from "@edgelab/policy-runtime";

const snapshot = MarketSnapshotSchema.parse({
  marketId: "market-policy",
  chainId: 50312,
  asset: "BTC",
  intervalSeconds: 900,
  capturedAt: "2026-08-24T14:00:00.000Z",
  source: {
    sdkVersion: "0.28.1",
    rpcUrl: "https://api.infra.testnet.somnia.network/",
    indexerUrl: "https://dev.smk.somnia.host/v1/graphql",
    evidenceClass: "MOCK"
  },
  book: {
    bids: [{ priceRaw: "1000", quantityRaw: "1000" }],
    asks: []
  }
});

describe("POLICY-001 immutable policy runtime", () => {
  it("creates deterministic immutable manifests for compile-time policies", () => {
    const first = createPolicyManifest(referencePolicies[0]);
    const second = createPolicyManifest(referencePolicies[0]);
    expect(first).toEqual(second);
    expect(first.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects duplicate policy versions in the registry", () => {
    expect(() => createPolicyRegistry([referencePolicies[0], referencePolicies[0]])).toThrow(
      PolicyRuntimeError
    );
  });

  it("evaluates without outcome, network, or clock access in input", () => {
    const decision = evaluatePolicy(referencePolicies[1], {
      snapshot,
      decidedAt: "2026-08-24T14:00:10.000Z",
      snapshotHash: "1".repeat(64)
    });
    expect(decision.forecastPUp).toBe(0.54);
    expect(decision.reasonCodes).toContain("CAPTURED_BOOK_ONLY");
  });

  it("rejects malformed policy outputs instead of recording partial success", () => {
    const invalidPolicy: PolicyAdapter = {
      policyId: "invalid",
      version: "1.0.0",
      label: "Invalid",
      adapterName: "invalidPolicy",
      evaluate() {
        return {
          forecastPUp: Number.NaN,
          action: "WATCH_ONLY",
          reasonCodes: ["INVALID"]
        };
      }
    };
    expect(() =>
      evaluatePolicy(invalidPolicy, {
        snapshot,
        decidedAt: "2026-08-24T14:00:10.000Z",
        snapshotHash: "2".repeat(64)
      })
    ).toThrow(PolicyRuntimeError);
  });

  it("converts thrown policy errors into reason-coded runtime failures", () => {
    const throwingPolicy: PolicyAdapter = {
      policyId: "throws",
      version: "1.0.0",
      label: "Throws",
      adapterName: "throwingPolicy",
      evaluate() {
        throw new Error("boom");
      }
    };
    expect(() =>
      evaluatePolicy(throwingPolicy, {
        snapshot,
        decidedAt: "2026-08-24T14:00:10.000Z",
        snapshotHash: "3".repeat(64)
      })
    ).toThrow("boom");
  });
});
