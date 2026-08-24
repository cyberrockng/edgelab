import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@edgelab/domain": fileURLToPath(new URL("../../packages/domain/src/index.ts", import.meta.url))
    }
  },
  build: {
    outDir: "dist"
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/healthz": "http://localhost:3000",
      "/readyz": "http://localhost:3000"
    }
  }
});
