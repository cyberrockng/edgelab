import { expect, test } from "@playwright/test";

test("first impression explains the product, verdict, and evidence gate", async ({ page }, testInfo) => {
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

  await expect(page.getByRole("heading", { name: "Test a strategy before exposing it to testnet capital." })).toBeVisible();
  await expect(page.getByLabel("Current decision")).toContainText("INSUFFICIENT EVIDENCE");
  await expect(page.getByLabel("Current decision")).toContainText("Promotion blocked");
  await expect(page.getByRole("region", { name: "Evidence gate" })).toContainText("Evidence must pass through each gate");
  await expect(page.getByLabel("Evidence gate dimensions")).toContainText("Forecast sample");
  await expect(page.getByLabel("Evidence gate dimensions")).toContainText("DreamDEX tradeability");
  await expect(page.getByLabel("Evidence gate dimensions")).toContainText("Realized PnL");

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);

  const layout = await page.evaluate(() => {
    const root = document.documentElement;
    return {
      clientWidth: root.clientWidth,
      scrollWidth: root.scrollWidth,
      overflowingText: Array.from(document.querySelectorAll<HTMLElement>("body *"))
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .slice(0, 10)
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          className: element.className,
          text: element.textContent.trim().slice(0, 80)
        }))
    };
  });
  expect(layout.scrollWidth, JSON.stringify(layout.overflowingText, null, 2)).toBeLessThanOrEqual(
    layout.clientWidth
  );

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

test("evidence separation and truthful DreamDEX lifecycle remain visible", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });

  await expect(page.getByLabel("Evidence separation")).toContainText("Forecast quality");
  await expect(page.getByLabel("Evidence separation")).toContainText("Tradeability");
  await expect(page.getByLabel("Evidence separation")).toContainText("Realized PnL");
  await expect(page.getByLabel("Evidence separation")).toContainText("No fill means no realized PnL claim.");

  const chain = page.getByLabel("DreamDEX lifecycle proof");
  await expect(chain).toContainText("EXPIRED");
  await expect(chain).toContainText("Owner-approved cancel landed after expiry");
  await expect(chain).toContainText("DreamDEX emitted OrderExpired, not OrderCancelled");
  await expect(chain).toContainText("No fill was observed");
  await expect(chain).toContainText("escrow returned");
});

test("strategy comparison exposes insufficient evidence without synthetic metrics", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });

  const comparison = page.getByLabel("Strategy comparison");
  await expect(comparison).toContainText("Which policy has stronger evidence?");
  await expect(comparison).toContainText("Reference A");
  await expect(comparison).toContainText("Reference B");
  await expect(comparison).toContainText("0/30");
  await expect(comparison).toContainText("NOT AVAILABLE");
  await expect(comparison).toContainText("blocked");
});

test("technical proof links are reachable and keyboard navigation works", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });

  const proof = page.getByLabel("Technical proof details");
  await expect(proof).toContainText("Public chain evidence remains inspectable.");
  await expect(proof.getByRole("link", { name: /Approval/ })).toHaveAttribute("href", /shannon-explorer/);
  await expect(proof.getByRole("link", { name: /Order/ })).toHaveAttribute("href", /shannon-explorer/);
  await expect(proof.getByRole("link", { name: /Terminal/ })).toHaveAttribute("href", /shannon-explorer/);

  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveAccessibleName("EdgeLab overview");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveText("Overview");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#overview$/);
});
