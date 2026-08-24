/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-template-expressions */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createPool } from "../packages/db/dist/index.js";
import { persistChainLifecycleEvidence } from "../packages/chain/dist/index.js";

const rpcUrl = process.env.SOMNIA_RPC_URL ?? "https://api.infra.testnet.somnia.network/";
const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error("DATABASE_URL is required");
}

function canonicalize(input) {
  if (Array.isArray(input)) {
    return input.map((item) => canonicalize(item));
  }
  if (input !== null && typeof input === "object") {
    return Object.fromEntries(
      Object.entries(input)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, canonicalize(value)])
    );
  }
  return input;
}

function sha256(input) {
  const value = typeof input === "string" || Buffer.isBuffer(input) ? input : JSON.stringify(canonicalize(input));
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function rpc(method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const body = await response.json();
  if (body.error !== undefined) {
    throw new Error(`${method} failed: ${JSON.stringify(body.error)}`);
  }
  return body.result;
}

function hexToDecimalString(hex) {
  return BigInt(hex).toString();
}

async function txEvidence(txHash) {
  const [tx, receipt] = await Promise.all([
    rpc("eth_getTransactionByHash", [txHash]),
    rpc("eth_getTransactionReceipt", [txHash])
  ]);
  if (tx === null || receipt === null) {
    throw new Error(`Missing public tx evidence for ${txHash}`);
  }
  return {
    nonce: hexToDecimalString(tx.nonce),
    blockNumber: hexToDecimalString(receipt.blockNumber),
    receiptStatus: receipt.status === "0x1",
    logHash: sha256(receipt.logs)
  };
}

const orderPath = "evidence/feasibility/blk-003-order.json";
const terminalPath = "evidence/feasibility/blk-003-terminal.json";
const [orderArtifact, terminalArtifact] = await Promise.all([readJson(orderPath), readJson(terminalPath)]);
const [orderTx, terminalTx] = await Promise.all([
  txEvidence(orderArtifact.orderTransaction.txHash),
  txEvidence(terminalArtifact.terminalTransaction.txHash)
]);
const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const [orderFile, terminalFile] = await Promise.all([readFile(orderPath), readFile(terminalPath)]);
const pool = createPool({ connectionString: databaseUrl, max: 2, statementTimeoutMs: 5000 });

try {
  const result = await persistChainLifecycleEvidence(pool, {
    ownerAddress: terminalArtifact.wallet.address,
    marketId: terminalArtifact.order.marketId,
    poolAddress: terminalArtifact.order.pool,
    side: terminalArtifact.order.side,
    priceRaw: terminalArtifact.order.priceRaw,
    quantityRaw: terminalArtifact.order.quantityRaw,
    escrowRaw: orderArtifact.orderIntent.maxEscrowRaw,
    expiresAt: new Date(Number(orderArtifact.orderIntent.expireSeconds) * 1000).toISOString(),
    idempotencyKey: `exg003-${terminalArtifact.order.orderId}`,
    intentHash: orderArtifact.orderIntent.intentHash.replace(/^0x/, ""),
    caps: {
      maxEscrowRaw: orderArtifact.orderIntent.maxEscrowRaw,
      fillRequired: false,
      network: "Somnia Shannon Testnet",
      orderType: orderArtifact.orderIntent.orderType
    },
    order: {
      txHash: orderArtifact.orderTransaction.txHash,
      nonce: orderTx.nonce,
      blockNumber: orderTx.blockNumber,
      receiptStatus: orderTx.receiptStatus,
      logHash: orderTx.logHash,
      verifiedAt: orderArtifact.producedAt,
      orderId: orderArtifact.decodedEvents.orderPlaced.orderId,
      state: "ORDER_VERIFIED",
      quantityRaw: orderArtifact.decodedEvents.orderPlaced.fullQuantity,
      remainingQuantityRaw: orderArtifact.decodedEvents.orderPlaced.quantityRemaining,
      payload: {
        side: orderArtifact.decodedEvents.binaryOrderPlaced.side,
        fillStatus: orderArtifact.onchainVerification.fillStatus,
        txHash: orderArtifact.orderTransaction.txHash
      }
    },
    fills: [],
    terminal: {
      txHash: terminalArtifact.terminalTransaction.txHash,
      nonce: terminalTx.nonce,
      blockNumber: terminalTx.blockNumber,
      receiptStatus: terminalTx.receiptStatus,
      logHash: terminalTx.logHash,
      verifiedAt: terminalArtifact.producedAt,
      orderId: terminalArtifact.order.orderId,
      state: terminalArtifact.terminalEvent.eventName === "OrderExpired" ? "EXPIRED" : "CANCELLED",
      quantityRaw: terminalArtifact.order.quantityRaw,
      remainingQuantityRaw: "0",
      payload: {
        terminalEvent: terminalArtifact.terminalEvent.eventName,
        collateralReconciled: terminalArtifact.postTerminalVerification.collateralReconciled,
        txHash: terminalArtifact.terminalTransaction.txHash
      }
    },
    artifacts: [
      {
        evidenceId: orderArtifact.evidenceId,
        pathOrUrl: orderPath,
        sha256: sha256(orderFile),
        commitSha,
        environment: process.env.NODE_ENV ?? "local",
        evidenceClass: "LIVE",
        redaction: orderArtifact.redaction
      },
      {
        evidenceId: terminalArtifact.evidenceId,
        pathOrUrl: terminalPath,
        sha256: sha256(terminalFile),
        commitSha,
        environment: process.env.NODE_ENV ?? "local",
        evidenceClass: "LIVE",
        redaction: terminalArtifact.redaction
      }
    ]
  });
  console.log(JSON.stringify({ ok: true, result }, null, 2));
} finally {
  await pool.end();
}
