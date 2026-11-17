/**
 * Real ML-DSA-87 for the test harness.
 *
 * The on-chain precompile is mocked, but the mock only accepts (pubkey, message, signature) triples that this
 * module has verified with @noble/post-quantum first. So every green test went through real post-quantum crypto.
 */
import { ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";
import { bytesToHex, hexToBytes, keccak256, stringToBytes, type Hex } from "viem";
import { digestToMessage, pubkeyHash } from "../lib/encoding.js";

export interface PQKey {
  label: string;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  pubHex: Hex;
  hash: Hex;
}

const keys = new Map<string, PQKey>();

/** Deterministic key per label (fixed seed keeps tests fast and reproducible). */
export function pqKey(label: string): PQKey {
  let k = keys.get(label);
  if (!k) {
    const seed = hexToBytes(keccak256(stringToBytes(`qdmv-test-seed:${label}`)));
    const { publicKey, secretKey } = ml_dsa87.keygen(seed);
    const pubHex = bytesToHex(publicKey);
    k = { label, publicKey, secretKey, pubHex, hash: pubkeyHash(pubHex) };
    keys.set(label, k);
  }
  return k;
}

const sigCache = new Map<string, Hex>();

/** Sign a 32-byte QDMV digest (deterministic signing) and verify it for real before returning it. */
export function signDigest(key: PQKey, digest: Hex): Hex {
  const cacheKey = `${key.label}:${digest}`;
  const cached = sigCache.get(cacheKey);
  if (cached) return cached;
  const msg = digestToMessage(digest);
  const sig = ml_dsa87.sign(msg, key.secretKey, { extraEntropy: false });
  if (!ml_dsa87.verify(sig, msg, key.publicKey)) throw new Error("noble ML-DSA-87 failed to verify its own signature");
  const hex = bytesToHex(sig);
  sigCache.set(cacheKey, hex);
  return hex;
}

/** Real verification, used to double-check negative cases (wrong key must fail in noble too). */
export function verifyReal(key: PQKey, digest: Hex, sig: Hex): boolean {
  try {
    return ml_dsa87.verify(hexToBytes(sig), digestToMessage(digest), key.publicKey);
  } catch {
    return false;
  }
}

/** Hash triple the mock stores: (keccak(pubkey), keccak(32-byte message), keccak(signature)). */
export function triple(key: PQKey, digest: Hex, sig: Hex): { pk: Hex; msg: Hex; sig: Hex } {
  return { pk: key.hash, msg: keccak256(digest), sig: keccak256(sig) };
}
