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

export const migrations = ["0001_initial_schema", "0002_interactive_product"] as const;

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

export async function createInteractiveExperiment(
  pool: pg.Pool,
  input: {
    readonly sessionId: string;
    readonly name: string;
    readonly visibility?: "PRIVATE" | "PUBLIC_PROVEN" | "SHARED_LINK";
    readonly configuration: ExperimentConfigurationInput;
  }
): Promise<InteractiveExperimentRecord> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const experiment = await client.query<{ id: string }>(
      `
        INSERT INTO experiments(created_by_session_id, name, visibility, decision_offset_sec, status)
        VALUES ($1, $2, $3, $4, 'DRAFT')
        RETURNING id
      `,
      [
        input.sessionId,
        input.name,
        input.visibility ?? "PRIVATE",
        input.configuration.decisionOffsetSec
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
    await client.query("COMMIT");
    return {
      experimentId,
      configurationId: configurationRow.id,
      version: configurationRow.version
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
