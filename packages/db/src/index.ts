import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

export interface DbConfig {
  readonly connectionString: string;
  readonly max?: number;
  readonly statementTimeoutMs?: number;
}

export interface MigrationResult {
  readonly version: string;
  readonly applied: boolean;
  readonly sha256: string;
}

export interface LeaseResult {
  readonly acquired: boolean;
  readonly holderId: string;
  readonly expiresAt: Date;
}

export interface ResearchSessionRecord {
  readonly id: string;
  readonly tokenHash: string;
  readonly csrfHash: string;
  readonly csrfVersion: number;
  readonly expiresAt: Date;
}

export interface ExperimentConfigurationInput {
  readonly mode: "HISTORICAL_REPLAY" | "LIVE_SHADOW";
  readonly assets: readonly ("BTC" | "ETH")[];
  readonly intervals: readonly number[];
  readonly windowFrom?: Date | null;
  readonly windowTo?: Date | null;
  readonly decisionOffsetSec: number;
  readonly riskEnvelopeId?: string | null;
  readonly ruleVersion: string;
  readonly config: Record<string, unknown>;
  readonly configHash: string;
}

export interface InteractiveExperimentRecord {
  readonly experimentId: string;
  readonly configurationId: string;
  readonly version: number;
  readonly idempotentReplay: boolean;
}

export interface InteractiveExperimentDetailRecord {
  readonly experimentId: string;
  readonly name: string;
  readonly status: string;
  readonly visibility: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly configuration: {
    readonly id: string;
    readonly version: number;
    readonly mode: "HISTORICAL_REPLAY" | "LIVE_SHADOW";
    readonly assets: readonly string[];
    readonly intervals: readonly number[];
    readonly windowFrom: Date | null;
    readonly windowTo: Date | null;
    readonly decisionOffsetSec: number;
    readonly riskEnvelopeId: string | null;
    readonly ruleVersion: string;
    readonly config: Record<string, unknown>;
    readonly configHash: string;
  };
  readonly policies: readonly {
    readonly role: string;
    readonly policyVersionId: string;
    readonly policyId: string;
    readonly version: string;
    readonly label: string;
    readonly adapterName: string;
    readonly sourceHash: string;
  }[];
}

