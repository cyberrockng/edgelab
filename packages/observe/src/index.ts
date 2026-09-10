import { createHash } from "node:crypto";
import type pg from "pg";
import { acquireLease, appendAuditEvent } from "@edgelab/db";
import { MarketSnapshotSchema, SOMNIA_SHANNON_CHAIN_ID, type MarketSnapshot, type PolicyDecision } from "@edgelab/domain";
import {
  captureMarketSnapshot,
  discoverSuccessorMarkets,
  planExecutableQuote,
  readBinaryBookParams,
  type DreamDexMarketEvidence,
  type DreamDexReadConfig,
  type DreamDexReadResult,
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
  readonly reasonCode?:
    | "DECISION_WINDOW_NOT_OPEN"
    | "DECISION_WINDOW_MISSED"
    | "MARKET_ALREADY_EXPIRED"
    | "SNAPSHOT_READ_FAILED"
    | "POLICY_ADAPTER_MISSING";
}

export interface ObserveExperimentResult {
  readonly leaseAcquired: boolean;
  readonly holderId: string;
  readonly discoveredMarketCount: number;
  readonly observed: readonly ObservedEpisodeResult[];
  readonly discoveryIssue?: Omit<Extract<DreamDexReadResult<never>, { readonly ok: false }>, "ok">;
}

interface ExperimentRecord {
  readonly id: string;
  readonly decision_offset_sec: number;
  readonly risk_hash: string;
  readonly rule_version: string | null;
  readonly protocol: {
    readonly id: string;
    readonly manifestHash: string;
    readonly windowFrom: Date;
    readonly windowTo: Date;
  } | null;
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
    quoteDecimals: snapshot.market.quoteDecimals,
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
    },
    marketWindow: {
      tradingStartSeconds: snapshot.market.tradingStartSeconds,
      expirySeconds: snapshot.market.expirySeconds
    },
    ...(snapshot.market.lastPriceRaw === null || snapshot.market.lastTradeAtSeconds === null
      ? {}
      : {
          lastTrade: {
            priceRaw: snapshot.market.lastPriceRaw,
            timestampSeconds: snapshot.market.lastTradeAtSeconds
          }
        })
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
    rule_version: string | null;
    protocol_id: string | null;
    manifest_hash: string | null;
    window_from: Date | null;
    window_to: Date | null;
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
          e.policy_b_id,
          ecv.rule_version
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
        base.rule_version,
        op.id AS protocol_id,
        op.manifest_hash,
        op.window_from,
        op.window_to,
        COALESCE(interactive_policies.policies, legacy_policies.policies, '[]'::jsonb) AS policies
      FROM base
      LEFT JOIN interactive_policies ON interactive_policies.id = base.id
      LEFT JOIN legacy_policies ON legacy_policies.id = base.id
      LEFT JOIN observation_protocols op ON op.configuration_id = base.active_configuration_id
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
    rule_version: row.rule_version,
    protocol: row.protocol_id === null || row.manifest_hash === null || row.window_from === null || row.window_to === null ? null : {
      id: row.protocol_id,
      manifestHash: row.manifest_hash,
      windowFrom: row.window_from,
      windowTo: row.window_to
    },
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

async function loadSnapshot(
  pool: pg.Pool,
  episodeId: string,
  decisionWindowOpensAt: Date,
  expiresAt: Date
): Promise<SnapshotRecord | null> {
  const result = await pool.query<SnapshotRecord>(
    `
      SELECT id, snapshot_hash, payload
      FROM market_snapshots
      WHERE episode_id = $1
        AND captured_at >= $2
        AND captured_at < $3
      ORDER BY created_at ASC
      LIMIT 1
    `,
    [episodeId, decisionWindowOpensAt, expiresAt]
  );
  return result.rows[0] ?? null;
}

