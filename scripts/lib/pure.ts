/**
 * Pure helpers for the testnet scripts: no network, no env, no clock. Everything here is unit-tested
 * in pure.test.ts, so the scripts that call it only add I/O.
 */
import { evmWindowCost, type EvmWindow } from "@qorechain/evm";
import { decodeFunctionResult, getAddress, isAddress, type Address, type Hex } from "viem";
import { MAX_HEIRS, State, type Heir } from "../../lib/encoding.js";

/** 1 uqor = 10^12 wei (18-decimal EVM view of a 6-decimal native coin). */
export const WEI_PER_UQOR = 1_000_000_000_000n;

export function weiToUqorCeil(wei: bigint): bigint {
  return (wei + WEI_PER_UQOR - 1n) / WEI_PER_UQOR;
}

/** "1.5" with 6 decimals -> 1500000n. Rejects more precision than the unit has. */
export function parseDecimal(text: string, decimals: number): bigint {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`not a decimal number: "${text}"`);
  const [whole, frac = ""] = t.split(".");
  if (frac.length > decimals) throw new Error(`"${text}" has more than ${decimals} decimals`);
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

export function formatDecimal(value: bigint, decimals: number): string {
  const s = value.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

// ------------------------------------------------------------------ lists

/** Split on commas, whitespace and newlines; drop empties. */
export function splitList(text: string | undefined): string[] {
  return (text ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Validate 0x addresses (any case; checksummed input must be correct) and return them checksummed. */
export function parseAddressList(text: string | undefined, label: string, max: number): Address[] {
  const items = splitList(text);
  const out: Address[] = [];
  for (const item of items) {
    if (!isAddress(item)) throw new Error(`${label}: "${item}" is not a valid 0x address`);
    const a = getAddress(item);
    if (out.includes(a)) throw new Error(`${label}: duplicate address ${a}`);
    out.push(a);
  }
  if (out.length > max) throw new Error(`${label}: at most ${max} addresses, got ${out.length}`);
  return out;
}

/** Heirs from a list of addresses with an equal split; the last heir takes the rounding remainder. */
export function equalHeirs(addresses: readonly Address[]): Heir[] {
  if (addresses.length < 1 || addresses.length > MAX_HEIRS) {
    throw new Error(`need 1..${MAX_HEIRS} heir addresses, got ${addresses.length}`);
  }
  const base = Math.floor(10000 / addresses.length);
  return addresses.map((a, i) => ({
    account: a,
    payoutTo: a,
    bps: i === addresses.length - 1 ? 10000 - base * (addresses.length - 1) : base,
  }));
}

// ------------------------------------------------------------------ windows

export interface TxBudget {
  gas: bigint;
  value?: bigint;
}

/** Window maxValue (uqor) that covers every planned tx at its gas cap and fee cap. */
export function windowBudget(txs: readonly TxBudget[], maxFeePerGas: bigint): bigint {
  let total = 0n;
  for (const t of txs) total += evmWindowCost({ value: t.value ?? 0n, gas: t.gas, maxFeePerGas });
  return total;
}

export interface WindowNeed {
  txs: bigint;
  /** uqor: value plus fees of the planned txs. */
  value: bigint;
  /** Window must keep at least this many blocks. */
  minBlocks?: bigint;
  /** Contracts that will be called. Omit when the window must be unscoped (contract creation). */
  targets?: readonly string[];
  /** True for contract creation: the window must have no target scope. */
  unscoped?: boolean;
}

export type WindowView = Pick<
  EvmWindow,
  "found" | "live" | "remainingBlocks" | "remainingTxs" | "remainingValue" | "nativeOnly" | "allowedTargets"
>;

/** Can an existing window serve the planned transactions, or must a new one be opened? */
export function windowSatisfies(w: WindowView, need: WindowNeed): boolean {
  if (!w.found || !w.live || w.nativeOnly) return false;
  if (w.remainingTxs < need.txs || w.remainingValue < need.value) return false;
  if (w.remainingBlocks < (need.minBlocks ?? 30n)) return false;
  const scoped = w.allowedTargets.length > 0;
  if (need.unscoped) return !scoped;
  if (!scoped) return true; // an unscoped window is a superset of any scoped need
  const have = new Set(w.allowedTargets.map((t) => t.toLowerCase()));
  return (need.targets ?? []).every((t) => have.has(t.toLowerCase()));
}

// --------------------------------------------------------- token deployment

export interface AbiParam {
  name?: string;
  type: string;
}

/**
 * Map the TestToken constructor inputs onto (name, symbol, supply, owner) by type and parameter name.
 * The token contract is owned by another builder, so the scripts adapt to its real ABI instead of
 * hard-coding a signature. Unknown shapes fail loudly rather than guessing.
 */
export function tokenCtorArgs(
  inputs: readonly AbiParam[],
  p: { name: string; symbol: string; supply: bigint; owner: Address },
): unknown[] {
  return inputs.map((input, i) => {
    const label = (input.name ?? "").toLowerCase();
    if (input.type === "string") return label.includes("symbol") || label === "sym" ? p.symbol : p.name;
    if (input.type === "address") return p.owner;
    if (input.type === "uint8") return 18;
    if (/^uint(256)?$/.test(input.type) && /supply|amount|initial|mint|premint/.test(label)) return p.supply;
    throw new Error(
      `TestToken constructor input #${i} (${input.type} ${input.name ?? ""}) is not understood; ` +
        "update tokenCtorArgs in scripts/lib/pure.ts",
    );
  });
}

// ------------------------------------------------------------------- keeper

export type KeeperAction = "trigger" | "settle";

/** What a keeper should do for a vault in this derived state. Everything else is left alone. */
export function keeperAction(state: State): KeeperAction | null {
  if (state === State.OVERDUE) return "trigger";
  if (state === State.TRIGGERED) return "settle";
  return null;
}

/** Inclusive block ranges of at most `size` blocks covering [from, to]. */
export function blockRanges(from: bigint, to: bigint, size: bigint): Array<[bigint, bigint]> {
  if (size < 1n) throw new Error("size must be >= 1");
  const out: Array<[bigint, bigint]> = [];
  for (let start = from; start <= to; start += size) {
    const end = start + size - 1n;
    out.push([start, end < to ? end : to]);
  }
  return out;
}

// -------------------------------------------------------------------- probe

export type PrecompileOutcome = "true" | "false" | "empty" | "reverted" | "malformed";

/** Classify the raw eth_call result of pqcVerify. `undefined` data with no error is an inactive precompile. */
export function classifyVerifyReturn(data: Hex | undefined, reverted: boolean): PrecompileOutcome {
  if (reverted) return "reverted";
  if (data === undefined || data === "0x") return "empty";
  if (data.length !== 2 + 64) return "malformed";
  if (/^0x0{64}$/.test(data)) return "false";
  if (/^0x0{63}1$/.test(data)) return "true";
  return "malformed";
}

export const PQC_KEY_STATUS_ABI = [
  {
    type: "function",
    name: "pqcKeyStatus",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [
      { name: "registered", type: "bool" },
      { name: "algorithmId", type: "uint8" },
      { name: "pubkey", type: "bytes" },
      { name: "possessionProven", type: "bool" },
    ],
  },
] as const;

export const PQC_VERIFY_ABI = [
  {
    type: "function",
    name: "pqcVerify",
    stateMutability: "view",
    inputs: [
      { name: "pubkey", type: "bytes" },
      { name: "signature", type: "bytes" },
      { name: "message", type: "bytes" },
    ],
    outputs: [{ name: "valid", type: "bool" }],
  },
] as const;

export const PQC_KEY_STATUS3_ABI = [
  {
    type: "function",
    name: "pqcKeyStatus",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [
      { name: "registered", type: "bool" },
      { name: "algorithmId", type: "uint8" },
      { name: "pubkey", type: "bytes" },
    ],
  },
] as const;

/** ABI-encoded return sizes in bytes for a 2592-byte pubkey: 4 values (with possessionProven) / 3 values. */
export const KEY_STATUS_BYTES_4 = 2752;
export const KEY_STATUS_BYTES_3 = 2720;

export interface KeyStatusView {
  /** Which return shape the chain uses: 4 values (with possessionProven) or the official 3-value ABI. */
  shape: 3 | 4;
  registered: boolean;
  algorithmId: number;
  pubkey: Hex;
  pubkeyLength: number;
  /** undefined for the 3-value shape. */
  possessionProven?: boolean;
}

/**
 * Strict decode. The shape is read from the offset word of the dynamic `pubkey` (0x80 = four values, 0x60 = three),
 * and the total length must be exactly head + length word + padded key, so trailing or missing bytes are "malformed".
 * A registered ML-DSA-87 key gives 2752 / 2720 bytes; an account with no key gives 160 / 128 bytes (empty pubkey).
 */
export function decodeKeyStatus(data: Hex | undefined): KeyStatusView | "empty" | "malformed" {
  if (data === undefined || data === "0x") return "empty";
  if (!/^0x([0-9a-fA-F]{64})+$/.test(data)) return "malformed";
  const bytes = (data.length - 2) / 2;
  const word = (i: number): bigint => BigInt(`0x${data.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
  if (bytes < 128) return "malformed";
  const off = word(2);
  const shape = off === 0x80n ? 4 : off === 0x60n ? 3 : 0;
  if (shape === 0) return "malformed";
  const head = shape === 4 ? 128 : 96;
  if (bytes < head + 32) return "malformed";
  const blen = word(head / 32);
  if (blen > BigInt(bytes)) return "malformed";
  const padded = Math.ceil(Number(blen) / 32) * 32;
  if (bytes !== head + 32 + padded) return "malformed";
  try {
    if (shape === 4) {
      const [registered, algorithmId, pubkey, possessionProven] = decodeFunctionResult({
        abi: PQC_KEY_STATUS_ABI,
        functionName: "pqcKeyStatus",
        data,
      });
      return { shape: 4, registered, algorithmId, pubkey, pubkeyLength: (pubkey.length - 2) / 2, possessionProven };
    }
    const [registered, algorithmId, pubkey] = decodeFunctionResult({
      abi: PQC_KEY_STATUS3_ABI,
      functionName: "pqcKeyStatus",
      data,
    });
    return { shape: 3, registered, algorithmId, pubkey, pubkeyLength: (pubkey.length - 2) / 2 };
  } catch {
    return "malformed";
  }
}

/** Throws unless the on-chain key status shows `expectedPubkey` registered as ML-DSA-87 (and proven when reported). */
export function assertKeyStatus(status: KeyStatusView | "empty" | "malformed", expectedPubkey: Uint8Array, who: string): KeyStatusView {
  if (status === "empty" || status === "malformed") throw new Error(`${who}: pqcKeyStatus returned ${status} data`);
  if (!status.registered) throw new Error(`${who}: no ML-DSA-87 key registered`);
  if (status.algorithmId !== 1) throw new Error(`${who}: key algorithm ${status.algorithmId}, expected 1 (ML-DSA-87)`);
  if (status.pubkey.toLowerCase() !== `0x${Buffer.from(expectedPubkey).toString("hex")}`) {
    throw new Error(`${who}: the registered key is not the one derived from the mnemonic`);
  }
  if (status.possessionProven === false) throw new Error(`${who}: key registered without proof of possession`);
  return status;
}

/** gas = 1.3 x estimate; refuses (instead of silently clamping and failing on chain) when that exceeds the cap. */
export function pickGas(estimate: bigint, cap: bigint, what: string): bigint {
  const padded = (estimate * 13n) / 10n;
  if (padded > cap) throw new Error(`${what}: estimated gas ${estimate} x1.3 exceeds the cap ${cap}`);
  return padded;
}

/** The drill runs Wed Nov 18 00:00 to 23:59 UTC; the proof tx must be made inside it. */
export const DRILL_START = Date.parse("2026-11-18T00:00:00Z");
export const DRILL_END = Date.parse("2026-11-19T00:00:00Z");
export const inDrillWindow = (nowMs: number): boolean => nowMs >= DRILL_START && nowMs < DRILL_END;

/** The keeper stays quiet from Nov 16 00:00 to Nov 19 00:00 UTC so it cannot race the drill runs. */
export const KEEPER_PAUSE_START = Date.parse("2026-11-16T00:00:00Z");
export const keeperPaused = (nowMs: number): boolean => nowMs >= KEEPER_PAUSE_START && nowMs < DRILL_END;

export function parseBoundedInt(text: string | undefined, fallback: number, min: number, max: number, label: string): number {
  const t = text?.trim();
  if (!t) return fallback;
  if (!/^\d+$/.test(t)) throw new Error(`${label} must be a whole number`);
  const n = Number(t);
  if (n < min || n > max) throw new Error(`${label} must be ${min}..${max}`);
  return n;
}

/** Flip one bit in the middle of a byte array (returns a copy). */
export function tamper(bytes: Uint8Array): Uint8Array {
  const out = Uint8Array.from(bytes);
  out[Math.floor(out.length / 2)] ^= 0x01;
  return out;
}

/** Fail clearly when a gas cap cannot fit in a block. */
export function assertFitsBlock(cap: bigint, blockGasLimit: bigint, what: string): void {
  if (cap > blockGasLimit) {
    throw new Error(`${what}: gas cap ${cap} exceeds the block gas limit ${blockGasLimit}; it could never be included`);
  }
}

export interface VaultFacts {
  owner: string;
  keyMode: number;
  pubkeyHash: string;
  interval: bigint;
  grace: number;
  bounty: bigint;
  heirs: ReadonlyArray<{ account: string; payoutTo: string; bps: number }>;
  tokens: readonly string[];
}

/** Differences between the vault we intended and the one found on chain (empty = identical). */
export function diffVault(want: VaultFacts, got: VaultFacts): string[] {
  const out: string[] = [];
  const cmp = (label: string, a: unknown, b: unknown) => {
    if (String(a).toLowerCase() !== String(b).toLowerCase()) out.push(`${label}: expected ${a}, found ${b}`);
  };
  cmp("owner", want.owner, got.owner);
  cmp("keyMode", want.keyMode, got.keyMode);
  cmp("pubkeyHash", want.pubkeyHash, got.pubkeyHash);
  cmp("interval", want.interval, got.interval);
  cmp("grace", want.grace, got.grace);
  cmp("bounty", want.bounty, got.bounty);
  cmp("tokens", want.tokens.join(","), got.tokens.join(","));
  cmp(
    "heirs",
    want.heirs.map((h) => `${h.account}>${h.payoutTo}:${h.bps}`).join(","),
    got.heirs.map((h) => `${h.account}>${h.payoutTo}:${h.bps}`).join(","),
  );
  return out;
}

/**
 * Split `total` between the drill vaults. With both modes the ACCOUNT vault gets `accountShareBps` and the DEVICE
 * vault the rest (the value mostly sits in the DEVICE vault, which does not depend on the chain's key registry).
 * `modes` uses 0 = ACCOUNT, 1 = DEVICE.
 */
export function splitDrillAmount(total: bigint, modes: readonly number[], accountShareBps: number): bigint[] {
  if (modes.length === 1) return [total];
  const account = (total * BigInt(accountShareBps)) / 10000n;
  return modes.map((m) => (m === 0 ? account : total - account));
}

/**
 * True for the chain's "account sequence mismatch" refusal (cosmos sdk code 32), wherever the client put the text.
 * Such a transaction was rejected before execution, so signing again with a fresh sequence cannot double-send.
 */
export function isSequenceMismatch(e: unknown): boolean {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur; i++) {
    const o = cur as { message?: unknown; rawLog?: unknown; log?: unknown; cause?: unknown };
    for (const v of [o.message, o.rawLog, o.log]) if (typeof v === "string") parts.push(v);
    cur = o.cause;
  }
  return /account sequence mismatch|incorrect account sequence/i.test(parts.join("\n"));
}
