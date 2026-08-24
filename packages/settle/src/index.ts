import { createHash } from "node:crypto";
import type { BinaryMarket } from "@somnia-chain/markets-sdk";
import type pg from "pg";
import { acquireLease, appendAuditEvent } from "@edgelab/db";
import type { SettlementOutcome } from "@edgelab/domain";
import type { DreamDexSdkClient } from "@edgelab/dreamdex";

export interface SettlementClock {
  now(): Date;
}

export interface SettlementClassification {
  readonly outcome: SettlementOutcome;
  readonly resolved: boolean;
  readonly voided: boolean;
  readonly winner: "YES" | "NO" | null;
  readonly terminal: boolean;
  readonly payload: Record<string, unknown>;
  readonly settlementHash: string | null;
}

export interface ReconcileSettlementsInput {
  readonly pool: pg.Pool;
  readonly dreamDexClient: DreamDexSdkClient;
  readonly holderId: string;
  readonly leaseTtlMs?: number;
  readonly clock?: SettlementClock;
  readonly limit?: number;
}

export interface ReconciledEpisode {
  readonly episodeId: string;
  readonly marketId: string;
  readonly outcome: SettlementOutcome;
  readonly terminal: boolean;
  readonly insertedSettlement: boolean;
  readonly reusedSettlement: boolean;
}

export interface ReconcileSettlementsResult {
  readonly leaseAcquired: boolean;
  readonly holderId: string;
  readonly checkedCount: number;
  readonly reconciled: readonly ReconciledEpisode[];
}

