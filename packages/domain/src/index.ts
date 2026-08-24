import { z } from "zod";

export const SOMNIA_SHANNON_CHAIN_ID = 50312 as const;
export const DREAMDEX_MARKETS_SDK_VERSION = "0.28.1" as const;

export const EvidenceClassSchema = z.enum([
  "LIVE",
  "CAPTURED",
  "MOCK",
  "SIMULATED_FROM_CAPTURED_BOOK"
]);
export type EvidenceClass = z.infer<typeof EvidenceClassSchema>;

export const VerdictSchema = z.enum([
  "PROMOTE",
  "HOLD",
  "REJECT",
  "INSUFFICIENT_EVIDENCE"
]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const ExecutionStateSchema = z.enum([
  "INTENT_DRAFT",
  "AWAITING_APPROVAL",
  "APPROVED",
  "SUBMITTING",
  "TX_CONFIRMED",
  "ORDER_VERIFIED",
  "UNFILLED",
  "PARTIALLY_FILLED",
  "FILLED",
  "SETTLED",
  "CANCELLED",
  "EXPIRED",
  "UNVERIFIED",
  "FAILED"
]);
export type ExecutionState = z.infer<typeof ExecutionStateSchema>;

export const PolicyDecisionSchema = z.object({
  policyId: z.string().min(1),
  policyVersion: z.string().min(1),
  forecastPUp: z.number().min(0).max(1),
  action: z.enum(["ABSTAIN", "BUY_YES_PROBE", "WATCH_ONLY"]),
  reasonCodes: z.array(z.string().min(1)).min(1),
  decidedAt: z.iso.datetime(),
  snapshotHash: z.string().min(32),
  policyHash: z.string().min(32)
});
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const MarketSnapshotSchema = z.object({
  marketId: z.string().min(1),
  chainId: z.literal(SOMNIA_SHANNON_CHAIN_ID),
  asset: z.enum(["BTC", "ETH"]),
  intervalSeconds: z.number().int().positive(),
  capturedAt: z.iso.datetime(),
  source: z.object({
    sdkVersion: z.literal(DREAMDEX_MARKETS_SDK_VERSION),
    rpcUrl: z.url(),
    indexerUrl: z.url(),
    evidenceClass: EvidenceClassSchema
  }),
  book: z.object({
    bids: z.array(z.object({ priceRaw: z.string(), quantityRaw: z.string() })),
    asks: z.array(z.object({ priceRaw: z.string(), quantityRaw: z.string() }))
  })
});
export type MarketSnapshot = z.infer<typeof MarketSnapshotSchema>;

export const EvidenceArtifactSchema = z.object({
  evidenceId: z.string().min(1),
  artifactPath: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  producer: z.string().min(1),
  producedAt: z.iso.datetime(),
  commit: z.string().min(1),
  evidenceClass: EvidenceClassSchema,
  redaction: z.string().min(1)
});
export type EvidenceArtifact = z.infer<typeof EvidenceArtifactSchema>;

export function assertNever(value: never): never {
  throw new Error(`Unhandled value: ${String(value)}`);
}
