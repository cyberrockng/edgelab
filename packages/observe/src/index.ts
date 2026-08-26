import { createHash } from "node:crypto";
import type pg from "pg";
import { acquireLease, appendAuditEvent } from "@edgelab/db";
import { MarketSnapshotSchema, SOMNIA_SHANNON_CHAIN_ID, type MarketSnapshot } from "@edgelab/domain";
import {
  captureMarketSnapshot,
  discoverSuccessorMarkets,
  type DreamDexMarketEvidence,
  type DreamDexReadConfig,
  type DreamDexSdkClient,
  type DreamDexSnapshotEvidence
} from "@edgelab/dreamdex";
import {
  createPolicyManifest,
  evaluatePolicy,
  type PolicyAdapter,
  type PolicyManifest
} from "@edgelab/policy-runtime";

export interface ObservationClock {
  now(): Date;
}

export interface ObserveExperimentInput {
  readonly pool: pg.Pool;
  readonly dreamDexClient: DreamDexSdkClient;
  readonly dreamDexConfig: DreamDexReadConfig;
  readonly experimentId: string;
  readonly policyAdapters: readonly PolicyAdapter[];
  readonly holderId: string;
  readonly leaseTtlMs?: number;
  readonly clock?: ObservationClock;
  readonly depth?: number;
  readonly assets?: readonly ("BTC" | "ETH")[];
  readonly intervals?: readonly number[];
}

export interface ObservedEpisodeResult {
  readonly marketId: string;
  readonly episodeId: string;
  readonly snapshotId: string | null;
  readonly insertedDecisionCount: number;
  readonly reusedDecisionCount: number;
  readonly skipped: boolean;
  readonly reasonCode?: "MARKET_ALREADY_EXPIRED" | "SNAPSHOT_READ_FAILED" | "POLICY_ADAPTER_MISSING";
}

export interface ObserveExperimentResult {
  readonly leaseAcquired: boolean;
  readonly holderId: string;
  readonly discoveredMarketCount: number;
  readonly observed: readonly ObservedEpisodeResult[];
}

interface ExperimentRecord {
  readonly id: string;
  readonly decision_offset_sec: number;
  readonly risk_hash: string;
  readonly policies: readonly {
    readonly id: string;
    readonly policyId: string;
    readonly version: string;
    readonly sourceHash: string;
  }[];
}

interface EpisodeRecord {
  readonly id: string;
  readonly expires_at: Date;
}

