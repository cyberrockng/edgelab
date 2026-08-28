import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  expect: {
    timeout: 5_000
  },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3011",
    trace: "retain-on-failure"
  },
  webServer:
    process.env.E2E_BASE_URL === undefined
      ? {
          command: "pnpm --filter @edgelab/server dev",
          url: "http://localhost:3011/healthz",
          reuseExistingServer: false,
          timeout: 120_000,
          env: {
            NODE_ENV: "test",
            PORT: "3011",
            DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://edgelab:edgelab@localhost:55432/edgelab",
            PUBLIC_APP_URL: "http://localhost:3011",
            SESSION_SECRET: "local-e2e-session-secret-at-least-32-bytes",
            SOMNIA_CHAIN_ID: "50312",
            SOMNIA_RPC_URL: "https://api.infra.testnet.somnia.network/",
            SOMNIA_WS_RPC_URL: "wss://api.infra.testnet.somnia.network/ws",
            DREAMDEX_INDEXER_URL: "https://dev.smk.somnia.host/v1/graphql",
            SOMNIA_MAINNET_CHAIN_ID: "5031",
            SOMNIA_MAINNET_RPC_URL: "https://api.infra.mainnet.somnia.network",
            DREAMDEX_MAINNET_INDEXER_URL: "https://prd.smk.somnia.host/v1/graphql",
            MARKETS_SDK_VERSION: "0.28.1",
            WORKER_ENABLED: "false",
            LOG_LEVEL: "error",
            BUILD_COMMIT: "local-e2e"
          }
        }
      : undefined,
  projects: [
    {
      name: "desktop-1440",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 960 }
      }
    },
    {
      name: "desktop-1366",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1366, height: 768 }
      }
    },
    {
      name: "desktop-1280",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 }
      }
    },
    {
      name: "mobile-pixel-5",
      use: {
        ...devices["Pixel 5"]
      }
    }
  ]
});
