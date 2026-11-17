/**
 * ML-DSA-87 helpers (FIPS 204, "dilithium5") on @noble/post-quantum. Browser-safe: no Node APIs.
 *
 * Signatures are deterministic (noble default, no extra entropy), use the empty context, and cover
 * exactly the 32-byte QDMV digest, which is also what the pqcVerify precompile receives as `message`.
 */
import { ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";
import { keccak256, bytesToHex, hexToBytes, type Hex } from "viem";
import { PQ_PUBKEY_LENGTH, PQ_SIGNATURE_LENGTH } from "./encoding.ts";

export const PQ_SEED_LENGTH = 32;
export const PQ_SECRET_KEY_LENGTH = 4896;

export interface PqKeyPair {
  publicKey: Uint8Array; // 2592 bytes
  secretKey: Uint8Array; // 4896 bytes
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** Keygen from a 32-byte seed (deterministic) or, with no argument, from fresh randomness. */
export function pqKeygen(seed?: Uint8Array | Hex): PqKeyPair & { seed: Uint8Array } {
  const s = seed === undefined ? randomBytes(PQ_SEED_LENGTH) : typeof seed === "string" ? hexToBytes(seed) : seed;
  if (s.length !== PQ_SEED_LENGTH) throw new Error(`seed must be ${PQ_SEED_LENGTH} bytes`);
  const kp = ml_dsa87.keygen(s);
  return { publicKey: kp.publicKey, secretKey: kp.secretKey, seed: s };
}

/** Sign a 32-byte digest. Deterministic. */
export function pqSign(digest: Hex | Uint8Array, secretKey: Uint8Array): Uint8Array {
  const msg = typeof digest === "string" ? hexToBytes(digest) : digest;
  if (msg.length !== 32) throw new Error("digest must be 32 bytes");
  const sig = ml_dsa87.sign(msg, secretKey, { extraEntropy: false });
  if (sig.length !== PQ_SIGNATURE_LENGTH) throw new Error(`unexpected signature length ${sig.length}`);
  return sig;
}

/** Verify an ML-DSA-87 signature over arbitrary message bytes (empty context). Never throws. */
export function pqVerify(sig: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  if (sig.length !== PQ_SIGNATURE_LENGTH || publicKey.length !== PQ_PUBKEY_LENGTH) return false;
  try {
    return ml_dsa87.verify(sig, message, publicKey);
  } catch {
    return false;
  }
}

/** keccak256(pubkey): what a DEVICE vault pins. Same as encoding.pubkeyHash. */
export function pqPubkeyHash(publicKey: Uint8Array): Hex {
  if (publicKey.length !== PQ_PUBKEY_LENGTH) throw new Error(`pubkey must be ${PQ_PUBKEY_LENGTH} bytes`);
  return keccak256(publicKey);
}

// ------------------------------------------------------- device key export

const EXPORT_PREFIX = "qdmv1:";

/** Checksum = first 4 bytes of keccak256(seed || pubkeyHash), so a typo or a wrong file is caught. */
function checksum(seed: Uint8Array, pk: Uint8Array): string {
  const h = keccak256(new Uint8Array([...seed, ...hexToBytes(keccak256(pk))]));
  return h.slice(2, 10);
}

/**
 * Serialize a device key as `qdmv1:<seed hex>:<checksum>`. Only the 32-byte seed is stored; the
 * full keys are recomputed on import (ML-DSA keygen from seed is deterministic and fast).
 */
export function exportDeviceKey(seed: Uint8Array): string {
  const kp = pqKeygen(seed);
  return `${EXPORT_PREFIX}${bytesToHex(seed).slice(2)}:${checksum(seed, kp.publicKey)}`;
}

/** Inverse of exportDeviceKey. Throws on a bad format or checksum. */
export function importDeviceKey(text: string): PqKeyPair & { seed: Uint8Array } {
  const parts = text.trim().split(":");
  if (parts.length !== 3 || `${parts[0]}:` !== EXPORT_PREFIX) throw new Error("not a QDMV device key");
  const [, seedHex, sum] = parts;
  if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) throw new Error("bad device key seed");
  const kp = pqKeygen(`0x${seedHex}` as Hex);
  if (checksum(kp.seed, kp.publicKey) !== sum.toLowerCase()) throw new Error("device key checksum mismatch");
  return kp;
}
