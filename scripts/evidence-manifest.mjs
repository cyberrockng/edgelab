/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

const evidenceRoot = "evidence";
const outputPath = "evidence/export/manifest.json";
const tmpPath = `${outputPath}.tmp`;
const generated = new Set([outputPath, tmpPath]);

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (generated.has(path)) {
      continue;
    }
    if (entry.isDirectory()) {
      paths.push(...(await walk(path)));
    } else if (entry.isFile()) {
      paths.push(path);
    }
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

function evidenceClassFor(path) {
  if (path.includes("/feasibility/")) {
    return "LIVE";
  }
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(extname(path).toLowerCase())) {
    return "CAPTURED";
  }
  return "CAPTURED";
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const files = await walk(evidenceRoot);
const artifacts = [];
for (const path of files) {
  const content = await readFile(path);
  artifacts.push({
    path,
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: content.byteLength,
    evidenceClass: evidenceClassFor(path),
    redaction: "public or sanitized repository evidence only"
  });
}

const sourceCommitOverride = process.env.EVIDENCE_SOURCE_COMMIT?.trim();
const sourceCommit = sourceCommitOverride === undefined || sourceCommitOverride === "" ? git(["rev-parse", "HEAD"]) : sourceCommitOverride;
if (!/^[0-9a-f]{40}$/i.test(sourceCommit)) {
  throw new Error("EVIDENCE_SOURCE_COMMIT must be a 40-character git commit SHA when provided.");
}
const sourceCommitTime = new Date(git(["show", "-s", "--format=%cI", sourceCommit])).toISOString();
const manifest = {
  evidenceId: "EVD-007",
  task: "OBS-001",
  producer: "Codex execution agent",
  producedAt: sourceCommitTime,
  sourceCommit,
  sourceVersions: {
    somniaMarketsSdk: "0.28.1",
    network: "Somnia Shannon Testnet",
    chainId: 50312
  },
  artifactCount: artifacts.length,
  artifacts,
  redaction: "public evidence artifact paths, sizes, hashes, and evidence classes only"
};

await mkdir("evidence/export", { recursive: true });
await writeFile(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`);
await rename(tmpPath, outputPath);
console.log(JSON.stringify({ ok: true, outputPath, artifactCount: artifacts.length }, null, 2));