export function createPool(config: DbConfig): pg.Pool {
  return new Pool({
    connectionString: config.connectionString,
    max: config.max ?? 10,
    statement_timeout: config.statementTimeoutMs ?? 5000
  });
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

async function readMigration(version: string): Promise<string> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, "..", "migrations", `${version}.sql`),
    join(moduleDir, "..", "..", "migrations", `${version}.sql`)
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Migration ${version} not found`);
}

export const migrations = [
  "0001_initial_schema",
  "0002_interactive_product",
  "0003_book_reconstruction_source_incomplete",
  "0004_experiment_create_idempotency"
] as const;

export async function runMigrations(pool: pg.Pool): Promise<MigrationResult[]> {
  const results: MigrationResult[] = [];
  for (const version of migrations) {
    const sql = await readMigration(version);
    const hash = sha256(sql);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'))"
      );
      const existing = await client.query<{ sha256: string }>(
        "SELECT sha256 FROM schema_migrations WHERE version = $1",
        [version]
      );
      if (existing.rowCount !== null && existing.rowCount > 0) {
        if (existing.rows[0]?.sha256 !== hash) {
          throw new Error(`Migration hash mismatch for ${version}`);
        }
        await client.query("COMMIT");
        results.push({ version, applied: false, sha256: hash });
        continue;
      }
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version, sha256) VALUES ($1, $2)", [
        version,
        hash
      ]);
      await client.query("COMMIT");
      results.push({ version, applied: true, sha256: hash });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return results;
}

export async function acquireLease(
  pool: pg.Pool,
  leaseKey: string,
  holderId: string,
  ttlMs: number
): Promise<LeaseResult> {
  const result = await pool.query<{ holder_id: string; expires_at: Date }>(
    `
      INSERT INTO worker_leases (lease_key, holder_id, expires_at)
      VALUES ($1, $2, now() + ($3::text || ' milliseconds')::interval)
      ON CONFLICT (lease_key) DO UPDATE
      SET holder_id = EXCLUDED.holder_id,
          expires_at = EXCLUDED.expires_at,
          renewed_at = now()
      WHERE worker_leases.expires_at <= now() OR worker_leases.holder_id = EXCLUDED.holder_id
      RETURNING holder_id, expires_at
    `,
    [leaseKey, holderId, ttlMs]
  );
  const row = result.rows[0];
  if (row === undefined) {
    const current = await pool.query<{ holder_id: string; expires_at: Date }>(
      "SELECT holder_id, expires_at FROM worker_leases WHERE lease_key = $1",
      [leaseKey]
    );
    const currentRow = current.rows[0];
    if (currentRow === undefined) {
      throw new Error(`Lease ${leaseKey} was not returned and no current lease exists`);
    }
    return {
      acquired: false,
      holderId: currentRow.holder_id,
      expiresAt: currentRow.expires_at
    };
  }
  return {
    acquired: row.holder_id === holderId,
    holderId: row.holder_id,
    expiresAt: row.expires_at
  };
}

export async function appendAuditEvent(
  pool: pg.Pool,
  input: {
    readonly actor: string;
    readonly action: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly outcome: string;
    readonly correlationId: string;
    readonly safeMetadata?: Record<string, unknown>;
  }
): Promise<string> {
  const previous = await pool.query<{ event_hash: string }>(
    "SELECT event_hash FROM audit_events ORDER BY created_at DESC, id DESC LIMIT 1"
  );
  const previousHash = previous.rows[0]?.event_hash ?? null;
  const payload = {
    ...input,
    previousHash,
    safeMetadata: input.safeMetadata ?? {}
  };
  const eventHash = sha256(JSON.stringify(payload));
  await pool.query(
    `
      INSERT INTO audit_events
        (actor, action, target_type, target_id, outcome, correlation_id, safe_metadata, previous_hash, event_hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
    `,
    [
      input.actor,
      input.action,
      input.targetType,
      input.targetId,
      input.outcome,
      input.correlationId,
      JSON.stringify(input.safeMetadata ?? {}),
      previousHash,
      eventHash
    ]
  );
  return eventHash;
}

export async function createResearchSession(
  pool: pg.Pool,
  input: {
    readonly tokenHash: string;
    readonly csrfHash: string;
    readonly expiresAt: Date;
    readonly csrfVersion?: number;
  }
): Promise<ResearchSessionRecord> {
  const result = await pool.query<{
    id: string;
    token_hash: string;
    csrf_hash: string;
    csrf_version: number;
    expires_at: Date;
  }>(
    `
      INSERT INTO research_sessions(token_hash, csrf_hash, csrf_version, expires_at)
      VALUES ($1, $2, $3, $4)
      RETURNING id, token_hash, csrf_hash, csrf_version, expires_at
    `,
    [input.tokenHash, input.csrfHash, input.csrfVersion ?? 1, input.expiresAt]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("research session was not created");
  }
  return {
    id: row.id,
    tokenHash: row.token_hash,
    csrfHash: row.csrf_hash,
    csrfVersion: row.csrf_version,
    expiresAt: row.expires_at
  };
}

export async function findActiveResearchSessionByTokenHash(
  pool: pg.Pool,
  tokenHash: string
): Promise<ResearchSessionRecord | null> {
  const result = await pool.query<{
    id: string;
    token_hash: string;
    csrf_hash: string;
    csrf_version: number;
    expires_at: Date;
  }>(
    `
      SELECT id, token_hash, csrf_hash, csrf_version, expires_at
      FROM research_sessions
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > now()
    `,
    [tokenHash]
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    id: row.id,
    tokenHash: row.token_hash,
    csrfHash: row.csrf_hash,
    csrfVersion: row.csrf_version,
    expiresAt: row.expires_at
  };
}

export async function rotateResearchSessionCsrf(
  pool: pg.Pool,
  input: {
    readonly sessionId: string;
    readonly csrfHash: string;
  }
): Promise<ResearchSessionRecord | null> {
  const result = await pool.query<{
    id: string;
    token_hash: string;
    csrf_hash: string;
    csrf_version: number;
    expires_at: Date;
  }>(
    `
      UPDATE research_sessions
      SET csrf_hash = $2,
          csrf_version = csrf_version + 1,
          last_seen_at = now()
      WHERE id = $1
        AND revoked_at IS NULL
        AND expires_at > now()
      RETURNING id, token_hash, csrf_hash, csrf_version, expires_at
    `,
    [input.sessionId, input.csrfHash]
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    id: row.id,
    tokenHash: row.token_hash,
    csrfHash: row.csrf_hash,
    csrfVersion: row.csrf_version,
    expiresAt: row.expires_at
  };
}

export async function upsertPolicyVersion(
  pool: pg.Pool,
  input: {
    readonly policyId: string;
    readonly version: string;
    readonly label: string;
    readonly adapterName: string;
    readonly sourceHash: string;
    readonly manifest: Record<string, unknown>;
  }
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `
      INSERT INTO policy_versions(policy_id, version, label, adapter_name, source_hash, manifest)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (policy_id, version) DO UPDATE
      SET label = EXCLUDED.label,
          adapter_name = EXCLUDED.adapter_name,
          source_hash = EXCLUDED.source_hash,
          manifest = EXCLUDED.manifest
      RETURNING id
    `,
    [
      input.policyId,
      input.version,
      input.label,
      input.adapterName,
      input.sourceHash,
      JSON.stringify(input.manifest)
    ]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("policy version was not upserted");
  }
  return row.id;
}

export async function createInteractiveExperiment(
  pool: pg.Pool,
  input: {
    readonly sessionId: string;
    readonly name: string;
    readonly createIdempotencyKey: string;
    readonly visibility?: "PRIVATE" | "PUBLIC_PROVEN" | "SHARED_LINK";
    readonly configuration: ExperimentConfigurationInput;
    readonly policyVersions?: readonly {
      readonly policyVersionId: string;
      readonly role: "CANDIDATE" | "BENCHMARK";
    }[];
  }
): Promise<InteractiveExperimentRecord> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ id: string; active_configuration_id: string; version: number }>(
      `
        SELECT experiments.id, experiments.active_configuration_id, experiment_configuration_versions.version
        FROM experiments
        JOIN experiment_configuration_versions
          ON experiment_configuration_versions.id = experiments.active_configuration_id
        WHERE experiments.created_by_session_id = $1
          AND experiments.create_idempotency_key = $2
        FOR UPDATE
      `,
      [input.sessionId, input.createIdempotencyKey]
    );
    const existingRow = existing.rows[0];
    if (existingRow !== undefined) {
      await client.query("COMMIT");
      return {
        experimentId: existingRow.id,
        configurationId: existingRow.active_configuration_id,
        version: existingRow.version,
        idempotentReplay: true
      };
    }
    const experiment = await client.query<{ id: string }>(
      `
        INSERT INTO experiments(created_by_session_id, name, visibility, decision_offset_sec, status, create_idempotency_key)
        VALUES ($1, $2, $3, $4, 'DRAFT', $5)
        RETURNING id
      `,
      [
        input.sessionId,
        input.name,
        input.visibility ?? "PRIVATE",
        input.configuration.decisionOffsetSec,
        input.createIdempotencyKey
      ]
    );
    const experimentId = experiment.rows[0]?.id;
    if (experimentId === undefined) {
      throw new Error("experiment was not created");
    }
    const configuration = await client.query<{ id: string; version: number }>(
      `
        INSERT INTO experiment_configuration_versions(
          experiment_id, version, mode, assets, intervals, window_from, window_to,
          decision_offset_sec, risk_envelope_id, rule_version, config, config_hash
        )
        VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
        RETURNING id, version
      `,
      [
        experimentId,
        input.configuration.mode,
        [...input.configuration.assets],
        [...input.configuration.intervals],
        input.configuration.windowFrom ?? null,
        input.configuration.windowTo ?? null,
        input.configuration.decisionOffsetSec,
        input.configuration.riskEnvelopeId ?? null,
        input.configuration.ruleVersion,
        JSON.stringify(input.configuration.config),
        input.configuration.configHash
      ]
    );
    const configurationRow = configuration.rows[0];
    if (configurationRow === undefined) {
      throw new Error("experiment configuration was not created");
    }
    await client.query("UPDATE experiments SET active_configuration_id = $1, updated_at = now() WHERE id = $2", [
      configurationRow.id,
      experimentId
    ]);
    for (const policy of input.policyVersions ?? []) {
      await client.query(
        `
          INSERT INTO experiment_policy_versions(experiment_id, configuration_id, policy_version_id, role)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT DO NOTHING
        `,
        [experimentId, configurationRow.id, policy.policyVersionId, policy.role]
      );
    }
    await client.query("COMMIT");
    return {
      experimentId,
      configurationId: configurationRow.id,
      version: configurationRow.version,
      idempotentReplay: false
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function mapExperimentRow(row: {
  readonly experiment_id: string;
  readonly name: string;
  readonly status: string;
  readonly visibility: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly configuration_id: string;
  readonly configuration_version: number;
  readonly mode: "HISTORICAL_REPLAY" | "LIVE_SHADOW";
  readonly assets: string[];
  readonly intervals: number[];
  readonly window_from: Date | null;
  readonly window_to: Date | null;
  readonly decision_offset_sec: number;
  readonly risk_envelope_id: string | null;
  readonly rule_version: string;
  readonly config: Record<string, unknown>;
  readonly config_hash: string;
  readonly policies: unknown;
}): InteractiveExperimentDetailRecord {
  const policies = Array.isArray(row.policies)
    ? row.policies.filter((policy): policy is InteractiveExperimentDetailRecord["policies"][number] => {
        if (typeof policy !== "object" || policy === null) {
          return false;
        }
        const maybe = policy as Record<string, unknown>;
        return (
          typeof maybe.role === "string" &&
          typeof maybe.policyVersionId === "string" &&
          typeof maybe.policyId === "string" &&
          typeof maybe.version === "string" &&
          typeof maybe.label === "string" &&
          typeof maybe.adapterName === "string" &&
          typeof maybe.sourceHash === "string"
        );
      })
    : [];
  return {
    experimentId: row.experiment_id,
    name: row.name,
    status: row.status,
    visibility: row.visibility,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    configuration: {
      id: row.configuration_id,
      version: row.configuration_version,
      mode: row.mode,
      assets: row.assets,
      intervals: row.intervals,
      windowFrom: row.window_from,
      windowTo: row.window_to,
      decisionOffsetSec: row.decision_offset_sec,
      riskEnvelopeId: row.risk_envelope_id,
      ruleVersion: row.rule_version,
      config: row.config,
      configHash: row.config_hash
    },
    policies
  };
}

const interactiveExperimentSelect = `
  SELECT
    experiments.id AS experiment_id,
    experiments.name,
    experiments.status,
    experiments.visibility,
    experiments.created_at,
    experiments.updated_at,
    experiment_configuration_versions.id AS configuration_id,
    experiment_configuration_versions.version AS configuration_version,
    experiment_configuration_versions.mode,
    experiment_configuration_versions.assets,
    experiment_configuration_versions.intervals,
    experiment_configuration_versions.window_from,
    experiment_configuration_versions.window_to,
    experiment_configuration_versions.decision_offset_sec,
    experiment_configuration_versions.risk_envelope_id,
    experiment_configuration_versions.rule_version,
    experiment_configuration_versions.config,
    experiment_configuration_versions.config_hash,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'role', experiment_policy_versions.role,
          'policyVersionId', policy_versions.id,
          'policyId', policy_versions.policy_id,
          'version', policy_versions.version,
          'label', policy_versions.label,
          'adapterName', policy_versions.adapter_name,
          'sourceHash', policy_versions.source_hash
        )
        ORDER BY experiment_policy_versions.role
      ) FILTER (WHERE policy_versions.id IS NOT NULL),
      '[]'::jsonb
    ) AS policies
  FROM experiments
  JOIN experiment_configuration_versions
    ON experiment_configuration_versions.id = experiments.active_configuration_id
  LEFT JOIN experiment_policy_versions
    ON experiment_policy_versions.configuration_id = experiment_configuration_versions.id
  LEFT JOIN policy_versions
    ON policy_versions.id = experiment_policy_versions.policy_version_id
