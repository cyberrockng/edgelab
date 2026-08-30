import { expect, test, type APIResponse, type Page } from "@playwright/test";

const sampleHistoricalMarketId = ["0x", "0".repeat(60), "1bb7"].join("");

const productRoutes = [
  { path: "/", heading: "Test a DreamDEX strategy before putting capital behind it." },
  { path: "/markets", heading: "Browse historical and live Event Contract markets without mixing networks." },
  { path: `/markets/${sampleHistoricalMarketId}?plane=mainnet-history`, heading: "Inspect one DreamDEX market with source provenance." },
  { path: "/lab", heading: "Create an evidence-backed strategy experiment." },
  { path: "/lab/demo-experiment", heading: "Run replay, observe forward decisions, and evaluate evidence." },
  { path: "/compare", heading: "Compare evidence dimensions, not vanity scores." },
  { path: "/evidence/proven-experiment", heading: "What evidence caused the strategy decision?" },
  { path: "/proof", heading: "EXPIRED" },
  { path: "/how-it-works", heading: "Evidence-gated promotion keeps the product honest." }
] as const;

async function gotoRoute(page: Page, route: string): Promise<APIResponse | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await page.goto(route, { waitUntil: "domcontentloaded", timeout: 20_000 });
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ERR_NETWORK_CHANGED") && !message.includes("ERR_ABORTED")) {
        throw error;
      }
      await page.waitForTimeout(500 * (attempt + 1));
    }
  }
  throw lastError;
}

test("homepage explains the interactive product and links to real routes", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const response = await gotoRoute(page, "/");
  expect(response?.ok()).toBe(true);

  await expect(page.getByRole("heading", { name: productRoutes[0].heading })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Strategy Lab" })).toHaveAttribute("href", "/lab");
  await expect(page.getByRole("link", { name: "Explore DreamDEX history" })).toHaveAttribute(
    "href",
    "/markets?plane=mainnet-history"
  );
  await expect(page.getByRole("link", { name: "See Proven Experiment" })).toHaveAttribute(
    "href",
    "/lab/proven-experiment"
  );
  await expect(page.getByRole("link", { name: "View verified execution" })).toHaveAttribute("href", "/proof");
  await expect(page.getByLabel("EdgeLab evidence model")).toContainText("Historical Reality");
  await expect(page.getByLabel("EdgeLab evidence model")).toContainText("Evidence Gate");
  await expect(page.getByLabel("Product boundary")).toContainText("Promotion means forward observation");

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);

  const navigationDurationMs = await page.evaluate(() => {
    const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return Math.round(entry?.duration ?? 0);
  });
  expect(navigationDurationMs).toBeLessThan(process.env.E2E_BASE_URL === undefined ? 3500 : 4500);
  await testInfo.attach("runtime.json", {
    body: JSON.stringify({ navigationDurationMs, viewport: testInfo.project.name }, null, 2),
    contentType: "application/json"
  });
});

