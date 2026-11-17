/**
 * VaultClient: one code path for "build the digest, sign with ML-DSA-87, submit" that the app, the tests
 * and the drill bot all share. It talks to any `Backend`: the in-memory sim here, or (in the app's
 * Testnet mode) a viem-backed implementation of the same four members.
 *
 * Methods never throw on a revert: they return the TxResult (`ok`, `revert.name`, `events`). Use
 * `expectOk(tx)` when you want a throw.
 *
 * Browser-safe.
 */
import {
  bytesToHex,
  decodeFunctionResult,
  encodeFunctionData,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import {
  Action,
  KeyMode,
  NATIVE,
  ZERO_HASH,
  checkInDigest,
  closeDigest,
  createDigest,
  pubkeyHash,
  revokeAgentDigest,
  rotateKeyDigest,
  rotateKeyPopDigest,
  setAgentDigest,
  setHeirsDigest,
  setPayoutDigest,
  setTimingDigest,
  withdrawDigest,
  type CreateParams,
  type Domain,
  type Heir,
  type Signed,
} from "../lib/encoding.ts";
import { pqSign, type PqKeyPair } from "../lib/pq.ts";
import type { QoreSim, TxRequest, TxResult } from "./chain.ts";

export interface Backend {
  readonly chainId: bigint;
  /** Current chain time (unix seconds) that the next tx would see. */
  now(): Promise<bigint>;
  send(req: TxRequest, abis?: Abi[]): Promise<TxResult>;
  call(req: TxRequest, abis?: Abi[]): Promise<TxResult>;
}

export function simBackend(sim: QoreSim): Backend {
  return {
    chainId: sim.chainId,
    now: async () => sim.now,
    send: (r, a) => sim.send(r, a),
    call: (r, a) => sim.call(r, a),
  };
}

/** The Auth struct the contract expects on owner actions. */
export interface AuthStruct {
  nonce: bigint;
  expiry: bigint;
  sig: Hex;
  pubkey: Hex;
}

export interface ActionOpts {
  /** Who submits the tx. Irrelevant to authority (the PQ signature is the authority). Default: client relayer. */
  sender?: Address;
  /** Absolute expiry (unix seconds). Default: chain now + ttl. */
  expiry?: bigint;
  /** Signature lifetime in seconds when `expiry` is not given. Default 600. */
  ttl?: bigint;
  /** Override the nonce (to craft a replay / wrong-nonce test). Default: read from chain. */
  nonce?: bigint;
  /** Native value sent with the tx. */
  value?: bigint;
}

export interface VaultView {
  owner: Address;
  keyMode: KeyMode;
  status: number;
  grace: number;
  interval: bigint;
  lastCheckin: bigint;
  triggeredAt: bigint;
  nonce: bigint;
  pubkeyHash: Hex;
  bounty: bigint;
}

export interface AgentView {
  agent: Address;
  token: Address;
  validUntil: bigint;
  spentDay: bigint;
  perTxLimit: bigint;
  dailyLimit: bigint;
  spentToday: bigint;
  payees: readonly Address[];
}

export class TxFailed extends Error {
  constructor(public readonly tx: TxResult) {
    super(`transaction reverted: ${tx.revert?.reason ?? "unknown"}`);
  }
}

export function expectOk(tx: TxResult): TxResult {
  if (!tx.ok) throw new TxFailed(tx);
  return tx;
}

const hex = (b: Uint8Array): Hex => bytesToHex(b);

export class VaultClient {
  readonly domain: Domain;

  constructor(
    readonly backend: Backend,
    readonly vault: Address,
    readonly abi: Abi,
    /** Default tx submitter for relayable calls. */
    readonly relayer: Address,
  ) {
    this.domain = { chainId: backend.chainId, vault };
  }

  // ------------------------------------------------------------------ plumbing

  /** Low-level: encode `fn(args)` against the vault ABI and submit as `sender`. */
  send(fn: string, args: readonly unknown[], opts: { sender?: Address; value?: bigint; gasLimit?: bigint } = {}) {
    const data = encodeFunctionData({ abi: this.abi, functionName: fn, args } as never);
    return this.backend.send(
      { from: opts.sender ?? this.relayer, to: this.vault, data, value: opts.value, gasLimit: opts.gasLimit },
      [this.abi],
    );
  }

  /** View call. Throws on revert. */
  async read<T = unknown>(fn: string, args: readonly unknown[] = []): Promise<T> {
    const data = encodeFunctionData({ abi: this.abi, functionName: fn, args } as never);
    const r = await this.backend.call({ from: this.relayer, to: this.vault, data }, [this.abi]);
    if (!r.ok) throw new TxFailed(r);
    return decodeFunctionResult({ abi: this.abi, functionName: fn, data: r.returnData } as never) as T;
  }

  private async sign(
    vaultId: bigint,
    key: PqKeyPair,
    makeDigest: (s: Signed) => Hex,
    opts: ActionOpts,
  ): Promise<{ auth: AuthStruct; signed: Signed }> {
    const v = await this.getVault(vaultId);
    const nonce = opts.nonce ?? v.nonce;
    const expiry = opts.expiry ?? (await this.backend.now()) + (opts.ttl ?? 600n);
    const signed: Signed = { vaultId, nonce, expiry };
    const sig = hex(pqSign(makeDigest(signed), key.secretKey));
    const pubkey = v.keyMode === KeyMode.DEVICE ? hex(key.publicKey) : "0x";
    return { auth: { nonce, expiry, sig, pubkey }, signed };
  }

  /** Build an Auth for a digest function without sending (drill/tests use this to craft replays). */
  async buildAuth(vaultId: bigint, key: PqKeyPair, makeDigest: (s: Signed) => Hex, opts: ActionOpts = {}) {
    return (await this.sign(vaultId, key, makeDigest, opts)).auth;
  }

  // -------------------------------------------------------------------- views

  async getVault(vaultId: bigint): Promise<VaultView> {
    return this.read<VaultView>("getVault", [vaultId]);
  }
  stateOf(vaultId: bigint): Promise<number> {
    return this.read<number>("stateOf", [vaultId]);
  }
  async deadlines(vaultId: bigint): Promise<{ warningAt: bigint; deadline: bigint }> {
    const [warningAt, deadline] = await this.read<readonly [bigint, bigint]>("deadlines", [vaultId]);
    return { warningAt, deadline };
  }
  getHeirs(vaultId: bigint): Promise<readonly Heir[]> {
    return this.read("getHeirs", [vaultId]);
  }
  getTokens(vaultId: bigint): Promise<readonly Address[]> {
    return this.read("getTokens", [vaultId]);
  }
  /** Internal vault balance (token = NATIVE for QOR). */
  balanceOf(vaultId: bigint, token: Address = NATIVE): Promise<bigint> {
    return this.read("balanceOf", [vaultId, token]);
  }
  getAgent(vaultId: bigint): Promise<AgentView> {
    return this.read("getAgent", [vaultId]);
  }
  heirNonce(vaultId: bigint, heir: Address): Promise<bigint> {
    return this.read("heirNonce", [vaultId, heir]);
  }
  claimable(vaultId: bigint, heirIndex: bigint, token: Address = NATIVE): Promise<bigint> {
    return this.read("claimable", [vaultId, heirIndex, token]);
  }
  computeVaultId(owner: Address, keyMode: KeyMode, pkHash: Hex, params: CreateParams): Promise<bigint> {
    return this.read("computeVaultId", [owner, keyMode, pkHash, params]);
  }

  // ----------------------------------------------------------------- creation

  /** ACCOUNT-mode vault owned by `sender`; no signature (the chain's key registry is the authority). */
  async createVault(params: CreateParams, opts: { sender: Address; value?: bigint }) {
    const vaultId = await this.computeVaultId(opts.sender, KeyMode.ACCOUNT, ZERO_HASH, params);
    const tx = await this.send("createVault", [params], { sender: opts.sender, value: opts.value });
    return { tx, vaultId };
  }

  /**
   * Signed creation: anyone submits. ACCOUNT: `key` must be the owner's registered account key.
   * DEVICE: `key` is the device key to pin (the signature is the proof of possession).
   */
  async createVaultFor(args: {
    owner: Address;
    keyMode: KeyMode;
    key: PqKeyPair;
    params: CreateParams;
    sender?: Address;
    value?: bigint;
    expiry?: bigint;
    ttl?: bigint;
  }) {
    const pkHash = args.keyMode === KeyMode.DEVICE ? pubkeyHash(args.key.publicKey) : ZERO_HASH;
    const expiry = args.expiry ?? (await this.backend.now()) + (args.ttl ?? 600n);
    const { vaultId, digest } = createDigest(this.domain, args.owner, args.keyMode, pkHash, args.params, expiry);
    const sig = hex(pqSign(digest, args.key.secretKey));
    const pubkey = args.keyMode === KeyMode.DEVICE ? hex(args.key.publicKey) : "0x";
    const tx = await this.send("createVaultFor", [args.owner, args.keyMode, args.params, expiry, sig, pubkey], {
      sender: args.sender,
      value: args.value,
    });
    return { tx, vaultId };
  }

  // ----------------------------------------------------------------- deposits

  depositNative(vaultId: bigint, value: bigint, sender: Address) {
    return this.send("depositNative", [vaultId], { sender, value });
  }
  depositToken(vaultId: bigint, token: Address, amount: bigint, sender: Address) {
    return this.send("depositToken", [vaultId, token, amount], { sender });
  }

  // ------------------------------------------------- owner actions (PQ-signed)

  async checkIn(vaultId: bigint, key: PqKeyPair, o: ActionOpts = {}) {
    const { auth } = await this.sign(vaultId, key, (s) => checkInDigest(this.domain, s), o);
    return this.send("checkIn", [vaultId, auth], o);
  }

  async withdraw(vaultId: bigint, key: PqKeyPair, token: Address, amount: bigint, to: Address, o: ActionOpts = {}) {
    const { auth } = await this.sign(vaultId, key, (s) => withdrawDigest(this.domain, s, token, amount, to), o);
    return this.send("withdraw", [vaultId, token, amount, to, auth], o);
  }

  async setHeirs(vaultId: bigint, key: PqKeyPair, heirs: readonly Heir[], o: ActionOpts = {}) {
    const { auth } = await this.sign(vaultId, key, (s) => setHeirsDigest(this.domain, s, heirs), o);
    return this.send("setHeirs", [vaultId, heirs, auth], o);
  }

  async setTiming(vaultId: bigint, key: PqKeyPair, interval: bigint, grace: number, bounty: bigint, o: ActionOpts = {}) {
    const { auth } = await this.sign(vaultId, key, (s) => setTimingDigest(this.domain, s, interval, grace, bounty), o);
    return this.send("setTiming", [vaultId, interval, grace, bounty, auth], o);
  }

  async setAgent(
    vaultId: bigint,
    key: PqKeyPair,
    a: {
      agent: Address;
      token?: Address;
      perTxLimit: bigint;
      dailyLimit: bigint;
      validUntil: bigint;
      payees: readonly Address[];
    },
    o: ActionOpts = {},
  ) {
    const token = a.token ?? NATIVE;
    const { auth } = await this.sign(
      vaultId,
      key,
      (s) => setAgentDigest(this.domain, s, a.agent, token, a.perTxLimit, a.dailyLimit, a.validUntil, a.payees),
      o,
    );
    return this.send(
      "setAgent",
      [vaultId, a.agent, token, a.perTxLimit, a.dailyLimit, a.validUntil, a.payees, auth],
      o,
    );
  }

  async revokeAgent(vaultId: bigint, key: PqKeyPair, o: ActionOpts = {}) {
    const { auth } = await this.sign(vaultId, key, (s) => revokeAgentDigest(this.domain, s), o);
    return this.send("revokeAgent", [vaultId, auth], o);
  }

  /** DEVICE mode: `oldKey` authorises, `newKey` proves possession (ROTATE_KEY_POP over the same nonce+expiry). */
  async rotateKey(vaultId: bigint, oldKey: PqKeyPair, newKey: PqKeyPair, o: ActionOpts = {}) {
    const newHash = pubkeyHash(newKey.publicKey);
    const { auth, signed } = await this.sign(vaultId, oldKey, (s) => rotateKeyDigest(this.domain, s, newHash), o);
    const newSig = hex(pqSign(rotateKeyPopDigest(this.domain, signed, newHash), newKey.secretKey));
    return this.send("rotateKey", [vaultId, hex(newKey.publicKey), newSig, auth], o);
  }

  async close(vaultId: bigint, key: PqKeyPair, to: Address, o: ActionOpts = {}) {
    const { auth } = await this.sign(vaultId, key, (s) => closeDigest(this.domain, s, to), o);
    return this.send("close", [vaultId, to, auth], o);
  }

  // --------------------------------------------------------------------- agent

  /** `agent` must be the vault's configured agent address. Policy refusals return ok=true with an AgentPayDenied event. */
  agentPay(vaultId: bigint, to: Address, amount: bigint, agent: Address) {
    return this.send("agentPay", [vaultId, to, amount], { sender: agent });
  }

  // ----------------------------------------------------- inheritance (anyone)

  trigger(vaultId: bigint, sender?: Address) {
    return this.send("trigger", [vaultId], { sender });
  }
  settle(vaultId: bigint, sender?: Address) {
    return this.send("settle", [vaultId], { sender });
  }
  claim(vaultId: bigint, heirIndex: bigint, token: Address = NATIVE, sender?: Address) {
    return this.send("claim", [vaultId, heirIndex, token], { sender });
  }

  /** Heir changes its payout address, signed by the heir's registered ACCOUNT key. */
  async setPayout(
    vaultId: bigint,
    heirIndex: bigint,
    newPayout: Address,
    heirKey: PqKeyPair,
    o: Omit<ActionOpts, "value"> = {},
  ) {
    const heirs = await this.getHeirs(vaultId);
    const heir = heirs[Number(heirIndex)]?.account;
    if (!heir) throw new Error("no such heir index");
    const nonce = o.nonce ?? (await this.heirNonce(vaultId, heir));
    const expiry = o.expiry ?? (await this.backend.now()) + (o.ttl ?? 600n);
    const s: Signed = { vaultId, nonce, expiry };
    const sig = hex(pqSign(setPayoutDigest(this.domain, s, heirIndex, heir, newPayout), heirKey.secretKey));
    return this.send("setPayout", [vaultId, heirIndex, newPayout, nonce, expiry, sig], o);
  }
}

export { Action };
