import { createHash } from "node:crypto";
import type pg from "pg";
import { SOMNIA_SHANNON_CHAIN_ID, type ExecutionState } from "@edgelab/domain";

export interface ChainLifecycleArtifact {
  readonly evidenceId: string;
  readonly pathOrUrl: string;
  readonly sha256: string;
  readonly commitSha: string;
  readonly environment: string;
  readonly evidenceClass: "LIVE" | "CAPTURED" | "MOCK" | "SIMULATED_FROM_CAPTURED_BOOK";
  readonly redaction: string;
}

export interface ChainLifecycleInput {
  readonly ownerAddress: string;
  readonly marketId: string;
  readonly poolAddress: string;
  readonly side: "BUY_YES" | "SELL_YES" | "BUY_NO" | "SELL_NO";
  readonly priceRaw: string;
  readonly quantityRaw: string;
  readonly escrowRaw: string;
  readonly expiresAt: string;
  readonly idempotencyKey: string;
  readonly intentHash: string;
  readonly caps: Record<string, unknown>;
  readonly order: {
    readonly txHash: string;
    readonly nonce: string;
    readonly blockNumber: string;
    readonly receiptStatus: boolean;
    readonly logHash: string;
    readonly verifiedAt: string;
    readonly orderId: string;
    readonly state: Extract<ExecutionState, "ORDER_VERIFIED" | "UNFILLED" | "PARTIALLY_FILLED" | "FILLED">;
    readonly quantityRaw: string;
    readonly remainingQuantityRaw: string;
    readonly payload: Record<string, unknown>;
  };
  readonly fills?: readonly {
    readonly fillIndex: number;
    readonly quantityRaw: string;
    readonly priceRaw: string;
    readonly observedAt: string;
    readonly payload: Record<string, unknown>;
  }[];
  readonly terminal: {
    readonly txHash: string;
    readonly nonce: string;
    readonly blockNumber: string;
    readonly receiptStatus: boolean;
    readonly logHash: string;
    readonly verifiedAt: string;
    readonly orderId: string;
    readonly state: Extract<ExecutionState, "CANCELLED" | "EXPIRED" | "FAILED" | "UNVERIFIED">;
    readonly quantityRaw: string;
    readonly remainingQuantityRaw: string;
    readonly payload: Record<string, unknown>;
  };
  readonly artifacts: readonly ChainLifecycleArtifact[];
}

export interface ChainLifecycleResult {
  readonly intentId: string;
  readonly state: ExecutionState;
  readonly orderTxHash: string;
  readonly terminalTxHash: string;
  readonly orderId: string;
  readonly fillCount: number;
  readonly terminalState: ExecutionState;
  readonly evidenceArtifacts: number;
}

export interface ChainEvidenceSummary {
  readonly submittedOrderCount: number;
  readonly fillCount: number;
  readonly terminalOrderCount: number;
  readonly openOrderCount: number;
  readonly latestTerminalState: ExecutionState | null;
  readonly tradeabilityStatus: "NOT_EVALUATED" | "EVALUATED";
}

function canonicalize(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map((item) => canonicalize(item));
  }
  if (input !== null && typeof input === "object") {
    return Object.fromEntries(
      Object.entries(input)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, canonicalize(value)])
    );
  }
  return input;
}

function sha256(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(input))).digest("hex");
}

function lowerAddress(address: string): string {
  return address.toLowerCase();
}

function assertSomniaChain(chainId: number): void {
  if (chainId !== SOMNIA_SHANNON_CHAIN_ID) {
    throw new Error(`Chain lifecycle evidence must target Somnia Shannon ${String(SOMNIA_SHANNON_CHAIN_ID)}`);
  }
}