function forwardDecisionWindowOpensAt(market: DreamDexMarketEvidence, decisionOffsetSec: number): Date {
  return dateFromSeconds(
    Math.max(market.tradingStartSeconds + 1, market.expirySeconds - decisionOffsetSec)
  );
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
  readonly decidedAt?: string;
}): Promise<{ readonly inserted: boolean; readonly decision: PolicyDecision }> {
  const domainSnapshot = snapshotFromPayload(input.snapshot);
  const decision = evaluatePolicy(input.adapter, {
    snapshot: domainSnapshot,
    decidedAt: input.decidedAt ?? domainSnapshot.capturedAt,
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
      decision.decidedAt,
      decision.policyHash,
      input.experiment.risk_hash
    ]
  );
  return { inserted: (result.rowCount ?? 0) > 0, decision };
}

function primaryBookBaseline(snapshot: MarketSnapshot): { readonly probability: number; readonly bidRaw: string; readonly askRaw: string } | null {
  const positiveBids = snapshot.book.bids.filter((level) => /^\d+$/.test(level.priceRaw) && /^\d+$/.test(level.quantityRaw) && BigInt(level.quantityRaw) > 0n);
  const positiveAsks = snapshot.book.asks.filter((level) => /^\d+$/.test(level.priceRaw) && /^\d+$/.test(level.quantityRaw) && BigInt(level.quantityRaw) > 0n);
  if (positiveBids.length === 0 || positiveAsks.length === 0) return null;
  const bidRaw = positiveBids.reduce((best, level) => BigInt(level.priceRaw) > BigInt(best.priceRaw) ? level : best).priceRaw;
  const askRaw = positiveAsks.reduce((best, level) => BigInt(level.priceRaw) < BigInt(best.priceRaw) ? level : best).priceRaw;
  if (BigInt(bidRaw) > BigInt(askRaw)) return null;
  const scale = 10n ** BigInt(snapshot.quoteDecimals);
  const midpointNumerator = BigInt(bidRaw) + BigInt(askRaw);
  const probability = Number(midpointNumerator) / Number(2n * scale);
  return Number.isFinite(probability) && probability >= 0 && probability <= 1 ? { probability, bidRaw, askRaw } : null;
}

