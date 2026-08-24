import { loadConfig } from "@edgelab/config";
import { createPool, runMigrations } from "@edgelab/db";
import { createDreamDexSdkClient } from "@edgelab/dreamdex";
import { buildApp } from "./app.js";

const config = loadConfig();
const pool = createPool({ connectionString: config.DATABASE_URL, max: 10, statementTimeoutMs: 5000 });
await runMigrations(pool);
const dreamDexConfig = {
  rpcUrl: config.SOMNIA_RPC_URL,
  wsRpcUrl: config.SOMNIA_WS_RPC_URL,
  indexerUrl: config.DREAMDEX_INDEXER_URL,
  chainId: config.SOMNIA_CHAIN_ID,
  sdkVersion: config.MARKETS_SDK_VERSION
};
const app = buildApp(config, {
  pool,
  dreamDexClient: createDreamDexSdkClient(dreamDexConfig),
  dreamDexConfig
});

await app.listen({ host: "0.0.0.0", port: config.PORT });
