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

export const migrations = ["0001_initial_schema"] as const;

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
