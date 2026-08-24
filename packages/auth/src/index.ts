import { randomBytes } from "node:crypto";
import { verifyMessage, type Address, type Hex } from "viem";
import { SOMNIA_SHANNON_CHAIN_ID } from "@edgelab/domain";
import { z } from "zod";

export interface Clock {
  now(): Date;
}

export interface SignatureVerifier {
  verify(input: { readonly address: string; readonly message: string; readonly signature: string }): Promise<boolean>;
}

export const viemSignatureVerifier: SignatureVerifier = {
  async verify(input) {
    return verifyMessage({
      address: input.address as Address,
      message: input.message,
      signature: input.signature as Hex
    });
  }
};

const AddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const NonceSchema = z.string().min(16).max(128);
const SomniaChainSchema = z.number().int().refine((chainId) => chainId === SOMNIA_SHANNON_CHAIN_ID);

export const LoginChallengeSchema = z.object({
  domain: z.string().min(1),
  uri: z.url(),
  chainId: SomniaChainSchema,
  account: AddressSchema,
  nonce: NonceSchema,
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  statement: z.literal("Sign in to EdgeLab. This does not authorize a transaction.")
});
export type LoginChallenge = z.infer<typeof LoginChallengeSchema>;

export const ApprovalChallengeSchema = z.object({
  domain: z.string().min(1),
  uri: z.url(),
  chainId: SomniaChainSchema,
  account: AddressSchema,
  nonce: NonceSchema,
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  intentHash: z.string().regex(/^[a-f0-9]{64}$/),
  statement: z.literal("Approve one exact EdgeLab testnet intent. This does not grant reusable transaction authority.")
});
export type ApprovalChallenge = z.infer<typeof ApprovalChallengeSchema>;

export type AuthChallenge = LoginChallenge | ApprovalChallenge;

export type ChallengeVerificationResult =
  | { readonly ok: true; readonly account: string; readonly nonce: string }
  | {
      readonly ok: false;
      readonly reasonCode:
        | "CHALLENGE_EXPIRED"
        | "CHALLENGE_NOT_YET_VALID"
        | "DOMAIN_MISMATCH"
        | "URI_MISMATCH"
        | "CHAIN_MISMATCH"
        | "ACCOUNT_MISMATCH"
        | "NONCE_REPLAYED"
        | "SIGNATURE_INVALID"
        | "INTENT_HASH_MISMATCH";
      readonly message: string;
    };

export interface ChallengeVerificationInput {
  readonly challenge: AuthChallenge;
  readonly signature: string;
  readonly expectedDomain: string;
  readonly expectedUri: string;
  readonly expectedAccount: string;
  readonly consumedNonces: ReadonlySet<string>;
  readonly verifier?: SignatureVerifier;
  readonly clock?: Clock;
  readonly expectedIntentHash?: string;
}

function nonce(): string {
  return randomBytes(16).toString("hex");
}

function iso(date: Date): string {
  return date.toISOString();
}

export function createLoginChallenge(input: {
  readonly domain: string;
  readonly uri: string;
  readonly account: string;
  readonly clock?: Clock;
  readonly ttlMs?: number;
}): LoginChallenge {
  const now = input.clock?.now() ?? new Date();
  return LoginChallengeSchema.parse({
    domain: input.domain,
    uri: input.uri,
    chainId: SOMNIA_SHANNON_CHAIN_ID,
    account: input.account,
    nonce: nonce(),
    issuedAt: iso(now),
    expiresAt: iso(new Date(now.getTime() + (input.ttlMs ?? 5 * 60_000))),
    statement: "Sign in to EdgeLab. This does not authorize a transaction."
  });
}

export function createApprovalChallenge(input: {
  readonly domain: string;
  readonly uri: string;
  readonly account: string;
  readonly intentHash: string;
  readonly clock?: Clock;
  readonly ttlMs?: number;
}): ApprovalChallenge {
  const now = input.clock?.now() ?? new Date();
  return ApprovalChallengeSchema.parse({
    domain: input.domain,
    uri: input.uri,
    chainId: SOMNIA_SHANNON_CHAIN_ID,
    account: input.account,
    intentHash: input.intentHash,
    nonce: nonce(),
    issuedAt: iso(now),
    expiresAt: iso(new Date(now.getTime() + (input.ttlMs ?? 5 * 60_000))),
    statement: "Approve one exact EdgeLab testnet intent. This does not grant reusable transaction authority."
  });
}

export function canonicalChallengeMessage(challenge: AuthChallenge): string {
  const lines = [
    challenge.domain,
    "",
    challenge.statement,
    "",
    `URI: ${challenge.uri}`,
    `Chain ID: ${String(challenge.chainId)}`,
    `Account: ${challenge.account.toLowerCase()}`,
    `Nonce: ${challenge.nonce}`,
    `Issued At: ${challenge.issuedAt}`,
    `Expiration Time: ${challenge.expiresAt}`
  ];
  if ("intentHash" in challenge) {
    lines.push(`Intent Hash: ${challenge.intentHash}`);
  }
  return lines.join("\n");
}

function fail(
  reasonCode: Exclude<ChallengeVerificationResult, { readonly ok: true }>["reasonCode"],
  message: string
): ChallengeVerificationResult {
  return { ok: false, reasonCode, message };
}

export async function verifyChallenge(input: ChallengeVerificationInput): Promise<ChallengeVerificationResult> {
  const now = input.clock?.now() ?? new Date();
  const issuedAt = new Date(input.challenge.issuedAt);
  const expiresAt = new Date(input.challenge.expiresAt);
  const expectedAccount = input.expectedAccount.toLowerCase();
  const challengeAccount = input.challenge.account.toLowerCase();
  const expectedChainId: number = SOMNIA_SHANNON_CHAIN_ID;

  if (input.challenge.domain !== input.expectedDomain) {
    return fail("DOMAIN_MISMATCH", "Challenge domain does not match request domain");
  }
  if (input.challenge.uri !== input.expectedUri) {
    return fail("URI_MISMATCH", "Challenge URI does not match request URI");
  }
  if (input.challenge.chainId !== expectedChainId) {
    return fail("CHAIN_MISMATCH", "Challenge chain is not Somnia Shannon");
  }
  if (challengeAccount !== expectedAccount) {
    return fail("ACCOUNT_MISMATCH", "Challenge account does not match expected account");
  }
  if (input.consumedNonces.has(input.challenge.nonce)) {
    return fail("NONCE_REPLAYED", "Challenge nonce was already consumed");
  }
  if (now < issuedAt) {
    return fail("CHALLENGE_NOT_YET_VALID", "Challenge issue time is in the future");
  }
  if (now > expiresAt) {
    return fail("CHALLENGE_EXPIRED", "Challenge has expired");
  }
  if (
    "intentHash" in input.challenge &&
    input.expectedIntentHash !== undefined &&
    input.challenge.intentHash !== input.expectedIntentHash
  ) {
    return fail("INTENT_HASH_MISMATCH", "Approval challenge does not bind the expected intent hash");
  }

  const verifier = input.verifier ?? viemSignatureVerifier;
  const valid = await verifier.verify({
    address: input.challenge.account,
    message: canonicalChallengeMessage(input.challenge),
    signature: input.signature
  });
  if (!valid) {
    return fail("SIGNATURE_INVALID", "Wallet signature did not verify against the challenge");
  }
  return {
    ok: true,
    account: challengeAccount,
    nonce: input.challenge.nonce
  };
}
