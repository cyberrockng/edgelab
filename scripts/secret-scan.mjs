import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8"
})
  .split("\n")
  .filter(Boolean)
  .filter((path) => !path.includes("pnpm-lock.yaml"))
  .filter((path) => !/\.(png|jpe?g|webp|gif|ico)$/i.test(path));

const forbiddenNames = [
  ["PRIVATE", "KEY"],
  ["MNEM", "ONIC"],
  ["SEED", "PHRASE"],
  ["KEY", "STORE"],
  ["WALLET", "PASSWORD"],
  ["SERVER", "SIGNER"]
].map((parts) => parts.join("_"));

const forbiddenPatterns = [
  /\b(?=[A-Za-z0-9+/]{40,}={0,2}\b)(?=[A-Za-z0-9+/]*[+/=])[A-Za-z0-9+/]+={0,2}\b/,
  new RegExp(
    [
      ["private", "[_-]?", "key"].join(""),
      ["seed", "[_-]?", "phrase"].join(""),
      ["mnem", "onic"].join(""),
      ["key", "[_-]?", "store"].join(""),
      ["wallet", "[_-]?", "password"].join("")
    ].join("|"),
    "i"
  )
];

const chainSizedHex = /0x[a-fA-F0-9]{64}/;
const publicEvidenceKeys = [
  "stableMarketId",
  "marketId",
  "selectedMarketId",
  "explicitMarketId",
  "txHash",
  "transactionHash",
  "blockHash",
  "snapshotHash",
  "snapshot_hash",
  "calldataHash",
  "intentHash",
  "receiptHash",
  "sourceHash",
  "implementationHash",
  "configHash",
  "inputHash",
  "outputHash",
  "frameHash",
  "replayEvidenceHash",
  "evaluationEvidenceHash",
  "assessmentHash"
];

/**
 * @param {string} path
 * @param {string} line
 * @returns {boolean}
 */
function isAllowedPublicEvidenceHex(path, line) {
  return path.startsWith("evidence/") && publicEvidenceKeys.some((key) => line.includes(`"${key}"`));
}

let failed = false;
for (const path of tracked) {
  const content = readFileSync(path, "utf8");
  for (const name of forbiddenNames) {
    if (content.includes(name)) {
      console.error(`Forbidden secret variable name found in ${path}: ${name}`);
      failed = true;
    }
  }
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(content)) {
      console.error(`Potential secret pattern found in ${path}: ${String(pattern)}`);
      failed = true;
    }
  }
  for (const line of content.split("\n")) {
    if (chainSizedHex.test(line) && !isAllowedPublicEvidenceHex(path, line)) {
      console.error(`Potential 32-byte private value found in ${path}`);
      failed = true;
    }
  }
}

if (failed) {
  process.exit(1);
}

console.log(`Secret scan passed for ${String(tracked.length)} files.`);
