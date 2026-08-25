import { expect, test } from "@playwright/test";

const sampleHistoricalMarketId = ["0x", "0".repeat(60), "1bb7"].join("");

const productRoutes = [
  { path: "/", heading: "Test a DreamDEX strategy before putting capital behind it." },
  { path: "/markets", heading: "Browse historical and live Event Contract markets without mixing networks." },
  { path: `/markets/${sampleHistoricalMarketId}`, heading: "Inspect one DreamDEX market with source provenance." },
  { path: "/lab", heading: "Create an evidence-backed strategy experiment." },
  { path: "/lab/demo-experiment", heading: "Run replay, observe forward decisions, and evaluate evidence." },
  { path: "/compare", heading: "Compare evidence dimensions, not vanity scores." },
  { path: "/evidence/proven-experiment", heading: "What evidence caused the strategy decision?" },
  { path: "/proof", heading: "EXPIRED" },
  { path: "/how-it-works", heading: "Evidence-gated promotion keeps the product honest." }
] as const;

test("homepage explains the interactive product and links to real routes", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const response = await page.goto("/", { waitUntil: "networkidle" });
  expect(response?.ok()).toBe(true);

  await expect(page.getByRole("heading", { name: productRoutes[0].heading })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Strategy Lab" })).toHaveAttribute("href", "/lab");
  await expect(page.getByRole("link", { name: "Explore DreamDEX History" })).toHaveAttribute(
    "href",
    "/markets?plane=historical"
  );
  await expect(page.getByRole("link", { name: "View Verified Execution" })).toHaveAttribute("href", "/proof");
  await expect(page.getByLabel("EdgeLab evidence model")).toContainText("Historical Reality");
  await expect(page.getByLabel("EdgeLab evidence model")).toContainText("Evidence Gate");
  await expect(page.getByLabel("Product boundary")).toContainText("Insufficient evidence is a protection mechanism");

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);

  const navigationDurationMs = await page.evaluate(() => {
    const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return Math.round(entry?.duration ?? 0);
  });
  expect(navigationDurationMs).toBeLessThan(3500);
  await testInfo.attach("runtime.json", {
    body: JSON.stringify({ navigationDurationMs, viewport: testInfo.project.name }, null, 2),
    contentType: "application/json"
  });
});

test("every product route mounts by direct navigation without horizontal overflow", async ({ page }) => {
  for (const route of productRoutes) {
    const response = await page.goto(route.path, { waitUntil: "networkidle" });
    expect(response?.ok(), route.path).toBe(true);
    await expect(page.getByRole("heading", { name: route.heading })).toBeVisible();
    const layout = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    expect(layout.scrollWidth, route.path).toBeLessThanOrEqual(layout.clientWidth);
  }
});

test("navigation, active route state, and keyboard focus work", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveText("Skip to content");
  await page.keyboard.press("Enter");
  await expect(page.locator(":focus")).toHaveAttribute("id", "main-content");

  await page.getByRole("link", { name: "Markets" }).click();
  await expect(page).toHaveURL(/\/markets$/);
  await expect(page.getByRole("link", { name: "Markets" })).toHaveClass(/active/);
  await expect(page.locator(":focus")).toHaveAttribute("id", "main-content");
});

test("market filters update URL state and keep source provenance visible", async ({ page }) => {
  await page.goto("/markets", { waitUntil: "networkidle" });
  await page.getByLabel("Asset").selectOption("ETH");
  await page.getByLabel("Interval").selectOption("14400");
  await page.getByRole("button", { name: "Apply Filters" }).click();
  await expect(page).toHaveURL(/asset=ETH/);
  await expect(page).toHaveURL(/interval=14400/);
  await expect(page.getByLabel("Market explorer state")).toContainText("MAINNET_HISTORICAL");
  await expect(page.getByLabel("Market explorer state")).toContainText("ETH");
});

test("strategy lab creates a persisted research-session experiment", async ({ page }) => {
  await page.goto("/lab", { waitUntil: "networkidle" });
  await page.getByLabel("Experiment name").fill(`E2E replay ${String(Date.now())}`);
  await page.getByLabel("Strategy").selectOption("reference-neutral@1.0.0");
  await page.getByLabel("Mode").selectOption("HISTORICAL_REPLAY");
  await page.getByLabel("Asset universe").selectOption("BTC");
  await page.getByLabel("Interval").selectOption("3600");
  await page.getByRole("button", { name: "Create Experiment" }).click();

  await expect(page).toHaveURL(/\/lab\/[0-9a-f-]{36}$/);
  await expect(page.getByLabel("Experiment workspace state")).toContainText("Application state");
  await expect(page.getByLabel("Experiment workspace state")).toContainText("MAINNET_HISTORICAL");
  await expect(page.getByLabel("Experiment workspace state")).toContainText("Educational neutral baseline");
  await expect(page.getByLabel("Experiment workspace state")).toContainText("NOT_AVAILABLE");
});

test("evidence route does not manufacture a final verdict in the browser", async ({ page }) => {
  await page.goto("/evidence/proven-experiment", { waitUntil: "networkidle" });
  const gate = page.getByRole("region", { name: "Evidence gate" });
  await expect(gate).toContainText("AWAITING SERVER EVALUATION");
  await expect(gate).toContainText(
    "The browser does not manufacture PROMOTE, HOLD, REJECT, or INSUFFICIENT EVIDENCE."
  );
  await expect(page.getByLabel("Evidence gate dimensions")).toContainText("Forecast sample");
  await expect(page.getByLabel("Evidence gate dimensions")).toContainText("Realized PnL");
});

test("truthful DreamDEX proof remains reachable", async ({ page }) => {
  await page.goto("/proof", { waitUntil: "networkidle" });

  const chain = page.getByLabel("DreamDEX lifecycle proof");
  await expect(chain).toContainText("EXPIRED");
  await expect(chain).toContainText("Owner-approved cancel landed after expiry");
  await expect(chain).toContainText("DreamDEX emitted OrderExpired, not OrderCancelled");
  await expect(chain).toContainText("No fill was observed");
  await expect(chain).toContainText("escrow returned");

  const proof = page.getByLabel("Technical proof details");
  await expect(proof.getByRole("link", { name: /Approval/ })).toHaveAttribute("href", /shannon-explorer/);
  await expect(proof.getByRole("link", { name: /Order/ })).toHaveAttribute("href", /shannon-explorer/);
  await expect(proof.getByRole("link", { name: /Terminal/ })).toHaveAttribute("href", /shannon-explorer/);
});

test("SPA fallback serves client routes while API and missing assets remain 404", async ({ request }) => {
  const routeResponse = await request.get("/markets");
  expect(routeResponse.status()).toBe(200);
  expect(routeResponse.headers()["content-type"] ?? "").toMatch(/text\/html/);

  const apiResponse = await request.get("/api/does-not-exist");
  expect(apiResponse.status()).toBe(404);

  const assetResponse = await request.get("/assets/does-not-exist.js");
  expect(assetResponse.status()).toBe(404);
});