`;

export async function listInteractiveExperiments(
  pool: pg.Pool,
  input: {
    readonly sessionId: string;
    readonly limit?: number;
  }
): Promise<InteractiveExperimentDetailRecord[]> {
  const result = await pool.query<Parameters<typeof mapExperimentRow>[0]>(
    `
      ${interactiveExperimentSelect}
      WHERE experiments.created_by_session_id = $1
      GROUP BY experiments.id, experiment_configuration_versions.id
      ORDER BY experiments.updated_at DESC, experiments.created_at DESC
      LIMIT $2
    `,
    [input.sessionId, input.limit ?? 20]
  );
  return result.rows.map(mapExperimentRow);
}

export async function getInteractiveExperiment(
  pool: pg.Pool,
  input: {
    readonly sessionId: string;
    readonly experimentId: string;
  }
): Promise<InteractiveExperimentDetailRecord | null> {
  const result = await pool.query<Parameters<typeof mapExperimentRow>[0]>(
    `
      ${interactiveExperimentSelect}
      WHERE experiments.id = $1
        AND experiments.created_by_session_id = $2
      GROUP BY experiments.id, experiment_configuration_versions.id
    `,
    [input.experimentId, input.sessionId]
  );
  const row = result.rows[0];
  return row === undefined ? null : mapExperimentRow(row);
}
