/**
 * Interop with QoreChain's own post-quantum library (@qorechain/pqc, the reference the chain's vectors are checked
 * against). QDMVault's signers use lib/pq.ts; this proves the two agree byte for byte on ML-DSA-87 over a 32-byte
 * digest with the empty context, in both directions, and that the hedged (randomised) form the chain also accepts
 * verifies under our verifier. Offline.
 */
import { describe, expect, it } from "vitest";
import { mldsa87 } from "@qorechain/pqc";
import { keccak256, stringToBytes, hexToBytes } from "viem";
import { pqKeygen, pqSign, pqVerify } from "../../lib/pq.js";
import { tamper } from "./pure.js";

const digest = hexToBytes(keccak256(stringToBytes("qdmv-interop")));

describe("ML-DSA-87 interop with @qorechain/pqc", () => {
  const seed = new Uint8Array(32).fill(7);
  const ours = pqKeygen(seed);

  it("derives the same key pair from the same seed", () => {
    const theirs = mldsa87.keygen(seed);
    expect(Buffer.from(theirs.publicKey).equals(Buffer.from(ours.publicKey))).toBe(true);
    expect(Buffer.from(theirs.secretKey).equals(Buffer.from(ours.secretKey))).toBe(true);
    expect(ours.publicKey.length).toBe(2592);
  });

  it("a QDMV signature verifies under @qorechain/pqc, and is the same bytes it would produce", () => {
    const sig = pqSign(digest, ours.secretKey);
    expect(sig.length).toBe(4627);
    expect(mldsa87.verify(ours.publicKey, digest, sig)).toBe(true);
    expect(Buffer.from(mldsa87.sign(ours.secretKey, digest)).equals(Buffer.from(sig))).toBe(true);
    expect(mldsa87.verify(ours.publicKey, tamper(digest), sig)).toBe(false);
    expect(mldsa87.verify(ours.publicKey, digest, tamper(sig))).toBe(false);
  });

  it("a @qorechain/pqc signature (deterministic or hedged) verifies under the QDMV verifier", () => {
    expect(pqVerify(mldsa87.sign(ours.secretKey, digest), digest, ours.publicKey)).toBe(true);
    const hedged = mldsa87.sign(ours.secretKey, digest, { hedged: true });
    expect(pqVerify(hedged, digest, ours.publicKey)).toBe(true);
    expect(pqVerify(hedged, tamper(digest), ours.publicKey)).toBe(false);
  });
});
