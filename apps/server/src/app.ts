import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify from "fastify";
import type { RuntimeConfig } from "@edgelab/config";
import { DREAMDEX_MARKETS_SDK_VERSION, SOMNIA_SHANNON_CHAIN_ID } from "@edgelab/domain";

export function buildApp(config: RuntimeConfig) {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"]
    }
  });

  void app.register(helmet);
  void app.register(cookie, { secret: config.SESSION_SECRET });
  void app.register(cors, {
    origin: config.PUBLIC_APP_URL,
    credentials: true
  });

  app.get("/healthz", () => ({
    ok: true,
    service: "edgelab",
    buildCommit: config.BUILD_COMMIT
  }));

  app.get("/readyz", () => ({
    ok: true,
    workerEnabled: config.WORKER_ENABLED,
    chainId: SOMNIA_SHANNON_CHAIN_ID,
    marketsSdkVersion: DREAMDEX_MARKETS_SDK_VERSION
  }));

  app.get("/api/v1/invariants", () => ({
    product: "forward-testing-live-shadow-recent-window-dreamdex-lab",
    verdicts: ["PROMOTE", "HOLD", "REJECT", "INSUFFICIENT_EVIDENCE"],
    boundaries: {
      serviceSignsTransactions: false,
      historicalClobBacktest: false,
      fabricatedFills: false,
      mainnetWrites: false
    }
  }));

  return app;
}
