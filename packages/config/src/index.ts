import { z } from "zod";
import {
  DREAMDEX_MARKETS_SDK_VERSION,
  SOMNIA_MAINNET_CHAIN_ID,
  SOMNIA_SHANNON_CHAIN_ID
} from "@edgelab/domain";

const forbiddenEnvNames = [
  ["PRIVATE", "KEY"],
  ["SEED", "PHRASE"],
  ["MNEM", "ONIC"],
  ["KEY", "STORE"],
  ["WALLET", "PASSWORD"],
  ["SERVER", "SIGNER"]
].map((parts) => parts.join("_"));

export const RuntimeConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url(),
  PUBLIC_APP_URL: z.url(),
  SESSION_SECRET: z.string().min(32),
  SOMNIA_CHAIN_ID: z.coerce.number().refine((value) => value === SOMNIA_SHANNON_CHAIN_ID),
  SOMNIA_RPC_URL: z.url(),
  SOMNIA_WS_RPC_URL: z.url(),
  DREAMDEX_INDEXER_URL: z.url(),
  SOMNIA_MAINNET_CHAIN_ID: z.coerce
    .number()
    .refine((value) => value === SOMNIA_MAINNET_CHAIN_ID)
    .default(SOMNIA_MAINNET_CHAIN_ID),
  SOMNIA_MAINNET_RPC_URL: z.url().default("https://api.infra.mainnet.somnia.network"),
  DREAMDEX_MAINNET_INDEXER_URL: z.url().default("https://prd.smk.somnia.host/v1/graphql"),
  MARKETS_SDK_VERSION: z.literal(DREAMDEX_MARKETS_SDK_VERSION),
  WORKER_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  BUILD_COMMIT: z.string().min(1).default("local")
});
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export function assertNoServerSignerEnv(env: NodeJS.ProcessEnv): void {
  const present = forbiddenEnvNames.filter((name) => env[name] !== undefined);
  if (present.length > 0) {
    throw new Error(`Forbidden wallet/server signing environment variables: ${present.join(", ")}`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  assertNoServerSignerEnv(env);
  return RuntimeConfigSchema.parse(env);
}
