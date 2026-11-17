/**
 * The only surface the UI knows about. demo.ts runs it on the in-browser chain,
 * testnet.ts on QoreChain testnet through an injected EVM wallet.
 */
export type Hex = `0x${string}`;

export type VaultState = "NONE" | "ALIVE" | "WARNING" | "OVERDUE" | "TRIGGERED" | "SETTLED" | "CLOSED";

export interface TokenInfo {
  address: Hex; // 0x000...0 for native
  symbol: string;
  decimals: number;
}

export interface Party {
  address: Hex;
  label: string;
}

/** Everyone the demo knows by name. In testnet mode only `owner` and `you` are meaningful. */
export interface Parties {
  you: Party;
  heirA: Party;
  heirB: Party;
  agent: Party;
  payee: Party;
  stranger: Party;
}

export interface HeirView {
  account: Hex;
  payoutTo: Hex;
  bps: number;
  label: string;
  claimable: { token: Hex; amount: bigint }[];
}

export interface AgentView {
  agent: Hex;
  token: Hex;
  perTx: bigint;
  daily: bigint;
  spentToday: bigint;
  validUntil: number;
  payees: Hex[];
}

export interface VaultView {
  id: bigint;
  state: VaultState;
  keyMode: "ACCOUNT" | "DEVICE";
  pubkeyHash: Hex;
  nonce: number;
  /** Seconds (chain clock). */
  now: number;
  lastCheckin: number;
  interval: number;
  grace: number;
  warningAt: number;
  deadline: number;
  bounty: bigint;
  balances: { token: Hex; amount: bigint }[];
  heirs: HeirView[];
  agent: AgentView | null;
}

export interface ActionResult {
  ok: boolean;
  title: string;
  /** Short plain sentence shown under the title. */
  detail?: string;
  txHash?: Hex;
  /** Demo only: the simulated block the action landed in. The sim has no real transaction hashes. */
  simBlock?: number;
  /** The action needs an in-page confirmation before it goes ahead. */
  needsConfirm?: boolean;
  gasUsed?: bigint;
  /** Size of the PQ signature that went with this action, if any. */
  sigBytes?: number;
  /** Custom error name when the contract reverted, e.g. PQSignatureInvalid. */
  errorName?: string;
  /** Agent denial reason (the call succeeded, the payment did not happen). */
  denied?: string;
  /** Set only on the deliberate unsigned withdraw: the vault is meant to refuse it, so a failure here is a win. */
  intendedRefusal?: true;
  at: number;
}

export interface DrillRow {
  name: string;
  how: string;
  /** Value kept and vault unchanged (the call reverted, or it went through and did nothing). */
  blocked: boolean;
  /** True when the call did not revert but also moved nothing and changed nothing. */
  harmless: boolean;
  revert: string;
  valueMoved: string;
}

export interface DrillReport {
  rows: DrillRow[];
  tried: number;
  blocked: number;
  /** 0..100 */
  valueKeptPct: number;
  valueKept: string;
  distinctPaths: number;
  reachedVerifier: number;
  scope: string;
}

export interface DeviceKeyInfo {
  pubkeyHex: Hex;
  pubkeyHash: Hex;
  pubkeyBytes: number;
  sigBytes: number;
}

export interface WithdrawArgs {
  token: Hex;
  amount: bigint;
  to: Hex;
  /** false = send the call with an empty signature, which the contract must reject. */
  pq: boolean;
}

export interface AgentArgs {
  agent: Hex;
  token: Hex;
  perTx: bigint;
  daily: bigint;
  validForSeconds: number;
  payees: Hex[];
}

export interface Adapter {
  readonly kind: "demo" | "testnet";
  readonly parties: Parties;
  readonly tokens: TokenInfo[];
  /** Short description of what is underneath, shown in the header and settings. */
  readonly networkLabel: string;

  /** Testnet only: the connected wallet's account. */
  readonly connectedAccount?: Hex | null;
  /** Testnet only: two-step rotation (make and back up the new key, then send). */
  prepareRotation?(): string;
  confirmRotationBackup?(): void;

  boot(progress: (msg: string) => void): Promise<void>;
  snapshot(): Promise<VaultView | null>;

  deviceKey(): DeviceKeyInfo;
  exportKey(): string;
  importKey(text: string, confirmed?: boolean): Promise<ActionResult>;

  checkIn(): Promise<ActionResult>;
  withdraw(a: WithdrawArgs): Promise<ActionResult>;
  /** The first heir gets `bpsA`, the second the rest. */
  setHeirs(bpsA: number): Promise<ActionResult>;
  setAgent(a: AgentArgs): Promise<ActionResult>;
  revokeAgent(): Promise<ActionResult>;
  agentPay(to: Hex, amount: bigint): Promise<ActionResult>;
  rotateKey(): Promise<ActionResult>;
  heirSetPayout(heirIndex: number, newPayout: Hex): Promise<ActionResult>;

  /** Demo only. */
  advance(seconds: number): Promise<ActionResult>;
  trigger(): Promise<ActionResult>;
  settle(): Promise<ActionResult>;
  claim(heirIndex: number, token: Hex): Promise<ActionResult>;

  /** Demo only: rebuild the rig with this config (heir labels flow to VaultView.heirs[i].label). */
  createVault?(cfg: CreateConfig, progress?: (m: string) => void): Promise<ActionResult>;
  /** Demo only: the last signature the owner key produced and the chain accepted. */
  lastSignature?(): SignatureInspect | null;
  /** Demo only: real transactions; only "valid" may succeed. */
  labAttempt?(v: LabVariant): Promise<LabResult>;
  /** Demo only: the real public key bytes (2,592). */
  keyBytes?(): Uint8Array;
  /** Demo only: make the key the next createVault will use, and return its public key (2,592 bytes). */
  prepareKey?(): Uint8Array;

  drill(onRow: (row: DrillRow) => void): Promise<DrillReport>;
  reset(): Promise<void>;
}

/** Demo only: what "Create" asks for. */
export interface CreateConfig {
  /** 2 or 3 heirs, bps sum 10000. */
  heirs: { label: string; bps: number }[];
  intervalDays: number;
  /** Missed check-ins allowed (>= 1). */
  grace: number;
  /** Whole test QOR locked at creation. */
  fundQor: number;
  keyMode: "DEVICE" | "ACCOUNT";
}

/** Demo only: one real signature, typeset. */
export interface SignatureInspect {
  /** "checkIn", "withdraw", ... */
  action: string;
  /** The 8 digest fields in signing order, as typeset strings. */
  fields: { label: string; value: string }[];
  digest: Hex;
  pubkeyHash: Hex;
  pubkeyBytes: number;
  sigBytes: number;
  sig: Uint8Array;
  /** pqcVerify precompile address. */
  precompile: Hex;
  at: number;
}

export type LabVariant = "valid" | "flip-bit" | "wrong-key" | "replay" | "expired";

export interface LabResult extends ActionResult {
  /** The exact signature bytes that were sent. */
  inspect: SignatureInspect | null;
  variant: LabVariant;
  /** "flip-bit" only: index of the single signature byte that has one bit flipped. */
  flippedAt?: number;
  /** "flip-bit" only: the byte at flippedAt before the flip. */
  originalByte?: number;
}

export class UnsupportedError extends Error {}