interface EpisodeDueRow {
  readonly id: string;
  readonly market_id: string;
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

function winningLabel(winningOutcome: number): "YES" | "NO" | null {
  if (winningOutcome === 0) {
    return "YES";
  }
  if (winningOutcome === 1) {
    return "NO";
  }
  return null;
}

export function classifySettlement(market: BinaryMarket | null, observedAt: string): SettlementClassification {
  if (market === null) {
    return {
      outcome: "UNAVAILABLE",
      resolved: false,
      voided: false,
      winner: null,
      terminal: false,
      payload: { observedAt, market: null },
      settlementHash: null
    };
  }

  const basePayload = {
    marketId: market.marketId.toLowerCase(),
    status: market.status,
    finalized: market.finalized ?? null,
    voided: market.voided,
    winningOutcome: market.winningOutcome,
    payoutNumerators: market.payoutNumerators ?? null,
    payoutDenominator: market.payoutDenominator ?? null,
    resolvedAtBlock: market.resolvedAtBlock,
    resolvedAtTimestamp: market.resolvedAtTimestamp,
    observedAt
  };

  if (market.voided) {
    const payload = {
      ...basePayload,
      outcome: "VOIDED"
    };
    return {
      outcome: "VOIDED",
      resolved: false,
      voided: true,
      winner: null,
      terminal: true,
      payload,
      settlementHash: sha256({ ...payload, observedAt: undefined })
    };
  }

  if (market.winningOutcome !== null) {
    const winner = winningLabel(market.winningOutcome);
    if (winner !== null) {
      const outcome: SettlementOutcome = winner === "YES" ? "RESOLVED_YES" : "RESOLVED_NO";
      const payload = {
        ...basePayload,
        outcome,
        winner
      };
      return {
        outcome,
        resolved: true,
        voided: false,
        winner,
        terminal: true,
        payload,
        settlementHash: sha256({ ...payload, observedAt: undefined })
      };
    }
  }

  return {
    outcome: "PENDING",
    resolved: false,
    voided: false,
    winner: null,
    terminal: false,
    payload: {
      ...basePayload,
      outcome: "PENDING"
    },
    settlementHash: null
  };
}

async function dueEpisodes(pool: pg.Pool, now: Date, limit: number): Promise<EpisodeDueRow[]> {
  const result = await pool.query<EpisodeDueRow>(
    `
      SELECT id, market_id
      FROM market_episodes
      WHERE state IN ('DECISION_RECORDED', 'AWAITING_SETTLEMENT', 'RESOLVED', 'VOIDED')
        AND expires_at <= $1
      ORDER BY expires_at ASC, created_at ASC
      LIMIT $2
    `,
    [now.toISOString(), limit]
  );
  return result.rows;
}

async function insertTerminalSettlement(input: {
  readonly pool: pg.Pool;
  readonly marketId: string;
  readonly observedAt: string;
  readonly classification: SettlementClassification;
}): Promise<{ inserted: boolean; reused: boolean }> {
  if (input.classification.settlementHash === null) {
    return { inserted: false, reused: false };
  }
  const result = await input.pool.query<{ id: string }>(
    `
      INSERT INTO settlements(
        market_id, resolved, voided, winner, source_observed_at, payload, settlement_hash
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
      ON CONFLICT (settlement_hash) DO NOTHING
      RETURNING id
    `,
    [
      input.marketId,
      input.classification.resolved,
      input.classification.voided,
      input.classification.winner,
      input.observedAt,
      JSON.stringify(input.classification.payload),
      input.classification.settlementHash
    ]
  );
  const inserted = (result.rowCount ?? 0) > 0;
  return {
    inserted,
    reused: !inserted
  };
}

async function reconcileEpisode(input: {
  readonly pool: pg.Pool;
  readonly dreamDexClient: DreamDexSdkClient;
  readonly episode: EpisodeDueRow;
  readonly observedAt: string;
}): Promise<ReconciledEpisode> {
  const market = await input.dreamDexClient.getBinaryMarket(input.episode.market_id);
  const classification = classifySettlement(market, input.observedAt);
  const terminalWrite = await insertTerminalSettlement({
    pool: input.pool,
    marketId: input.episode.market_id,
    observedAt: input.observedAt,
    classification
  });

  if (classification.outcome === "VOIDED") {
    await input.pool.query("UPDATE market_episodes SET state = 'VOIDED' WHERE id = $1", [input.episode.id]);
  } else if (classification.resolved) {
    await input.pool.query("UPDATE market_episodes SET state = 'RESOLVED' WHERE id = $1", [input.episode.id]);
  } else if (classification.outcome === "PENDING") {
    await input.pool.query("UPDATE market_episodes SET state = 'AWAITING_SETTLEMENT' WHERE id = $1", [
      input.episode.id
    ]);
  }

  return {
    episodeId: input.episode.id,
    marketId: input.episode.market_id,
    outcome: classification.outcome,
    terminal: classification.terminal,
    insertedSettlement: terminalWrite.inserted,
    reusedSettlement: terminalWrite.reused
  };
}

export async function reconcileSettlements(input: ReconcileSettlementsInput): Promise<ReconcileSettlementsResult> {
  const lease = await acquireLease(
    input.pool,
    "settle",
    input.holderId,
    input.leaseTtlMs ?? 30_000
  );
  if (!lease.acquired) {
    return {
      leaseAcquired: false,
      holderId: lease.holderId,
      checkedCount: 0,
      reconciled: []
    };
  }

  const now = input.clock?.now() ?? new Date();
  const episodes = await dueEpisodes(input.pool, now, input.limit ?? 50);
  const observedAt = now.toISOString();
  const reconciled: ReconciledEpisode[] = [];
  for (const episode of episodes) {
    reconciled.push(await reconcileEpisode({ pool: input.pool, dreamDexClient: input.dreamDexClient, episode, observedAt }));
  }

  await appendAuditEvent(input.pool, {
    actor: "worker",
    action: "RECONCILE_SETTLEMENTS",
    targetType: "market_episodes",
    targetId: "due",
    outcome: "PASS",
    correlationId: input.holderId,
    safeMetadata: {
      checkedCount: episodes.length,
      terminalCount: reconciled.filter((episode) => episode.terminal).length
    }
  });

  return {
    leaseAcquired: true,
    holderId: lease.holderId,
    checkedCount: episodes.length,
    reconciled
  };
}