async function persistPairedRecord(input: {
  readonly pool: pg.Pool;
  readonly experiment: ExperimentRecord;
  readonly market: DreamDexMarketEvidence;
  readonly snapshot: SnapshotRecord;
  readonly policyVersionId: string;
  readonly decision: PolicyDecision;
  readonly candidateReceivedAt: string;
  readonly deadline: Date;
  readonly dreamDexClient: DreamDexSdkClient;
  readonly dreamDexConfig: DreamDexReadConfig;
}): Promise<void> {
  if (input.experiment.protocol === null) return;
  const domainSnapshot = snapshotFromPayload(input.snapshot);
  const baseline = primaryBookBaseline(domainSnapshot);
  const run = await input.pool.query<{ id: string }>(
    `SELECT id FROM campaign_runs WHERE protocol_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [input.experiment.protocol.id]
  );
  const campaignRunId = run.rows[0]?.id;
  if (campaignRunId === undefined) throw new Error("V4 campaign run is missing");
  const paired = await input.pool.query<{ id: string }>(
    `
      INSERT INTO paired_forecast_records(
        protocol_id, campaign_run_id, candidate_policy_version_id, chain_id, venue_id,
        market_generation_id, asset, interval_sec, decision_offset_sec, snapshot_hash,
        snapshot_source, candidate_probability, baseline_probability, baseline_bid_raw,
        baseline_ask_raw, quote_decimals, captured_at, decision_deadline,
        candidate_received_at, action, inclusion_reason, integrity_status
      ) VALUES ($1,$2,$3,50312,'dreamdex-event-contracts',$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb)
      ON CONFLICT (chain_id, venue_id, market_generation_id, decision_offset_sec, candidate_policy_version_id, protocol_id)
      DO NOTHING
      RETURNING id
    `,
    [
      input.experiment.protocol.id, campaignRunId, input.policyVersionId, input.market.stableMarketId,
      input.market.asset, input.market.intervalSeconds ?? 0, input.experiment.decision_offset_sec,
      input.snapshot.snapshot_hash, JSON.stringify(domainSnapshot.source), input.decision.forecastPUp,
      baseline?.probability ?? null, baseline?.bidRaw ?? null, baseline?.askRaw ?? null,
      domainSnapshot.quoteDecimals, domainSnapshot.capturedAt, input.deadline, input.candidateReceivedAt,
      input.decision.action, baseline === null ? "MISSING_PRIMARY_TWO_SIDED_BASELINE" : "PAIRED_PRIMARY_BASELINE",
      JSON.stringify({ internallyReproducible: true, externallyTimeAnchored: false, completenessChecked: false })
    ]
  );
  const pairedRecordId = paired.rows[0]?.id ?? (await input.pool.query<{ id: string }>(
    `SELECT id FROM paired_forecast_records
      WHERE chain_id=50312 AND venue_id='dreamdex-event-contracts' AND market_generation_id=$1
        AND decision_offset_sec=$2 AND candidate_policy_version_id=$3 AND protocol_id=$4`,
    [input.market.stableMarketId, input.experiment.decision_offset_sec, input.policyVersionId, input.experiment.protocol.id]
  )).rows[0]?.id;
  if (pairedRecordId === undefined) throw new Error("Paired forecast persistence failed");
  const captured = (input.snapshot.payload as { readonly dreamDexSnapshot?: DreamDexSnapshotEvidence }).dreamDexSnapshot;
  if (captured === undefined) throw new Error("Captured executable book is missing from the paired snapshot");
  const scale = 10n ** BigInt(domainSnapshot.quoteDecimals);
  const side = input.decision.forecastPUp >= .5 ? "BUY_YES" : "BUY_NO";
  const rawLevels = (side === "BUY_YES" ? captured.book.yesAsks : captured.book.noAsks).flatMap((level) => {
    const venuePrice = BigInt(level.priceRaw);
    const economicPrice = side === "BUY_YES" ? venuePrice : scale - venuePrice;
    return economicPrice > 0n && economicPrice <= scale && BigInt(level.quantityRaw) > 0n
      ? [{ priceRaw: economicPrice.toString(), quantityRaw: level.quantityRaw, venuePriceRaw: level.priceRaw }]
      : [];
  });
  const params = await readBinaryBookParams(input.dreamDexClient, input.dreamDexConfig, input.market.poolAddress);
  const fixedBankrollRaw = (100n * scale).toString();
  const perWindowBudgetRaw = scale.toString();
  const stressAddend = scale / 100n;
  let scenarioAction: "TRADE" | "NO_TRADE" | "SOURCE_UNAVAILABLE" = "SOURCE_UNAVAILABLE";
  let primaryPlan: ReturnType<typeof planExecutableQuote> | null = null;
  let stressPlan: ReturnType<typeof planExecutableQuote> | null = null;
  let sourceReason: string | null = null;
  if (!params.ok) {
    sourceReason = params.reasonCode;
  } else if (rawLevels.length === 0) {
    sourceReason = "NO_EXECUTABLE_CAPTURE_DEPTH";
  } else {
    const sideProbabilityPpm = Math.max(0, Math.min(1_000_000, Math.round((side === "BUY_YES" ? input.decision.forecastPUp : 1 - input.decision.forecastPUp) * 1_000_000)));
    const maximumPassingPricePpm = Math.max(0, sideProbabilityPpm - 50_000 - 10_000 - 10_000);
    const maximumPassingPriceRaw = (((scale * BigInt(maximumPassingPricePpm)) / 1_000_000n) / params.value.tickSize) * params.value.tickSize;
    const common = {
      requestedQuantityRaw: scale.toString(),
      lotSizeRaw: params.value.lotSize.toString(),
      tickSizeRaw: params.value.tickSize.toString(),
      payoutScaleRaw: scale.toString(),
      maxCollateralRaw: perWindowBudgetRaw,
      worstPriceRaw: maximumPassingPriceRaw.toString(),
      sideProbabilityPpm
    };
    try {
      const roundUpToTick = (value: bigint) => ((value + params.value.tickSize - 1n) / params.value.tickSize) * params.value.tickSize;
      const stressedLevels = rawLevels.map((level) => ({
          priceRaw: (roundUpToTick(BigInt(level.priceRaw) + stressAddend) > scale ? scale : roundUpToTick(BigInt(level.priceRaw) + stressAddend)).toString(),
          quantityRaw: level.quantityRaw
      }));
      const stressedCap = roundUpToTick(maximumPassingPriceRaw + stressAddend) > scale
        ? scale
        : roundUpToTick(maximumPassingPriceRaw + stressAddend);
      const provisionalStress = planExecutableQuote({
        ...common, worstPriceRaw: stressedCap.toString(), levels: stressedLevels
      });
      const fixedScenarioQuantityRaw = provisionalStress.fillableQuantityRaw;
      primaryPlan = planExecutableQuote({ ...common, requestedQuantityRaw: fixedScenarioQuantityRaw, levels: rawLevels });
      stressPlan = planExecutableQuote({
        ...common, requestedQuantityRaw: fixedScenarioQuantityRaw,
        worstPriceRaw: stressedCap.toString(), levels: stressedLevels
      });
      scenarioAction = primaryPlan.passesConservativeEdge && BigInt(fixedScenarioQuantityRaw) >= params.value.minQuantity &&
        stressPlan.fillableQuantityRaw === fixedScenarioQuantityRaw
        ? "TRADE"
        : "NO_TRADE";
      sourceReason = scenarioAction === "NO_TRADE" ? primaryPlan.reasonCodes.join(",") : null;
    } catch (error) {
      scenarioAction = "SOURCE_UNAVAILABLE";
      sourceReason = error instanceof Error ? `QUOTE_PLANNER_INVALID_SOURCE:${error.message}` : "QUOTE_PLANNER_INVALID_SOURCE";
    }
  }
  await input.pool.query(
    `INSERT INTO economic_scenario_records(
       paired_record_id,protocol_id,classification,side,scenario_action,raw_levels,book_parameters,
       primary_plan,stress_plan,fixed_bankroll_raw,per_window_budget_raw,stress_price_addend_raw,
       source_reason,captured_at)
     VALUES ($1,$2,'SIMULATED_FROM_CAPTURED_BOOK',$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13)
     ON CONFLICT (paired_record_id) DO NOTHING`,
    [pairedRecordId, input.experiment.protocol.id, side, scenarioAction, JSON.stringify(rawLevels),
      params.ok ? JSON.stringify({ lotSizeRaw: params.value.lotSize.toString(), tickSizeRaw: params.value.tickSize.toString(), minQuantityRaw: params.value.minQuantity.toString() }) : null,
      primaryPlan === null ? null : JSON.stringify(primaryPlan), stressPlan === null ? null : JSON.stringify(stressPlan),
      fixedBankrollRaw, perWindowBudgetRaw, stressAddend.toString(), sourceReason, domainSnapshot.capturedAt]
  );
}

async function observeMarket(input: {
  readonly pool: pg.Pool;
  readonly dreamDexClient: DreamDexSdkClient;
  readonly dreamDexConfig: DreamDexReadConfig;
  readonly market: DreamDexMarketEvidence;
  readonly experiment: ExperimentRecord;
  readonly adapters: ReadonlyMap<string, PolicyAdapter>;
  readonly now: Date;
  readonly clockNow?: () => Date;
  readonly depth: number;
}): Promise<ObservedEpisodeResult> {
  const episode = await ensureEpisode(input.pool, input.experiment.id, input.market);
  const decisionDeadline = dateFromSeconds(input.market.expirySeconds - input.experiment.decision_offset_sec);
  const isV4 = input.experiment.rule_version === "edgelab-evaluation-v4" && input.experiment.protocol !== null;
  const decisionWindowOpensAt = isV4
    ? new Date(decisionDeadline.getTime() - 5_000)
    : forwardDecisionWindowOpensAt(input.market, input.experiment.decision_offset_sec);
  const decisionWindowClosesAt = isV4 ? decisionDeadline : episode.expires_at;
  const protocol = input.experiment.protocol;
  if (isV4 && protocol !== null && (input.now < protocol.windowFrom || input.now >= protocol.windowTo)) {
    return {
      marketId: input.market.stableMarketId, episodeId: episode.id, snapshotId: null,
      insertedDecisionCount: 0, reusedDecisionCount: 0, skipped: true, reasonCode: "DECISION_WINDOW_NOT_OPEN"
    };
  }
  if (input.now < decisionWindowOpensAt) {
    return {
      marketId: input.market.stableMarketId,
      episodeId: episode.id,
      snapshotId: null,
      insertedDecisionCount: 0,
      reusedDecisionCount: 0,
      skipped: true,
      reasonCode: "DECISION_WINDOW_NOT_OPEN"
    };
  }
  if (input.now >= decisionWindowClosesAt) {
    await input.pool.query(
      "UPDATE market_episodes SET state = 'EXCLUDED', exclusion_reason = $2 WHERE id = $1 AND state <> 'DECISION_RECORDED'",
      [episode.id, isV4 ? "DECISION_WINDOW_MISSED" : "MARKET_ALREADY_EXPIRED"]
    );
    return {
      marketId: input.market.stableMarketId,
      episodeId: episode.id,
      snapshotId: null,
      insertedDecisionCount: 0,
      reusedDecisionCount: 0,
      skipped: true,
      reasonCode: isV4 ? "DECISION_WINDOW_MISSED" : "MARKET_ALREADY_EXPIRED"
    };
  }

  let snapshot = await loadSnapshot(
    input.pool,
    episode.id,
    decisionWindowOpensAt,
    decisionWindowClosesAt
  );
  if (snapshot === null) {
    const captured = await captureMarketSnapshot(
      input.dreamDexClient,
      input.dreamDexConfig,
      input.market.stableMarketId,
      input.depth,
      input.clockNow?.().toISOString()
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
    const capturedAt = new Date(captured.value.market.source.retrievedAt);
    if (capturedAt < decisionWindowOpensAt) {
      return {
        marketId: input.market.stableMarketId,
        episodeId: episode.id,
        snapshotId: null,
        insertedDecisionCount: 0,
        reusedDecisionCount: 0,
        skipped: true,
        reasonCode: "DECISION_WINDOW_NOT_OPEN"
      };
    }
    if (capturedAt >= decisionWindowClosesAt) {
      await input.pool.query(
        "UPDATE market_episodes SET state = 'EXCLUDED', exclusion_reason = 'DECISION_WINDOW_MISSED' WHERE id = $1 AND state <> 'DECISION_RECORDED'",
        [episode.id]
      );
      return {
        marketId: input.market.stableMarketId,
        episodeId: episode.id,
        snapshotId: null,
        insertedDecisionCount: 0,
        reusedDecisionCount: 0,
        skipped: true,
        reasonCode: "DECISION_WINDOW_MISSED"
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
    const candidateReceivedAt = (input.clockNow?.() ?? new Date()).toISOString();
    if (isV4 && new Date(candidateReceivedAt) >= decisionDeadline) {
      await input.pool.query("UPDATE market_episodes SET state = 'EXCLUDED', exclusion_reason = 'CANDIDATE_RECEIVED_LATE' WHERE id = $1", [episode.id]);
      return { marketId: input.market.stableMarketId, episodeId: episode.id, snapshotId: snapshot.id, insertedDecisionCount, reusedDecisionCount, skipped: true, reasonCode: "DECISION_WINDOW_MISSED" };
    }
    const inserted = await insertDecision({
      pool: input.pool,
      experiment: input.experiment,
      episodeId: episode.id,
      snapshot,
      adapter,
      policyVersionId: policy.id,
      decidedAt: candidateReceivedAt
    });
    await persistPairedRecord({
      pool: input.pool, experiment: input.experiment, market: input.market, snapshot,
      policyVersionId: policy.id, decision: inserted.decision, candidateReceivedAt, deadline: decisionDeadline,
      dreamDexClient: input.dreamDexClient, dreamDexConfig: input.dreamDexConfig
    });
    if (inserted.inserted) {
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
      observed: [],
      discoveryIssue: {
        reasonCode: discovered.reasonCode,
        message: discovered.message
      }
    };
  }

  const experiment = await loadExperiment(input.pool, input.experimentId);
  const adapters = new Map(input.policyAdapters.map((adapter) => [adapterKey(adapter.policyId, adapter.version), adapter]));
  const clock = input.clock;
  const now = clock?.now() ?? new Date();
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
        ...(clock === undefined ? {} : { clockNow: () => clock.now() }),
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