interface SnapshotRecord {
  readonly id: string;
  readonly snapshot_hash: string;
  readonly payload: unknown;
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

function adapterKey(policyId: string, version: string): string {
  return `${policyId}@${version}`;
}

function toDomainSnapshot(snapshot: DreamDexSnapshotEvidence): MarketSnapshot {
  return MarketSnapshotSchema.parse({
    marketId: snapshot.market.stableMarketId,
    chainId: SOMNIA_SHANNON_CHAIN_ID,
    asset: snapshot.market.asset,
    intervalSeconds: snapshot.market.intervalSeconds ?? 0,
    capturedAt: snapshot.market.source.retrievedAt,
    source: {
      sdkVersion: snapshot.market.source.sdkVersion,
      rpcUrl: snapshot.market.source.rpcUrl,
      indexerUrl: snapshot.market.source.indexerUrl,
      evidenceClass: snapshot.market.source.evidenceClass
    },
    book: {
      bids: snapshot.book.yesBids,
      asks: snapshot.book.yesAsks
    }
  });
}

function dateFromSeconds(seconds: number): Date {
  return new Date(seconds * 1000);
}

export async function registerPolicyVersion(pool: pg.Pool, adapter: PolicyAdapter): Promise<string> {
  const manifest = createPolicyManifest(adapter);
  const inserted = await pool.query<{ id: string }>(
    `
      INSERT INTO policy_versions(policy_id, version, label, adapter_name, source_hash, manifest)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (policy_id, version) DO NOTHING
      RETURNING id
    `,
    [
      manifest.policyId,
      manifest.version,
      manifest.label,
      manifest.adapterName,
      manifest.sourceHash,
      JSON.stringify(manifest)
    ]
  );
  const insertedRow = inserted.rows[0];
  if (insertedRow !== undefined) {
    return insertedRow.id;
  }
  const existing = await pool.query<{ readonly id: string; readonly source_hash: string }>(
    "SELECT id, source_hash FROM policy_versions WHERE policy_id = $1 AND version = $2",
    [manifest.policyId, manifest.version]
  );
  const row = existing.rows[0];
  if (row === undefined || row.source_hash !== manifest.sourceHash) {
    throw new Error("POLICY_VERSION_IMMUTABLE_CONFLICT");
  }
  return row.id;
}

export async function getPolicyManifest(pool: pg.Pool, policyVersionId: string): Promise<PolicyManifest> {
  const result = await pool.query<{ manifest: PolicyManifest }>(
    "SELECT manifest FROM policy_versions WHERE id = $1",
    [policyVersionId]
  );
  const manifest = result.rows[0]?.manifest;
  if (manifest === undefined) {
    throw new Error(`Policy version ${policyVersionId} not found`);
  }
  return manifest;
}

async function loadExperiment(pool: pg.Pool, experimentId: string): Promise<ExperimentRecord> {
  const result = await pool.query<{
    id: string;
    decision_offset_sec: number;
    risk_hash: string;
    policies: unknown;
  }>(
    `
      WITH base AS (
        SELECT
          e.id,
          e.decision_offset_sec,
          e.active_configuration_id,
          COALESCE(
            r.envelope_hash,
            encode(digest(COALESCE(ecv.config->>'riskEnvelopeId', 'WATCH_ONLY_BOUNDED'), 'sha256'), 'hex')
          ) AS risk_hash,
          e.policy_a_id,
          e.policy_b_id
        FROM experiments e
        LEFT JOIN risk_envelopes r ON r.id = e.risk_envelope_id
        LEFT JOIN experiment_configuration_versions ecv ON ecv.id = e.active_configuration_id
        WHERE e.id = $1
      ),
      interactive_policies AS (
        SELECT
          base.id,
          jsonb_agg(
            jsonb_build_object(
              'id', pv.id,
              'policyId', pv.policy_id,
              'version', pv.version,
              'sourceHash', pv.source_hash
            )
            ORDER BY epv.role
          ) FILTER (WHERE pv.id IS NOT NULL) AS policies
        FROM base
        LEFT JOIN experiment_policy_versions epv ON epv.configuration_id = base.active_configuration_id
        LEFT JOIN policy_versions pv ON pv.id = epv.policy_version_id
        GROUP BY base.id
      ),
      legacy_policies AS (
        SELECT
          base.id,
          jsonb_agg(
            jsonb_build_object(
              'id', pv.id,
              'policyId', pv.policy_id,
              'version', pv.version,
              'sourceHash', pv.source_hash
            )
            ORDER BY pv.policy_id
          ) FILTER (WHERE pv.id IS NOT NULL) AS policies
        FROM base
        LEFT JOIN policy_versions pv ON pv.id IN (base.policy_a_id, base.policy_b_id)
        GROUP BY base.id
      )
      SELECT
        base.id,
        base.decision_offset_sec,
        base.risk_hash,
        COALESCE(interactive_policies.policies, legacy_policies.policies, '[]'::jsonb) AS policies
      FROM base
      LEFT JOIN interactive_policies ON interactive_policies.id = base.id
      LEFT JOIN legacy_policies ON legacy_policies.id = base.id
    `,
    [experimentId]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`Experiment ${experimentId} not found`);
  }
  const policies = Array.isArray(row.policies)
    ? row.policies.filter((policy): policy is ExperimentRecord["policies"][number] => {
        if (typeof policy !== "object" || policy === null) {
          return false;
        }
        const maybe = policy as Record<string, unknown>;
        return (
          typeof maybe.id === "string" &&
          typeof maybe.policyId === "string" &&
          typeof maybe.version === "string" &&
          typeof maybe.sourceHash === "string"
        );
      })
    : [];
  if (policies.length === 0) {
    throw new Error(`Experiment ${experimentId} has no policy versions`);
  }
  return {
    id: row.id,
    decision_offset_sec: row.decision_offset_sec,
    risk_hash: row.risk_hash,
    policies
  };
}

async function ensureEpisode(
  pool: pg.Pool,
  experimentId: string,
  market: DreamDexMarketEvidence
): Promise<EpisodeRecord> {
  const existing = await pool.query<EpisodeRecord>(
    "SELECT id, expires_at FROM market_episodes WHERE experiment_id = $1 AND market_id = $2",
    [experimentId, market.stableMarketId]
  );
  const existingRow = existing.rows[0];
  if (existingRow !== undefined) {
    return existingRow;
  }
  const inserted = await pool.query<EpisodeRecord>(
    `
      INSERT INTO market_episodes(
        experiment_id, market_id, asset, interval_seconds, pool_address, market_nonce,
        trading_starts_at, expires_at, source_observed_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, expires_at
    `,
    [
      experimentId,
      market.stableMarketId,
      market.asset,
      market.intervalSeconds ?? 0,
      market.poolAddress,
      market.nonce ?? "0",
      dateFromSeconds(market.tradingStartSeconds),
      dateFromSeconds(market.expirySeconds),
      market.source.retrievedAt
    ]
  );
  const row = inserted.rows[0];
  if (row === undefined) {
    throw new Error("Episode insert did not return a row");
  }
  return row;
}

