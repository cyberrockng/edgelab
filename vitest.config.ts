import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@edgelab/auth": `${root}packages/auth/src/index.ts`,
      "@edgelab/config": `${root}packages/config/src/index.ts`,
      "@edgelab/db": `${root}packages/db/src/index.ts`,
      "@edgelab/domain": `${root}packages/domain/src/index.ts`,
      "@edgelab/dreamdex": `${root}packages/dreamdex/src/index.ts`,
      "@edgelab/metrics": `${root}packages/metrics/src/index.ts`,
      "@edgelab/policy-runtime": `${root}packages/policy-runtime/src/index.ts`
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts", "apps/**/*.test.ts"],
    reporters: ["default"],
    restoreMocks: true
  }
});