test("market detail requires an explicit canonical plane", async ({ page }) => {
  await gotoRoute(page, `/markets/${sampleHistoricalMarketId}`);
  await expect(page.getByRole("heading", { name: "Choose the market evidence plane before loading detail." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Mainnet Historical" })).toHaveAttribute(
    "href",
    `/markets/${sampleHistoricalMarketId}?plane=mainnet-history`
  );

  await gotoRoute(page, `/markets/${sampleHistoricalMarketId}?plane=bogus`);
  await expect(page.getByRole("heading", { name: "Choose the market evidence plane before loading detail." })).toBeVisible();

  await gotoRoute(page, `/markets/${sampleHistoricalMarketId}?plane=shannon-live`);
  await expect(page.getByRole("heading", { name: "Shannon live market detail is not served by the mainnet history route." })).toBeVisible();
  await expect(page.getByLabel("Shannon market detail unavailable")).toContainText("SHANNON_FORWARD");
});

test("every product route mounts by direct navigation without horizontal overflow", async ({ page }) => {
  for (const route of productRoutes) {
    const response = await gotoRoute(page, route.path);
    expect(response?.ok(), route.path).toBe(true);
    await expect(page.getByRole("heading", { name: route.heading })).toBeVisible();
    const layout = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    expect(layout.scrollWidth, route.path).toBeLessThanOrEqual(layout.clientWidth);
  }
});

test("navigation, active route state, and keyboard focus work", async ({ page }, testInfo) => {
  await gotoRoute(page, "/");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveText("Skip to content");
  await page.keyboard.press("Enter");
  await expect(page.locator(":focus")).toHaveAttribute("id", "main-content");

  if (testInfo.project.name.includes("mobile")) {
    await page.getByText("Menu").click();
  }
  await page.getByRole("link", { name: "Markets" }).click();
  await expect(page).toHaveURL(/\/markets$/);
  await expect(page.getByRole("link", { name: "Markets" })).toHaveClass(/active/);
  await expect(page.locator(":focus")).toHaveAttribute("id", "main-content");
});

test("market filters update URL state and keep source provenance visible", async ({ page }) => {
  await gotoRoute(page, "/markets");
  await page.getByLabel("Asset").selectOption("ETH");
  await page.getByLabel("Interval").selectOption("14400");
  await page.getByRole("button", { name: "Apply Filters" }).click();
  await expect(page).toHaveURL(/asset=ETH/);
  await expect(page).toHaveURL(/interval=14400/);
  await expect(page.getByLabel("Market explorer state")).toContainText("MAINNET_HISTORICAL");
  await expect(page.getByLabel("Market explorer state")).toContainText("ETH");
});

test("strategy lab creates a persisted research-session experiment", async ({ page }) => {
  await gotoRoute(page, "/lab");
  await page.getByLabel("Experiment name").fill(`E2E replay ${String(Date.now())}`);
  await page.getByLabel("Strategy").selectOption("historical-last-trade@1.1.0");
  await page.getByLabel("Mode").selectOption("HISTORICAL_REPLAY");
  await page.getByLabel("Asset universe").selectOption("BTC");
  await page.getByLabel("Interval").selectOption("3600");
  await page.getByRole("button", { name: "Create Experiment" }).click();

  await expect(page).toHaveURL(/\/lab\/[0-9a-f-]{36}$/);
  await expect(page.getByLabel("Experiment workspace state")).toContainText("Application state");
  await expect(page.getByLabel("Experiment workspace state")).toContainText("MAINNET_HISTORICAL", { timeout: 15_000 });
  await expect(page.getByLabel("Experiment workspace state")).toContainText("Last-Trade Probability");
  await expect(page.getByLabel("Experiment workspace state")).toContainText("NOT_AVAILABLE");
});

test("proven experiment path exposes captured replay without favorable-data claims", async ({ page }) => {
  await gotoRoute(page, "/lab/proven-experiment");
  const workspace = page.getByRole("region", { name: "Proven experiment workspace" });
  await expect(page.getByRole("heading", { name: "Inspect a captured DreamDEX evidence run." })).toBeVisible();
  await expect(workspace).toContainText("PUBLIC PROVEN");
  await expect(workspace).toContainText("PROMOTE TO FORWARD OBSERVATION");
  await expect(workspace).toContainText("NOT_AVAILABLE");
  await expect(workspace).toContainText("reproducibility and source completeness");
  await page.getByRole("link", { name: "View Evidence Gate" }).click();
  await expect(page).toHaveURL("/evidence/proven-experiment");
  await expect(page.getByRole("region", { name: "Evidence gate" })).toContainText("PROMOTE_TO_FORWARD_OBSERVATION");
});

test("public comparison separates evidence phases without fake strategy performance", async ({ page }) => {
  await gotoRoute(page, "/compare");
  const comparison = page.getByRole("region", { name: "Public comparison" });
  await expect(comparison).toContainText("One experiment, three evidence planes");
  await expect(comparison).toContainText("Historical qualification");
  await expect(comparison).toContainText("Forward observation");
  await expect(comparison).toContainText("Execution proof");
  await expect(comparison).toContainText("mainnet trading, autonomous execution, profit claims");
});

test("evidence route does not manufacture a final verdict in the browser", async ({ page }) => {
  await gotoRoute(page, "/evidence/proven-experiment");
  const gate = page.getByRole("region", { name: "Evidence gate" });
  await expect(gate).toContainText("PROMOTE TO FORWARD OBSERVATION");
  await expect(gate).toContainText("Historical replay evidence meets sample, Brier score, and calibration thresholds");
  await expect(gate).toContainText("PROMOTE_TO_FORWARD_OBSERVATION");
  await expect(gate).toContainText("MAINNET_HISTORICAL");
  await expect(page.getByLabel("Evidence gate dimensions")).toContainText("Forecast sample");
  await expect(page.getByLabel("Evidence gate dimensions")).toContainText("PnL");
  await expect(page.getByLabel("Evidence gate dimensions")).toContainText("Tradeability / execution quality");
});

test("truthful DreamDEX proof remains reachable", async ({ page }) => {
  await gotoRoute(page, "/proof");

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