async function loadSnapshot(pool: pg.Pool, episodeId: string): Promise<SnapshotRecord | null> {
  const result = await pool.query<SnapshotRecord>(
    `
      SELECT id, snapshot_hash, payload
      FROM market_snapshots
      WHERE episode_id = $1
      ORDER BY created_at ASC
      LIMIT 1
    `,
    [episodeId]
  );
  return result.rows[0] ?? null;
}

async function insertSnapshot(
  pool: pg.Pool,
  episodeId: string,
  snapshot: DreamDexSnapshotEvidence
): Promise<SnapshotRecord> {
  const domainSnapshot = toDomainSnapshot(snapshot);
  const snapshotHash = sha256(domainSnapshot);
  const payload = {
    domainSnapshot,
    dreamDexSnapshot: snapshot
  };
  const result = await pool.query<SnapshotRecord>(
    `
      INSERT INTO market_snapshots(
        episode_id, chain_id, captured_at, snapshot_hash, evidence_class, payload
      )
      VALUES ($1, 50312, $2, $3, $4, $5::jsonb)
      ON CONFLICT (snapshot_hash) DO UPDATE
      SET snapshot_hash = EXCLUDED.snapshot_hash
      RETURNING id, snapshot_hash, payload
    `,
    [
      episodeId,
      domainSnapshot.capturedAt,
      snapshotHash,
      domainSnapshot.source.evidenceClass,
      JSON.stringify(payload)
    ]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Snapshot insert did not return a row");
  }
  return row;
}

function snapshotFromPayload(row: SnapshotRecord): MarketSnapshot {
  const payload = row.payload as { readonly domainSnapshot?: unknown };
  return MarketSnapshotSchema.parse(payload.domainSnapshot);
}

async function insertDecision(input: {
  readonly pool: pg.Pool;
  readonly experiment: ExperimentRecord;
  readonly episodeId: string;
  readonly snapshot: SnapshotRecord;
  readonly adapter: PolicyAdapter;
  readonly policyVersionId: string;
  readonly now: Date;
}): Promise<boolean> {
  const domainSnapshot = snapshotFromPayload(input.snapshot);
  const decision = evaluatePolicy(input.adapter, {
    snapshot: domainSnapshot,
    decidedAt: input.now.toISOString(),
    snapshotHash: input.snapshot.snapshot_hash
  });
  const result = await input.pool.query<{ id: string }>(
    `
      INSERT INTO shadow_decisions(
        experiment_id, episode_id, policy_version_id, snapshot_id, decision_offset_sec,
        forecast_p_up, action, proposal, reason_codes, decided_at, policy_hash, risk_hash
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
      ON CONFLICT (experiment_id, policy_version_id, episode_id, decision_offset_sec) DO NOTHING
      RETURNING id
    `,
    [
      input.experiment.id,
      input.episodeId,
      input.policyVersionId,
      input.snapshot.id,
      input.experiment.decision_offset_sec,
      decision.forecastPUp,
      decision.action,
      JSON.stringify({ evidenceClass: "CAPTURED", executionEvidence: "NOT_EVALUATED" }),
      decision.reasonCodes,
      input.now.toISOString(),
      decision.policyHash,
      input.experiment.risk_hash
    ]
  );
  return (result.rowCount ?? 0) > 0;
}

