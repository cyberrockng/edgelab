import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { z } from "zod";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ArgsSchema = z.object({
  statePath: z.string().min(1),
  asset: z.enum(["BTC", "ETH"]),
  intervalSec: z.union([z.literal(900), z.literal(3600)]),
  smoke: z.boolean()
});

const CampaignStateSchema = z.object({
  baseUrl: z.url(),
  cookie: z.string().min(1),
  policyId: z.string().min(1),
  policyVersion: z.string().min(1),
  experiments: z.array(
    z.object({
      asset: z.enum(["BTC", "ETH"]),
      intervalSec: z.union([z.literal(900), z.literal(3600)]),
      experimentId: z.string().uuid()
    })
  )
});

function parseArgs(argv: readonly string[]) {
  const args = new Map<string, string>();
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, value = "true"] = arg.slice(2).split("=", 2);
    args.set(key, value);
  }
  return ArgsSchema.parse({
    statePath: resolve(repoRoot, args.get("state-path") ?? "forward-observation-campaign-v4-v1.1.local"),
    asset: (args.get("asset") ?? "BTC").toUpperCase(),
    intervalSec: Number(args.get("interval-sec") ?? "900"),
    smoke: args.get("smoke") === "true"
  });
}

function parseCookie(cookie: string): { readonly name: string; readonly value: string } {
  const separator = cookie.indexOf("=");
  if (separator <= 0 || separator === cookie.length - 1) {
    throw new Error("Campaign state contains an invalid session cookie");
  }
  return {
    name: cookie.slice(0, separator),
    value: cookie.slice(separator + 1)
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const state = CampaignStateSchema.parse(JSON.parse(await readFile(args.statePath, "utf8")));
  const experiment = state.experiments.find(
    (row) => row.asset === args.asset && row.intervalSec === args.intervalSec
  );
  if (experiment === undefined) {
    throw new Error(`Campaign state has no ${args.asset} ${String(args.intervalSec)} track`);
  }

  const browser = await chromium.launch({ headless: args.smoke });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const sessionCookie = parseCookie(state.cookie);
  await context.addCookies([
    {
      ...sessionCookie,
      url: state.baseUrl,
      httpOnly: true,
      sameSite: "Lax",
      secure: new URL(state.baseUrl).protocol === "https:"
    }
  ]);

  const routes = [
    { label: "Home", path: "/" },
    { label: "Historical verdict", path: "/lab/proven-experiment" },
    { label: "Forward proof", path: "/observation" },
    { label: "Live campaign", path: `/lab/${experiment.experimentId}` },
    {
      label: "Execution gate",
      path: `/execution-candidate?experimentId=${encodeURIComponent(experiment.experimentId)}&asset=${args.asset}&intervalSec=${String(args.intervalSec)}`
    },
    { label: "Protocol proof", path: "/proof" }
  ] as const;

  const pages = [];
  for (const route of routes) {
    const page = await context.newPage();
    await page.goto(new URL(route.path, state.baseUrl).toString(), { waitUntil: "networkidle" });
    pages.push(page);
  }
  await pages[3]?.bringToFront();

  console.log(
    `Demo browser ready: ${state.policyId}@${state.policyVersion}, ${args.asset} ${String(args.intervalSec)}. Session credentials were not printed.`
  );
  if (args.smoke) {
    const workspace = pages[3];
    const bodyText = workspace === undefined ? "" : await workspace.locator("body").innerText();
    if (!bodyText.includes("FORWARD OBSERVATION") || !bodyText.includes(experiment.experimentId)) {
      const title = workspace === undefined ? "missing page" : await workspace.title();
      throw new Error(
        `Authenticated campaign workspace did not render expected forward evidence (${title}: ${bodyText.slice(0, 240)})`
      );
    }
    await browser.close();
    console.log("Demo browser smoke check passed");
    return;
  }

  console.log("Six read-only demo tabs are open. Close the browser or press Ctrl+C here when recording is complete.");
  await new Promise<void>((resolvePromise) => {
    browser.once("disconnected", resolvePromise);
    process.once("SIGINT", () => {
      void browser.close().finally(resolvePromise);
    });
  });
}

await main();
