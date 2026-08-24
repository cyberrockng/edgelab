import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  persistChainLifecycleEvidence,
  summarizeChainEvidence,
  type ChainLifecycleInput
} from "@edgelab/chain";
import { createPool, runMigrations } from "@edgelab/db";

const connectionString =
  process.env.TEST_DATABASE_URL ?? "postgres://edgelab:edgelab@localhost:55432/edgelab";

const pool = createPool({ connectionString, max: 4, statementTimeoutMs: 5000 });

async function resetPublicSchema(): Promise<void> {
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
}

function lifecycleInput(): ChainLifecycleInput {
  return {
    ownerAddress: "0x0000000000000000000000000000000000000abc",
    marketId: `0x${"8".repeat(64)}`,
    poolAddress: "0x0000000000000000000000000000000000000def",
    side: "BUY_YES",
    priceRaw: "10000",
    quantityRaw: "1000000",
    escrowRaw: "10000",
    expiresAt: "2026-08-24T22:48:41.000Z",
    idempotencyKey: "chain-test-lifecycle",
    intentHash: "1".repeat(64),
    caps: {
      maxEscrowRaw: "10000",
      fillRequired: false,
      network: "Somnia Shannon Testnet"
    },
    order: {
      txHash: `0x${"2".repeat(64)}`,
      nonce: "7",
      blockNumber: "470386018",
      receiptStatus: true,
      logHash: "3".repeat(64),
      verifiedAt: "2026-08-24T22:45:00.000Z",
      orderId: "110680464442257591736",
      state: "ORDER_VERIFIED",
      quantityRaw: "1000000",
      remainingQuantityRaw: "1000000",
      payload: {
        side: "BUY_YES",
        fills: [],
        fillStatus: "NO_FILL"
      }
    },
    terminal: {
      txHash: `0x${"4".repeat(64)}`,
      nonce: "8",
      blockNumber: "470395919",
      receiptStatus: true,
      logHash: "5".repeat(64),
      verifiedAt: "2026-08-24T23:04:30.000Z",
      orderId: "110680464442257591736",
      state: "EXPIRED",
      quantityRaw: "1000000",
      remainingQuantityRaw: "0",
      payload: {
        terminalEvent: "OrderExpired",
        collateralReconciled: true,
        tUsdcAfterTerminal: "10"
      }
    },
    artifacts: [
      {
        evidenceId: "BLK-003-ORDER",
        pathOrUrl: "evidence/feasibility/blk-003-order.json",
        sha256: "6".repeat(64),
        commitSha: "test-commit",
        environment: "test",
        evidenceClass: "LIVE",
        redaction: "public chain evidence only"
      },
      {
        evidenceId: "BLK-003-TERMINAL",
        pathOrUrl: "evidence/feasibility/blk-003-terminal.json",
        sha256: "7".repeat(64),
        commitSha: "test-commit",
        environment: "test",
        evidenceClass: "LIVE",
        redaction: "public chain evidence only"
      }
    ]
  };
}

describe("CHAIN-001 lifecycle evidence reconciliation", () => {
  beforeAll(async () => {
    await resetPublicSchema();
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("persists a no-fill order lifecycle as terminal tradeability evidence", async () => {
    const result = await persistChainLifecycleEvidence(pool, lifecycleInput());
    const summary = await summarizeChainEvidence(pool);
    const intentRows = await pool.query<{ state: string }>(
      "SELECT state FROM execution_intents WHERE id = $1",
      [result.intentId]
    );
    const orderRows = await pool.query<{ state: string; remaining_quantity_raw: string }>(
      "SELECT state, remaining_quantity_raw FROM order_evidence ORDER BY observed_at"
    );

    expect(result).toMatchObject({
      state: "EXPIRED",
      orderId: "110680464442257591736",
      fillCount: 0,
      terminalState: "EXPIRED",
      evidenceArtifacts: 2
    });
    expect(intentRows.rows[0]?.state).toBe("EXPIRED");
    expect(orderRows.rows.map((row) => row.state)).toEqual(["ORDER_VERIFIED", "EXPIRED"]);
    expect(orderRows.rows[1]?.remaining_quantity_raw).toBe("0");
    expect(summary).toEqual({
      submittedOrderCount: 1,
      fillCount: 0,
      terminalOrderCount: 1,
      openOrderCount: 0,
      latestTerminalState: "EXPIRED",
      tradeabilityStatus: "EVALUATED"
    });
  });

  it("is idempotent for the same lifecycle evidence", async () => {
    await persistChainLifecycleEvidence(pool, lifecycleInput());
    await persistChainLifecycleEvidence(pool, lifecycleInput());
    const counts = await pool.query<{
      intents: string;
      transactions: string;
      orders: string;
      artifacts: string;
    }>(
      `
        SELECT
          (SELECT count(*) FROM execution_intents) AS intents,
          (SELECT count(*) FROM chain_transactions) AS transactions,
          (SELECT count(*) FROM order_evidence) AS orders,
          (SELECT count(*) FROM evidence_artifacts) AS artifacts
      `
    );

    expect(counts.rows[0]).toEqual({
      intents: "1",
      transactions: "2",
      orders: "2",
      artifacts: "2"
    });
  });
});