async function observeMarket(input: {
  readonly pool: pg.Pool;
  readonly dreamDexClient: DreamDexSdkClient;
  readonly dreamDexConfig: DreamDexReadConfig;
  readonly market: DreamDexMarketEvidence;
  readonly experiment: ExperimentRecord;
  readonly adapters: ReadonlyMap<string, PolicyAdapter>;
  readonly now: Date;
  readonly depth: number;
}): Promise<ObservedEpisodeResult> {
  const episode = await ensureEpisode(input.pool, input.experiment.id, input.market);
  if (input.now >= episode.expires_at) {
    await input.pool.query(
      "UPDATE market_episodes SET state = 'EXCLUDED', exclusion_reason = 'MARKET_ALREADY_EXPIRED' WHERE id = $1 AND state <> 'DECISION_RECORDED'",
      [episode.id]
    );
    return {
      marketId: input.market.stableMarketId,
      episodeId: episode.id,
      snapshotId: null,
      insertedDecisionCount: 0,
      reusedDecisionCount: 0,
      skipped: true,
      reasonCode: "MARKET_ALREADY_EXPIRED"
    };
  }

  let snapshot = await loadSnapshot(input.pool, episode.id);
  if (snapshot === null) {
    const captured = await captureMarketSnapshot(
      input.dreamDexClient,
      input.dreamDexConfig,
      input.market.stableMarketId,
      input.depth
    );
    if (!captured.ok) {
      return {
        marketId: input.market.stableMarketId,
        episodeId: episode.id,
        snapshotId: null,
        insertedDecisionCount: 0,
        reusedDecisionCount: 0,
        skipped: true,
        reasonCode: "SNAPSHOT_READ_FAILED"
      };
    }
    snapshot = await insertSnapshot(input.pool, episode.id, captured.value);
  }

  let insertedDecisionCount = 0;
  let reusedDecisionCount = 0;
  for (const policy of input.experiment.policies) {
    const adapter = input.adapters.get(adapterKey(policy.policyId, policy.version));
    if (adapter === undefined) {
      return {
        marketId: input.market.stableMarketId,
        episodeId: episode.id,
        snapshotId: snapshot.id,
        insertedDecisionCount,
        reusedDecisionCount,
        skipped: true,
        reasonCode: "POLICY_ADAPTER_MISSING"
      };
    }
    const inserted = await insertDecision({
      pool: input.pool,
      experiment: input.experiment,
      episodeId: episode.id,
      snapshot,
      adapter,
      policyVersionId: policy.id,
      now: input.now
    });
    if (inserted) {
      insertedDecisionCount += 1;
    } else {
      reusedDecisionCount += 1;
    }
  }

  await input.pool.query("UPDATE market_episodes SET state = 'DECISION_RECORDED' WHERE id = $1", [
    episode.id
  ]);
  return {
    marketId: input.market.stableMarketId,
    episodeId: episode.id,
    snapshotId: snapshot.id,
    insertedDecisionCount,
    reusedDecisionCount,
    skipped: false
  };
}

export async function observeExperiment(input: ObserveExperimentInput): Promise<ObserveExperimentResult> {
  const lease = await acquireLease(
    input.pool,
    `observe:${input.experimentId}`,
    input.holderId,
    input.leaseTtlMs ?? 30_000
  );
  if (!lease.acquired) {
    return {
      leaseAcquired: false,
      holderId: lease.holderId,
      discoveredMarketCount: 0,
      observed: []
    };
  }

  const discoveryOptions: { assets?: readonly ("BTC" | "ETH")[]; intervals?: readonly number[] } = {};
  if (input.assets !== undefined) {
    discoveryOptions.assets = input.assets;
  }
  if (input.intervals !== undefined) {
    discoveryOptions.intervals = input.intervals;
  }
  const discovered = await discoverSuccessorMarkets(input.dreamDexClient, input.dreamDexConfig, discoveryOptions);
  if (!discovered.ok) {
    await appendAuditEvent(input.pool, {
      actor: "worker",
      action: "OBSERVE_EXPERIMENT",
      targetType: "experiment",
      targetId: input.experimentId,
      outcome: discovered.reasonCode,
      correlationId: input.holderId,
      safeMetadata: { message: discovered.message }
    });
    return {
      leaseAcquired: true,
      holderId: lease.holderId,
      discoveredMarketCount: 0,
      observed: []
    };
  }

  const experiment = await loadExperiment(input.pool, input.experimentId);
  const adapters = new Map(input.policyAdapters.map((adapter) => [adapterKey(adapter.policyId, adapter.version), adapter]));
  const now = input.clock?.now() ?? new Date();
  const observed: ObservedEpisodeResult[] = [];
  for (const market of discovered.value) {
    observed.push(
      await observeMarket({
        pool: input.pool,
        dreamDexClient: input.dreamDexClient,
        dreamDexConfig: input.dreamDexConfig,
        market,
        experiment,
        adapters,
        now,
        depth: input.depth ?? 10
      })
    );
  }
  await appendAuditEvent(input.pool, {
    actor: "worker",
    action: "OBSERVE_EXPERIMENT",
    targetType: "experiment",
    targetId: input.experimentId,
    outcome: "PASS",
    correlationId: input.holderId,
    safeMetadata: {
      discoveredMarketCount: discovered.value.length,
      observedCount: observed.length
    }
  });

  return {
    leaseAcquired: true,
    holderId: lease.holderId,
    discoveredMarketCount: discovered.value.length,
    observed
  };
}
