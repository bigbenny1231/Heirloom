/**
 * Testnet adapter: viem on QoreChain testnet (chainId 9800) with an injected EIP-1193 wallet (QoreX).
 * The wallet only pays for and submits transactions. Authority comes from the ML-DSA-87 device key,
 * which signs the QDMV digest in this page and never leaves it.
 * It needs network access and a wallet; without them it fails with plain messages instead of throwing.
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeErrorResult,
  defineChain,
  http,
  parseAbi,
  parseUnits,
  type Address,
  isAddress as viemIsAddress,
  keccak256,
  type Hex as ViemHex,
} from "viem";
import vaultJson from "@artifacts/contracts/QDMVault.sol/QDMVault.json";
import {
  Action,
  KeyMode,
  NATIVE,
  PQ_PUBKEY_LENGTH,
  PQ_SIGNATURE_LENGTH,
  checkInDigest,
  createDigest,
  pubkeyHash,
  revokeAgentDigest,
  rotateKeyDigest,
  rotateKeyPopDigest,
  setAgentDigest,
  setHeirsDigest,
  withdrawDigest,
  type CreateParams,
  type Domain,
  type Heir,
  type Signed,
} from "@lib/encoding";
import { exportDeviceKey, importDeviceKey, pqKeygen, pqSign, type PqKeyPair } from "@lib/pq";
import { vaultAbi, DENY_REASONS } from "./abi";
import { UnsupportedError } from "./types";
import type {
  ActionResult,
  Adapter,
  AgentArgs,
  DeviceKeyInfo,
  DrillReport,
  DrillRow,
  Hex,
  Parties,
  TokenInfo,
  VaultState,
  VaultView,
  WithdrawArgs,
} from "./types";
import { bytesToHex } from "viem";

export const TESTNET_CHAIN_ID = 9800;
export const TESTNET_RPC = "https://evm-testnet.qore.host";

export const qoreTestnet = defineChain({
  id: TESTNET_CHAIN_ID,
  name: "QoreChain testnet",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [TESTNET_RPC] } },
});

const erc20Abi = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const STATES: VaultState[] = ["NONE", "ALIVE", "WARNING", "OVERDUE", "TRIGGERED", "SETTLED", "CLOSED"];
const EXPIRY_SECONDS = 600n;

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
}

export function detectWallet(): Eip1193 | null {
  try {
    const w = (globalThis as unknown as { ethereum?: Eip1193 }).ethereum;
    return w && typeof w.request === "function" ? w : null;
  } catch {
    return null;
  }
}

/** Read a plain-hex contract address from `#addr=0x...`. Anything else is ignored. */
export function addressFromHash(hash: string): Hex | null {
  const m = /(?:^#|&)addr=(0x[0-9a-fA-F]{40})(?:&|$)/.exec(hash);
  return m ? (m[1] as Hex) : null;
}

export function isAddress(s: string): s is Hex {
  return viemIsAddress(s.trim(), { strict: true });
}

function failure(title: string, e: unknown): ActionResult {
  const { name, message } = explain(e);
  return { ok: false, title, detail: message, errorName: name, at: Date.now() };
}

function explain(e: unknown): { name?: string; message: string } {
  const err = e as { name?: string; shortMessage?: string; message?: string; cause?: unknown; code?: number };
  if (err?.code === 4001) return { message: "You declined the request in your wallet." };
  // viem nests the revert data a few levels down.
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur; i++) {
    const data = (cur as { data?: unknown }).data;
    const raw = typeof data === "string" ? data : (data as { data?: string } | undefined)?.data;
    if (typeof raw === "string" && raw.startsWith("0x") && raw.length >= 10) {
      try {
        const d = decodeErrorResult({ abi: vaultAbi, data: raw as ViemHex });
        return { name: d.errorName, message: `The contract refused it: ${d.errorName}.` };
      } catch {
        /* keep looking */
      }
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return { message: err?.shortMessage ?? err?.message ?? "Something went wrong." };
}

export class TestnetAdapter implements Adapter {
  readonly kind = "testnet" as const;
  readonly networkLabel = "QoreChain testnet · 9800";
  readonly tokens: TokenInfo[] = [{ address: NATIVE, symbol: "QOR", decimals: 18 }];
  parties: Parties;

  private key: PqKeyPair & { seed: Uint8Array };
  private wallet: Eip1193 | null = null;
  private account: Address | null = null;
  private contract: Address | null = null;
  private vaultId: bigint | null = null;
  private pub = createPublicClient({ chain: qoreTestnet, transport: http(TESTNET_RPC) });

  constructor() {
    this.key = pqKeygen();
    // "0x" means not known yet. The UI shows an empty field instead of the zero address.
    const p = (label: string) => ({ address: "0x" as Hex, label });
    this.parties = { you: p("You"), heirA: p("Maya"), heirB: p("Leo"), agent: p("Agent"), payee: p("Payee"), stranger: p("New address") };
  }

  // ---- setup, called by the settings sheet ------------------------------------------------------

  get connectedAccount(): Hex | null {
    return this.account;
  }
  get contractAddress(): Hex | null {
    return this.contract;
  }
  get currentVaultId(): bigint | null {
    return this.vaultId;
  }

  async connect(): Promise<Hex> {
    const w = detectWallet();
    if (!w) throw new Error("No EVM wallet found. Open this page in QoreX or another wallet browser.");
    const accounts = (await w.request({ method: "eth_requestAccounts" })) as string[];
    if (!accounts?.[0]) throw new Error("The wallet returned no account.");
    const chainHex = (await w.request({ method: "eth_chainId" })) as string;
    if (parseInt(chainHex, 16) !== TESTNET_CHAIN_ID) {
      try {
        await w.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${TESTNET_CHAIN_ID.toString(16)}` }] });
      } catch {
        throw new Error(`Switch your wallet to QoreChain testnet (chain ${TESTNET_CHAIN_ID}).`);
      }
    }
    this.wallet = w;
    this.account = accounts[0] as Address;
    this.parties = { ...this.parties, you: { address: this.account, label: "You (wallet)" } };
    return this.account;
  }

  private codeStatus: "unchecked" | "ok" | "mismatch" | "nocode" = "unchecked";
  private backupConfirmed = false;
  private pendingKey: (PqKeyPair & { seed: Uint8Array }) | null = null;
  private pendingBackedUp = false;

  setContract(addr: string): void {
    if (!isAddress(addr)) throw new Error("That is not a valid contract address (0x and 40 hex characters, checksum respected).");
    const next = addr.trim() as Address;
    if (this.contract?.toLowerCase() !== next.toLowerCase()) this.codeStatus = "unchecked";
    this.contract = next;
  }

  /** Writes stay blocked until the deployed code equals the bundled QDMVault runtime bytecode. */
  async checkContract(): Promise<"ok" | "mismatch" | "nocode"> {
    if (!this.contract) throw new Error("Enter the vault contract address first.");
    const code = await this.pub.getCode({ address: this.contract });
    if (!code || code === "0x") this.codeStatus = "nocode";
    else this.codeStatus = keccak256(code) === keccak256(vaultJson.deployedBytecode as ViemHex) ? "ok" : "mismatch";
    return this.codeStatus === "ok" ? "ok" : this.codeStatus === "nocode" ? "nocode" : "mismatch";
  }
  get contractVerified(): boolean {
    return this.codeStatus === "ok";
  }

  /** The user says they saved the backup string of the device key. Needed before creating a vault. */
  confirmBackup(): void {
    this.backupConfirmed = true;
  }
  get keyBackedUp(): boolean {
    return this.backupConfirmed;
  }

  setVaultId(raw: string): void {
    const t = raw.trim();
    if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(t)) throw new Error("A vault id is a number or 0x hex.");
    this.vaultId = BigInt(t);
  }

  /**
   * Create a DEVICE-mode vault pinned to this page's key. `qor` is deposited with the create call, and the
   * connected wallet is the sole heir until the heirs are changed.
   */
  async createDeviceVault(qor: string, intervalSeconds: number): Promise<ActionResult> {
    try {
      if (!this.backupConfirmed) throw new Error("Save your backup string first. Without the key you cannot use this vault.");
      const { c, acct } = this.need();
      const heirs: Heir[] = [{ account: acct, payoutTo: acct, bps: 10000 }];
      const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
      const p: CreateParams = { salt, interval: BigInt(intervalSeconds), grace: 2, bounty: 0n, tokens: [], heirs };
      const pkHash = pubkeyHash(this.key.publicKey);
      const expiry = (await this.chainNow()) + EXPIRY_SECONDS;
      const { vaultId, digest } = createDigest(this.domain(c), acct, KeyMode.DEVICE, pkHash, p, expiry);
      const sig = bytesToHex(pqSign(digest, this.key.secretKey));
      const hash = await this.send("createVaultFor", [acct, KeyMode.DEVICE, p, expiry, sig, bytesToHex(this.key.publicKey)], parseUnits(qor || "0", 18));
      this.vaultId = vaultId;
      return this.receipt("Create vault", hash, PQ_SIGNATURE_LENGTH);
    } catch (e) {
      return failure("Create vault", e);
    }
  }

  // ---- Adapter -------------------------------------------------------------------------------

  async boot(progress: (m: string) => void): Promise<void> {
    progress("Looking for a wallet");
    this.wallet = detectWallet();
  }

  deviceKey(): DeviceKeyInfo {
    return {
      pubkeyHex: bytesToHex(this.key.publicKey),
      pubkeyHash: pubkeyHash(this.key.publicKey),
      pubkeyBytes: PQ_PUBKEY_LENGTH,
      sigBytes: PQ_SIGNATURE_LENGTH,
    };
  }
  exportKey(): string {
    return exportDeviceKey(this.key.seed);
  }
  async importKey(text: string): Promise<ActionResult> {
    try {
      this.key = importDeviceKey(text);
      this.backupConfirmed = true;
      return { ok: true, title: "Device key imported", detail: "The vault will only accept this key if it pins the same one.", at: Date.now() };
    } catch (e) {
      return failure("Import device key", e);
    }
  }

  async snapshot(): Promise<VaultView | null> {
    if (!this.contract || this.vaultId === null) return null;
    const address = this.contract;
    const id = this.vaultId;
    const rd = <T,>(functionName: string, args: unknown[]) =>
      this.pub.readContract({ address, abi: vaultAbi, functionName, args } as never) as Promise<T>;
    const state = Number(await rd<number>("stateOf", [id]));
    if (state === 0) return null;
    const [v, dl, heirs, tokens, block] = await Promise.all([
      rd<{ keyMode: number; nonce: bigint; lastCheckin: bigint; interval: bigint; grace: number; pubkeyHash: Hex; bounty: bigint }>("getVault", [id]),
      rd<readonly [bigint, bigint]>("deadlines", [id]),
      rd<readonly { account: Hex; payoutTo: Hex; bps: number }[]>("getHeirs", [id]),
      rd<readonly Hex[]>("getTokens", [id]),
      this.pub.getBlock(),
    ]);
    const all: Hex[] = [NATIVE, ...tokens];
    for (const t of tokens) if (!this.tokens.some((x) => x.address === t)) this.tokens.push(await this.tokenInfo(t));
    const balances = await Promise.all(all.map(async (t) => ({ token: t, amount: await rd<bigint>("balanceOf", [id, t]) })));
    const heirViews = await Promise.all(
      heirs.map(async (h, i) => ({
        account: h.account,
        payoutTo: h.payoutTo,
        bps: Number(h.bps),
        label: `Heir ${i + 1}`,
        claimable: await Promise.all(all.map(async (t) => ({ token: t, amount: await rd<bigint>("claimable", [id, BigInt(i), t]) }))),
      })),
    );
    const a = await rd<{ agent: Hex; token: Hex; validUntil: bigint; perTxLimit: bigint; dailyLimit: bigint; spentToday: bigint; payees: readonly Hex[] }>("getAgent", [id]);
    return {
      id,
      state: STATES[state] ?? "NONE",
      keyMode: v.keyMode === 1 ? "DEVICE" : "ACCOUNT",
      pubkeyHash: v.pubkeyHash,
      nonce: Number(v.nonce),
      now: Number(block.timestamp),
      lastCheckin: Number(v.lastCheckin),
      interval: Number(v.interval),
      grace: Number(v.grace),
      warningAt: Number(dl[0]),
      deadline: Number(dl[1]),
      bounty: v.bounty,
      balances,
      heirs: heirViews,
      agent: a.agent === NATIVE ? null : { agent: a.agent, token: a.token, perTx: a.perTxLimit, daily: a.dailyLimit, spentToday: a.spentToday, validUntil: Number(a.validUntil), payees: [...a.payees] },
    };
  }

  async checkIn(): Promise<ActionResult> {
    return this.owner("Check in", Action.CHECKIN, (s) => checkInDigest(this.dom(), s), () => ["checkIn", []]);
  }

  async withdraw(a: WithdrawArgs): Promise<ActionResult> {
    return this.owner(
      "Withdraw",
      Action.WITHDRAW,
      (s) => withdrawDigest(this.dom(), s, a.token as Address, a.amount, a.to as Address),
      () => ["withdraw", [a.token, a.amount, a.to]],
      !a.pq,
    );
  }

  async setHeirs(bpsA: number): Promise<ActionResult> {
    const snap = await this.snapshot();
    if (!snap || snap.heirs.length < 2) return failure("Set heirs", new Error("This vault needs two heirs to change the split."));
    const heirs: Heir[] = snap.heirs.map((h, i) => ({
      account: h.account as Address,
      payoutTo: h.payoutTo as Address,
      bps: i === 0 ? bpsA : i === 1 ? 10000 - bpsA : h.bps,
    }));
    return this.owner("Set heirs", Action.SET_HEIRS, (s) => setHeirsDigest(this.dom(), s, heirs), () => ["setHeirs", [heirs]]);
  }

  async setAgent(a: AgentArgs): Promise<ActionResult> {
    const validUntil = (await this.chainNow()) + BigInt(a.validForSeconds);
    return this.owner(
      "Set agent allowance",
      Action.SET_AGENT,
      (s) => setAgentDigest(this.dom(), s, a.agent as Address, a.token as Address, a.perTx, a.daily, validUntil, a.payees as Address[]),
      () => ["setAgent", [a.agent, a.token, a.perTx, a.daily, validUntil, a.payees]],
    );
  }

  async revokeAgent(): Promise<ActionResult> {
    return this.owner("Revoke agent", Action.REVOKE_AGENT, (s) => revokeAgentDigest(this.dom(), s), () => ["revokeAgent", []]);
  }

  async agentPay(to: Hex, amount: bigint): Promise<ActionResult> {
    try {
      const { c } = this.need();
      const id = this.id();
      const hash = await this.send("agentPay", [id, to, amount]);
      const res = await this.receipt("Agent pays", hash);
      // A policy refusal does not revert; it emits AgentPayDenied.
      const logs = await this.pub.getContractEvents({ address: c, abi: vaultAbi, eventName: "AgentPayDenied", fromBlock: res.blockNumber, toBlock: res.blockNumber });
      const mine = logs.find((l) => l.transactionHash === hash);
      if (mine) {
        const r = DENY_REASONS[Number((mine.args as { reason?: number }).reason ?? 0)] ?? "NONE";
        return { ...res, ok: false, denied: r, detail: `Payment refused: ${r}.` };
      }
      return res;
    } catch (e) {
      return failure("Agent pays", e);
    }
  }

  /** Step 1: make the new key and return its backup string. Nothing is sent. */
  prepareRotation(): string {
    this.pendingKey = pqKeygen();
    this.pendingBackedUp = false;
    return exportDeviceKey(this.pendingKey.seed);
  }
  confirmRotationBackup(): void {
    if (this.pendingKey) this.pendingBackedUp = true;
  }

  /** Step 2: send the rotation. The new key stays pending until the chain agrees, so a lost reply cannot strand the vault. */
  async rotateKey(): Promise<ActionResult> {
    const next = this.pendingKey;
    try {
      if (!next || !this.pendingBackedUp) throw new Error("Make a new key and save its backup string first.");
      const { c } = this.need();
      const id = this.id();
      const nh = pubkeyHash(next.publicKey);
      const snap = await this.snapshot();
      if (!snap) throw new Error("Load a vault first.");
      const s: Signed = { vaultId: id, nonce: BigInt(snap.nonce), expiry: (await this.chainNow()) + EXPIRY_SECONDS };
      const sig = pqSign(rotateKeyDigest(this.domain(c), s, nh), this.key.secretKey);
      const pop = pqSign(rotateKeyPopDigest(this.domain(c), s, nh), next.secretKey);
      const auth = { nonce: s.nonce, expiry: s.expiry, sig: bytesToHex(sig), pubkey: bytesToHex(this.key.publicKey) };
      const hash = await this.send("rotateKey", [id, bytesToHex(next.publicKey), bytesToHex(pop), auth]);
      const res = await this.receipt("Rotate device key", hash, PQ_SIGNATURE_LENGTH * 2);
      await this.reconcileKey();
      return res;
    } catch (e) {
      const r = failure("Rotate device key", e);
      // The transaction may still have landed. Trust the chain, not the error.
      try {
        const adopted = await this.reconcileKey();
        if (adopted === "new") return { ...r, ok: true, detail: "The rotation went through. This page now holds the new key.", errorName: undefined };
      } catch {
        /* keep the failure */
      }
      return r;
    }
  }

  /** Compare the pinned hash on chain with both keys and keep whichever matches. */
  private async reconcileKey(): Promise<"new" | "old" | "unknown"> {
    const snap = await this.snapshot();
    if (!snap) return "unknown";
    const pinned = snap.pubkeyHash.toLowerCase();
    if (this.pendingKey && pubkeyHash(this.pendingKey.publicKey).toLowerCase() === pinned) {
      this.key = this.pendingKey;
      this.pendingKey = null;
      this.backupConfirmed = true;
      return "new";
    }
    return pubkeyHash(this.key.publicKey).toLowerCase() === pinned ? "old" : "unknown";
  }

  async heirSetPayout(): Promise<ActionResult> {
    return failure("Change heir payout", new UnsupportedError("An heir signs this on their own device with their registered QoreChain key. This page does not hold it."));
  }

  async advance(): Promise<ActionResult> {
    return failure("Skip time", new UnsupportedError("A real chain keeps its own clock."));
  }

  async trigger(): Promise<ActionResult> {
    return this.plain("Trigger vault", "trigger", () => [this.id()]);
  }
  async settle(): Promise<ActionResult> {
    return this.plain("Pay heirs", "settle", () => [this.id()]);
  }
  async claim(heirIndex: number, token: Hex): Promise<ActionResult> {
    return this.plain("Claim", "claim", () => [this.id(), BigInt(heirIndex), token]);
  }

  async drill(_onRow: (r: DrillRow) => void): Promise<DrillReport> {
    throw new UnsupportedError("The Q-Day drill runs in Demo mode. The live drill is a separate event.");
  }
  async reset(): Promise<void> {
    this.vaultId = null;
  }

  // ---- internals -----------------------------------------------------------------------------

  private need(): { c: Address; acct: Address } {
    if (!this.wallet || !this.account) throw new Error("Connect your wallet first.");
    if (!this.contract) throw new Error("Enter the vault contract address first.");
    return { c: this.contract, acct: this.account };
  }
  private id(): bigint {
    if (this.vaultId === null) throw new Error("Enter a vault id first.");
    return this.vaultId;
  }
  private domain(c: Address): Domain {
    return { chainId: BigInt(TESTNET_CHAIN_ID), vault: c };
  }
  private dom(): Domain {
    return this.domain(this.need().c);
  }
  private async chainNow(): Promise<bigint> {
    return (await this.pub.getBlock()).timestamp;
  }
  private async tokenInfo(address: Hex): Promise<TokenInfo> {
    try {
      const [symbol, decimals] = await Promise.all([
        this.pub.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
        this.pub.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
      ]);
      return { address, symbol, decimals };
    } catch {
      return { address, symbol: `${address.slice(0, 6)}…`, decimals: 18 };
    }
  }

  private async send(functionName: string, args: unknown[], value?: bigint): Promise<Hex> {
    const { c, acct } = this.need();
    if (this.codeStatus !== "ok") throw new Error("The contract at this address is not verified as QDMVault, so writes are blocked. Load the vault again to check it.");
    const client = createWalletClient({ account: acct, chain: qoreTestnet, transport: custom(this.wallet as Eip1193) });
    // Simulate first so a revert shows its custom error name instead of a generic wallet failure.
    await this.pub.simulateContract({ address: c, abi: vaultAbi, functionName, args, account: acct, value } as never);
    return client.writeContract({ address: c, abi: vaultAbi, functionName, args, value } as never);
  }

  private async receipt(title: string, hash: Hex, sigBytes?: number) {
    const r = await this.pub.waitForTransactionReceipt({ hash });
    return {
      ok: r.status === "success",
      title,
      txHash: hash,
      gasUsed: r.gasUsed,
      sigBytes,
      blockNumber: r.blockNumber,
      at: Date.now(),
    } satisfies ActionResult & { blockNumber: bigint };
  }

  /** Sign an owner action with the device key and submit it. `noSig` sends an empty signature on purpose. */
  private async owner(
    title: string,
    _action: Action,
    digest: (s: Signed) => Hex,
    call: () => [string, unknown[]],
    noSig = false,
  ): Promise<ActionResult> {
    let submitted = false;
    try {
      this.need();
      const id = this.id();
      const snap = await this.snapshot();
      if (!snap) throw new Error("Vault not found. Check the contract address and id.");
      const s: Signed = { vaultId: id, nonce: BigInt(snap.nonce), expiry: (await this.chainNow()) + EXPIRY_SECONDS };
      const sig: Hex = noSig ? "0x" : bytesToHex(pqSign(digest(s), this.key.secretKey));
      const auth = { nonce: s.nonce, expiry: s.expiry, sig, pubkey: bytesToHex(this.key.publicKey) };
      const [fn, args] = call();
      submitted = true;
      const hash = await this.send(fn, [id, ...args, auth]);
      const r = await this.receipt(title, hash, noSig ? 0 : PQ_SIGNATURE_LENGTH);
      return noSig && !r.ok ? { ...r, intendedRefusal: true as const } : r;
    } catch (e) {
      const f = failure(title, e);
      // The deliberate unsigned call was refused by the contract (or its simulation) with a decoded contract error:
      // that is the designed outcome. A declined wallet prompt, a network error or a setup error is not a refusal.
      if (noSig && submitted && f.errorName && (e as { code?: number })?.code !== 4001) return { ...f, sigBytes: 0, intendedRefusal: true };
      return f;
    }
  }

  private async plain(title: string, fn: string, args: () => unknown[]): Promise<ActionResult> {
    try {
      const hash = await this.send(fn, args());
      return await this.receipt(title, hash);
    } catch (e) {
      return failure(title, e);
    }
  }
}
