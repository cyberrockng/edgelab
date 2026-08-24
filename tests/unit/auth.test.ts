import { describe, expect, it } from "vitest";
import {
  canonicalChallengeMessage,
  createApprovalChallenge,
  createLoginChallenge,
  type SignatureVerifier,
  verifyChallenge
} from "@edgelab/auth";
import { SOMNIA_SHANNON_CHAIN_ID } from "@edgelab/domain";

const domain = "localhost";
const uri = "http://localhost:3000";
const account = `0x${"1".repeat(40)}`;
const otherAccount = `0x${"2".repeat(40)}`;
const fixedNow = new Date("2026-08-24T14:30:00.000Z");
const clock = { now: () => fixedNow };
const signature = "0xwallet-approved";

function verifier(valid: boolean): SignatureVerifier {
  return {
    verify(input) {
      expect(input.signature).toBe(signature);
      expect(input.message).toContain("Sign in to EdgeLab");
      return Promise.resolve(valid);
    }
  };
}

describe("wallet auth challenges", () => {
  it("creates chain-bound login challenges with exact consent text", () => {
    const challenge = createLoginChallenge({ domain, uri, account, clock });

    expect(challenge.chainId).toBe(SOMNIA_SHANNON_CHAIN_ID);
    expect(challenge.statement).toBe("Sign in to EdgeLab. This does not authorize a transaction.");
    expect(challenge.account).toBe(account);
    expect(challenge.nonce).toHaveLength(32);
    expect(canonicalChallengeMessage(challenge)).toContain("Chain ID: 50312");
    expect(canonicalChallengeMessage(challenge)).toContain(`Account: ${account}`);
  });

  it("verifies a fresh login challenge without granting transaction authority", async () => {
    const challenge = createLoginChallenge({ domain, uri, account, clock });

    const result = await verifyChallenge({
      challenge,
      signature,
      expectedDomain: domain,
      expectedUri: uri,
      expectedAccount: account,
      consumedNonces: new Set(),
      verifier: verifier(true),
      clock
    });

    expect(result).toEqual({ ok: true, account, nonce: challenge.nonce });
  });

  it("rejects replayed, expired, account-mismatched, and invalid signatures", async () => {
    const challenge = createLoginChallenge({ domain, uri, account, clock, ttlMs: 1_000 });

    await expect(
      verifyChallenge({
        challenge,
        signature,
        expectedDomain: domain,
        expectedUri: uri,
        expectedAccount: account,
        consumedNonces: new Set([challenge.nonce]),
        verifier: verifier(true),
        clock
      })
    ).resolves.toMatchObject({ ok: false, reasonCode: "NONCE_REPLAYED" });

    await expect(
      verifyChallenge({
        challenge,
        signature,
        expectedDomain: domain,
        expectedUri: uri,
        expectedAccount: account,
        consumedNonces: new Set(),
        verifier: verifier(true),
        clock: { now: () => new Date("2026-08-24T14:30:02.000Z") }
      })
    ).resolves.toMatchObject({ ok: false, reasonCode: "CHALLENGE_EXPIRED" });

    await expect(
      verifyChallenge({
        challenge,
        signature,
        expectedDomain: domain,
        expectedUri: uri,
        expectedAccount: otherAccount,
        consumedNonces: new Set(),
        verifier: verifier(true),
        clock
      })
    ).resolves.toMatchObject({ ok: false, reasonCode: "ACCOUNT_MISMATCH" });

    await expect(
      verifyChallenge({
        challenge,
        signature,
        expectedDomain: domain,
        expectedUri: uri,
        expectedAccount: account,
        consumedNonces: new Set(),
        verifier: verifier(false),
        clock
      })
    ).resolves.toMatchObject({ ok: false, reasonCode: "SIGNATURE_INVALID" });
  });

  it("binds transaction approval challenges to one exact intent hash", async () => {
    const intentHash = "a".repeat(64);
    const challenge = createApprovalChallenge({ domain, uri, account, intentHash, clock });

    expect(challenge.statement).toBe(
      "Approve one exact EdgeLab testnet intent. This does not grant reusable transaction authority."
    );
    expect(canonicalChallengeMessage(challenge)).toContain(`Intent Hash: ${intentHash}`);

    await expect(
      verifyChallenge({
        challenge,
        signature,
        expectedDomain: domain,
        expectedUri: uri,
        expectedAccount: account,
        expectedIntentHash: "b".repeat(64),
        consumedNonces: new Set(),
        verifier: {
          verify() {
            return Promise.reject(new Error("signature verification should not run for mismatched intent"));
          }
        },
        clock
      })
    ).resolves.toMatchObject({ ok: false, reasonCode: "INTENT_HASH_MISMATCH" });
  });
});
