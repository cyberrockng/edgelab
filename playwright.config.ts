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
  projects: [
    {
      name: "chromium-desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 960 }
      }
    },
    {
      name: "chromium-mobile",
      use: {
        ...devices["Pixel 5"]
      }
    }
  ]
});
