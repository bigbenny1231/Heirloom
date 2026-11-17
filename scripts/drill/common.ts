/** Shared by the drill scripts: fixed vault parameters and on-chain reads. */
import { keccak256, stringToBytes, type Address, type Hex, type PublicClient } from "viem";
import { pqPubkeyHash } from "../../lib/pq.js";
import {
  KeyMode,
  NATIVE,
  QORE_TESTNET_CHAIN_ID,
  ZERO_HASH,
  createDigest,
  type CreateParams,
  type Heir,
} from "../../lib/encoding.js";
import type { Abi } from "viem";

/** Heartbeat of the drill vault: well past the 24h drill, so it cannot trigger while the bot attacks. */
export const DRILL_INTERVAL = 7n * 86_400n;
export const DRILL_GRACE = 2;

export function drillParams(heirs: readonly Heir[], token: Address | undefined, salt = process.env.DRILL_SALT || "qdmv-drill-1"): CreateParams {
  if (DRILL_INTERVAL < 7n * 86_400n) throw new Error("drill interval must be >= 7 days");
  return {
    salt: keccak256(stringToBytes(salt)),
    interval: DRILL_INTERVAL,
    grace: DRILL_GRACE,
    bounty: 0n,
    tokens: token ? [token] : [],
    heirs,
  };
}

/**
 * DRILL_KEY_MODE=account|device|both (default both). ACCOUNT reads the key from the chain registry; DEVICE pins the
 * drill key in the vault, so it is immune to any registry surprise.
 */
export function drillModes(env: NodeJS.ProcessEnv): KeyMode[] {
  const v = (env.DRILL_KEY_MODE || "both").toLowerCase();
  if (v === "account") return [KeyMode.ACCOUNT];
  if (v === "device") return [KeyMode.DEVICE];
  if (v === "both") return [KeyMode.ACCOUNT, KeyMode.DEVICE];
  throw new Error(`DRILL_KEY_MODE must be account, device or both; got "${v}"`);
}

export const modeName = (m: KeyMode): string => (m === KeyMode.ACCOUNT ? "ACCOUNT" : "DEVICE");

/** pubkeyHash and calldata pubkey for the chosen mode. */
export function drillKeyArgs(mode: KeyMode, pqPublicKey: Uint8Array): { pkHash: Hex; pubkey: Hex } {
  if (mode === KeyMode.ACCOUNT) return { pkHash: ZERO_HASH, pubkey: "0x" };
  return { pkHash: pqPubkeyHash(pqPublicKey), pubkey: `0x${Buffer.from(pqPublicKey).toString("hex")}` };
}

/** The vault id the drill vault gets (needs no signature). */
export function drillVaultId(vault: Address, owner: Address, p: CreateParams, mode = KeyMode.ACCOUNT, pkHash: Hex = ZERO_HASH): bigint {
  return createDigest({ chainId: QORE_TESTNET_CHAIN_ID, vault }, owner, mode, pkHash, p, 0n).vaultId;
}

export interface VaultSnapshot {
  status: number;
  state: number;
  native: bigint;
  token?: bigint;
}

export async function readVault(
  pub: PublicClient,
  abi: Abi,
  vault: Address,
  vaultId: bigint,
  token?: Address,
): Promise<VaultSnapshot> {
  const read = (functionName: string, args: readonly unknown[]) =>
    pub.readContract({ address: vault, abi, functionName, args } as never);
  const v = (await read("getVault", [vaultId])) as { status: number };
  const state = Number(await read("stateOf", [vaultId]));
  const native = (await read("balanceOf", [vaultId, NATIVE])) as bigint;
  const tok = token ? ((await read("balanceOf", [vaultId, token])) as bigint) : undefined;
  return { status: Number(v.status), state, native, token: tok };
}

export type { Hex };