export async function persistChainLifecycleEvidence(
  pool: pg.Pool,
  input: ChainLifecycleInput
): Promise<ChainLifecycleResult> {
  assertSomniaChain(SOMNIA_SHANNON_CHAIN_ID);
  const ownerAddress = lowerAddress(input.ownerAddress);
  const poolAddress = lowerAddress(input.poolAddress);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO wallet_identities(address, chain_id) VALUES ($1, $2) ON CONFLICT (address) DO NOTHING",
      [ownerAddress, SOMNIA_SHANNON_CHAIN_ID]
    );
    const intent = await client.query<{ id: string }>(
      `
        INSERT INTO execution_intents(
          owner_address, market_id, chain_id, intent_type, state, pool_address, side,
          price_raw, quantity_raw, escrow_raw, expires_at, caps, idempotency_key, intent_hash
        )
        VALUES ($1, $2, $3, 'INTEGRATION_PROBE', $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
        ON CONFLICT (idempotency_key) DO UPDATE
        SET state = EXCLUDED.state
        RETURNING id
      `,
      [
        ownerAddress,
        input.marketId,
        SOMNIA_SHANNON_CHAIN_ID,
        input.terminal.state,
        poolAddress,
        input.side,
        input.priceRaw,
        input.quantityRaw,
        input.escrowRaw,
        input.expiresAt,
        JSON.stringify(input.caps),
        input.idempotencyKey,
        input.intentHash
      ]
    );
    const intentId = intent.rows[0]?.id;
    if (intentId === undefined) {
      throw new Error("Execution intent insert did not return an id");
    }

    await insertTransaction(client, intentId, ownerAddress, input.order);
    await insertTransaction(client, intentId, ownerAddress, input.terminal);
    await insertOrderEvidence(client, input.order.txHash, input.order);
    await insertOrderEvidence(client, input.terminal.txHash, input.terminal);
    for (const fill of input.fills ?? []) {
      await client.query(
        `
          INSERT INTO fill_evidence(tx_hash, fill_index, quantity_raw, price_raw, observed_at, payload)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb)
          ON CONFLICT (tx_hash, fill_index) DO UPDATE
          SET payload = EXCLUDED.payload
        `,
        [
          input.order.txHash,
          fill.fillIndex,
          fill.quantityRaw,
          fill.priceRaw,
          fill.observedAt,
          JSON.stringify(fill.payload)
        ]
      );
    }
    for (const artifact of input.artifacts) {
      await client.query(
        `
          INSERT INTO evidence_artifacts(
            evidence_id, artifact_type, path_or_url, sha256, commit_sha, environment, evidence_class, redaction
          )
          VALUES ($1, 'CHAIN_LIFECYCLE', $2, $3, $4, $5, $6, $7)
          ON CONFLICT (evidence_id, path_or_url, sha256) DO NOTHING
        `,
        [
          artifact.evidenceId,
          artifact.pathOrUrl,
          artifact.sha256,
          artifact.commitSha,
          artifact.environment,
          artifact.evidenceClass,
          artifact.redaction
        ]
      );
    }
    await client.query(
      `
        INSERT INTO audit_events(
          actor, action, target_type, target_id, outcome, correlation_id, safe_metadata, event_hash
        )
        VALUES ($1, 'CHAIN_LIFECYCLE_RECONCILED', 'execution_intent', $2, 'PASS', $3, $4::jsonb, $5)
        ON CONFLICT (event_hash) DO NOTHING
      `,
      [
        "system",
        intentId,
        input.idempotencyKey,
        JSON.stringify({
          orderTxHash: input.order.txHash,
          terminalTxHash: input.terminal.txHash,
          orderId: input.order.orderId,
          terminalState: input.terminal.state
        }),
        sha256({ action: "CHAIN_LIFECYCLE_RECONCILED", intentId, idempotencyKey: input.idempotencyKey })
      ]
    );
    await client.query("COMMIT");
    return {
      intentId,
      state: input.terminal.state,
      orderTxHash: input.order.txHash,
      terminalTxHash: input.terminal.txHash,
      orderId: input.order.orderId,
      fillCount: input.fills?.length ?? 0,
      terminalState: input.terminal.state,
      evidenceArtifacts: input.artifacts.length
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertTransaction(
  client: pg.PoolClient,
  intentId: string,
  fromAddress: string,
  input: {
    readonly txHash: string;
    readonly nonce: string;
    readonly blockNumber: string;
    readonly receiptStatus: boolean;
    readonly logHash: string;
    readonly verifiedAt: string;
    readonly payload: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `
      INSERT INTO chain_transactions(
        tx_hash, intent_id, chain_id, from_address, nonce, receipt_status,
        block_number, log_hash, verified_at, payload
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
      ON CONFLICT (tx_hash) DO UPDATE
      SET verified_at = EXCLUDED.verified_at,
          payload = EXCLUDED.payload
    `,
    [
      input.txHash,
      intentId,
      SOMNIA_SHANNON_CHAIN_ID,
      fromAddress,
      input.nonce,
      input.receiptStatus,
      input.blockNumber,
      input.logHash,
      input.verifiedAt,
      JSON.stringify(input.payload)
    ]
  );
}

async function insertOrderEvidence(
  client: pg.PoolClient,
  txHash: string,
  input: {
    readonly orderId: string;
    readonly state: ExecutionState;
    readonly quantityRaw: string;
    readonly remainingQuantityRaw: string;
    readonly verifiedAt: string;
    readonly payload: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `
      INSERT INTO order_evidence(
        tx_hash, order_id, state, quantity_raw, remaining_quantity_raw,
        evidence_source, observed_at, payload
      )
      VALUES ($1, $2, $3, $4, $5, 'CHAIN', $6, $7::jsonb)
      ON CONFLICT (tx_hash, order_id, observed_at) DO UPDATE
      SET state = EXCLUDED.state,
          payload = EXCLUDED.payload
    `,
    [
      txHash,
      input.orderId,
      input.state,
      input.quantityRaw,
      input.remainingQuantityRaw,
      input.verifiedAt,
      JSON.stringify(input.payload)
    ]
  );
}

export async function summarizeChainEvidence(pool: pg.Pool): Promise<ChainEvidenceSummary> {
  const result = await pool.query<{
    submitted_order_count: string;
    fill_count: string;
    terminal_order_count: string;
    open_order_count: string;
    latest_terminal_state: ExecutionState | null;
  }>(
    `
      SELECT
        (SELECT count(*) FROM order_evidence WHERE state IN ('ORDER_VERIFIED', 'UNFILLED', 'PARTIALLY_FILLED', 'FILLED')) AS submitted_order_count,
        (SELECT count(*) FROM fill_evidence) AS fill_count,
        (SELECT count(*) FROM order_evidence WHERE state IN ('CANCELLED', 'EXPIRED', 'SETTLED')) AS terminal_order_count,
        (SELECT count(*) FROM execution_intents WHERE state NOT IN ('SETTLED', 'CANCELLED', 'EXPIRED', 'UNVERIFIED', 'FAILED')) AS open_order_count,
        (
          SELECT state FROM order_evidence
          WHERE state IN ('CANCELLED', 'EXPIRED', 'SETTLED')
          ORDER BY observed_at DESC
          LIMIT 1
        ) AS latest_terminal_state
    `
  );
  const row = result.rows[0];
  const submittedOrderCount = Number(row?.submitted_order_count ?? 0);
  const terminalOrderCount = Number(row?.terminal_order_count ?? 0);
  return {
    submittedOrderCount,
    fillCount: Number(row?.fill_count ?? 0),
    terminalOrderCount,
    openOrderCount: Number(row?.open_order_count ?? 0),
    latestTerminalState: row?.latest_terminal_state ?? null,
    tradeabilityStatus: submittedOrderCount > 0 || terminalOrderCount > 0 ? "EVALUATED" : "NOT_EVALUATED"
  };
}
