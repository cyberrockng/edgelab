import { expect, test } from "@playwright/test";

test("decision-first evidence UI keeps claims separated and visible", async ({ page }, testInfo) => {
  const response = await page.goto("/", { waitUntil: "networkidle" });
  expect(response?.ok()).toBe(true);

  await expect(page.getByRole("heading", { name: "DreamDEX evidence lab" })).toBeVisible();
  await expect(page.getByLabel("Current decision")).toContainText("INSUFFICIENT_EVIDENCE");
  await expect(page.getByLabel("Evidence separation")).toContainText("Forecast");
  await expect(page.getByLabel("Evidence separation")).toContainText("Tradeability");
  await expect(page.getByLabel("Evidence separation")).toContainText("Realized PnL");
  await expect(page.getByLabel("DreamDEX lifecycle proof")).toContainText("EXPIRED");
  await expect(page.getByLabel("Public proof references")).toContainText("110680464442257591736");

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
  expect(navigationDurationMs).toBeLessThan(2500);
  await testInfo.attach("runtime.json", {
    body: JSON.stringify({ navigationDurationMs, viewport: testInfo.project.name }, null, 2),
    contentType: "application/json"
  });
});

test("sidebar navigation is keyboard reachable", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });

  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveText("Decision");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#decision$/);
});
