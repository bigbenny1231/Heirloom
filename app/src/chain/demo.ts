/**
 * Demo adapter: the real QDMVault bytecode on the in-browser chain (sim/), with real ML-DSA-87
 * signatures and the real precompile logic. Nothing here is mocked except the clock and the senders.
 */
import {
  bytesToHex,
  encodeFunctionData,
  hexToBytes,
  keccak256,
  parseAbi,
  toHex,
  type Abi,
  type Address,
} from "viem";
import {
  Action,
  KeyMode,
  NATIVE,
  PQC_VERIFY_ADDRESS,
  TAG,
  argsHash,
  checkInDigest,
  pqSign,
  PQ_PUBKEY_LENGTH,
  PQ_SIGNATURE_LENGTH,
  QoreSim,
  actionDigest,
  VaultClient,
  exportDeviceKey,
  importDeviceKey,
  pqKeygen,
  pqPubkeyHash,
  runDrill,
  simBackend,
  type CreateParams,
  type Heir,
  type AuthStruct,
  type PqKeyPair,
  type ObservedAction,
  type TxResult,
} from "@sim/index";
import vaultJson from "@artifacts/contracts/QDMVault.sol/QDMVault.json";
import tokenJson from "@artifacts/contracts/mocks/TestToken.sol/TestToken.json";
import type {
  ActionResult,
  Adapter,
  AgentArgs,
  CreateConfig,
  DeviceKeyInfo,
  DrillReport,
  DrillRow,
  Hex,
  LabResult,
  LabVariant,
  Parties,
  SignatureInspect,
  TokenInfo,
  VaultState,
  VaultView,
  WithdrawArgs,
} from "./types";
import { DENY_REASONS } from "./abi";

const STATES: VaultState[] = ["NONE", "ALIVE", "WARNING", "OVERDUE", "TRIGGERED", "SETTLED", "CLOSED"];
const E18 = 10n ** 18n;
const DAY = 86400n;
const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;

const PARTIES: Parties = {
  you: { address: addr(0xa11ce0), label: "You" },
  heirA: { address: addr(0xbea01), label: "Maya" },
  heirB: { address: addr(0xbeb02), label: "Leo" },
  agent: { address: addr(0xa6e47), label: "Agent" },
  payee: { address: addr(0xfa1e5), label: "Payee" },
  stranger: { address: addr(0xdead5), label: "New address" },
};

const heirAddr = [PARTIES.heirA.address, PARTIES.heirB.address, addr(0xbec03)];
const DEFAULT_LABELS = ["Maya", "Leo"];
const DEFAULT_CFG: CreateConfig = {
  heirs: [
    { label: DEFAULT_LABELS[0], bps: 6000 },
    { label: DEFAULT_LABELS[1], bps: 4000 },
  ],
  intervalDays: 7,
  grace: 2,
  fundQor: 500,
  keyMode: "DEVICE",
};

const OBSERVABLE = new Set(["checkIn", "withdraw", "setHeirs", "setTiming", "setAgent", "revokeAgent", "close", "rotateKey"]);
const tokenAbi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

interface Rig {
  sim: QoreSim;
  client: VaultClient;
  vaultAddr: Address;
  tokenAddr: Address;
  vaultId: bigint;
  key: PqKeyPair & { seed: Uint8Array };
  heirKeys: PqKeyPair[];
  observed: ObservedAction[];
  labels: string[];
  createTx: TxResult;
  /** Last owner signature the chain accepted, and the call that carried it (for replays). */
  cap: { last: SignatureInspect | null; replay: { fn: string; args: readonly unknown[] } | null };
}

/** Typeset the 8 digest fields exactly as the contract signs them. */
function inspectOf(
  rig: { vaultAddr: Address; sim: QoreSim; client: VaultClient },
  vaultId: bigint,
  action: Action,
  ah: Hex,
  auth: AuthStruct,
  pkHash: Hex,
  actionName: string,
): SignatureInspect {
  const { digest } = digestOf(rig.client, vaultId, action, ah, auth);
  const sig = hexToBytes(auth.sig);
  return {
    action: actionName,
    fields: [
      { label: "Tag", value: "QDMV1" },
      { label: "Chain id", value: rig.client.domain.chainId.toString() },
      { label: "Contract", value: rig.vaultAddr },
      { label: "Vault id", value: `0x${vaultId.toString(16).padStart(64, "0")}` },
      { label: "Action", value: `${action} ${Action[action]}` },
      { label: "Args hash", value: ah },
      { label: "Nonce", value: auth.nonce.toString() },
      { label: "Expiry", value: auth.expiry.toString() },
    ],
    digest,
    pubkeyHash: pkHash,
    pubkeyBytes: PQ_PUBKEY_LENGTH,
    sigBytes: sig.length,
    sig,
    precompile: PQC_VERIFY_ADDRESS as Hex,
    at: Date.now(),
  };
}

function digestOf(client: VaultClient, vaultId: bigint, action: Action, ah: Hex, auth: AuthStruct) {
  const digest = actionDigest(client.domain, vaultId, action, ah, auth.nonce, auth.expiry);
  return { digest };
}

/** Map a signed owner call to its action and args hash (same rules as sim/client.ts). */
function signedCall(fn: string, args: readonly unknown[]): { action: Action; ah: Hex; auth: AuthStruct } | null {
  const a = args as any[];
  switch (fn) {
    case "checkIn": return { action: Action.CHECKIN, ah: argsHash.checkIn(), auth: a[1] };
    case "withdraw": return { action: Action.WITHDRAW, ah: argsHash.withdraw(a[1], a[2], a[3]), auth: a[4] };
    case "setHeirs": return { action: Action.SET_HEIRS, ah: argsHash.setHeirs(a[1]), auth: a[2] };
    case "setTiming": return { action: Action.SET_TIMING, ah: argsHash.setTiming(a[1], a[2], a[3]), auth: a[4] };
    case "setAgent": return { action: Action.SET_AGENT, ah: argsHash.setAgent(a[1], a[2], a[3], a[4], a[5], a[6]), auth: a[7] };
    case "revokeAgent": return { action: Action.REVOKE_AGENT, ah: argsHash.revokeAgent(), auth: a[1] };
    case "rotateKey": return { action: Action.ROTATE_KEY, ah: argsHash.rotateKey(keccak256(a[1])), auth: a[3] };
    case "close": return { action: Action.CLOSE, ah: argsHash.close(a[1]), auth: a[2] };
    default: return null;
  }
}

function ok(title: string, tx: TxResult, extra: Partial<ActionResult> = {}, sig = true): ActionResult {
  return { ok: tx.ok, title, simBlock: Number(tx.blockNumber), gasUsed: tx.gasUsed, sigBytes: sig ? PQ_SIGNATURE_LENGTH : 0, at: Date.now(), ...failureOf(tx), ...extra };
}

function failureOf(tx: TxResult): Partial<ActionResult> {
  if (tx.ok) return {};
  return { errorName: tx.revert?.name, detail: tx.revert ? `The contract refused it: ${tx.revert.reason}.` : "The contract refused it." };
}

async function build(progress: (m: string) => void, cfg: CreateConfig = DEFAULT_CFG, given?: PqKeyPair & { seed: Uint8Array }): Promise<Rig> {
  const rig = {} as Rig;
  progress("Starting the simulated chain");
  const sim = await QoreSim.create({ blockTime: 1n });
  const abi = vaultJson.abi as Abi;
  progress("Deploying the real vault contract");
  const dep = await sim.deploy({ abi, bytecode: vaultJson.bytecode as Hex });
  const you = PARTIES.you.address;
  await sim.fund(you, (10_000n + BigInt(Math.round(cfg.fundQor))) * E18);
  const tok = await sim.deploy({ abi: tokenJson.abi as Abi, bytecode: tokenJson.bytecode as Hex }, ["Q-Day Test USD", "qUSD", you, 1_000_000n * E18], you);
  const client = new VaultClient(simBackend(sim), dep.address, abi, you);
  // Remember accepted owner calls: their calldata is public, so the drill bot replays them.
  const observed: ObservedAction[] = [];
  const rawSend = client.send.bind(client);
  const cap: Rig["cap"] = { last: null, replay: null };
  client.send = async (fn, args, o) => {
    const tx = await rawSend(fn, args, o);
    if (tx.ok && OBSERVABLE.has(fn)) observed.push({ fn: fn as ObservedAction["fn"], args });
    if (tx.ok) {
      const sc = signedCall(fn, args);
      if (sc && sc.auth.sig !== "0x" && rig.key) {
        const pk = sc.auth.pubkey !== "0x" ? hexToBytes(sc.auth.pubkey) : rig.key.publicKey;
        cap.last = inspectOf(rig, args[0] as bigint, sc.action, sc.ah, sc.auth, pqPubkeyHash(pk), fn);
        cap.replay = { fn, args };
      }
    }
    return tx;
  };

  if (!given) progress("Generating your ML-DSA-87 device key");
  const key = given ?? pqKeygen();
  Object.assign(rig, { sim, client, vaultAddr: dep.address, key });
  const heirKeys = cfg.heirs.map(() => pqKeygen());
  heirKeys.forEach((k, i) => sim.registerAccountKey(heirAddr[i], k.publicKey));
  if (cfg.keyMode === "ACCOUNT") sim.registerAccountKey(you, key.publicKey);

  progress("Creating your vault");
  const heirs: Heir[] = cfg.heirs.map((h, i) => ({ account: heirAddr[i], payoutTo: heirAddr[i], bps: h.bps }));
  const fund = BigInt(Math.round(cfg.fundQor)) * E18;
  const bounty = fund / 10n < E18 ? fund / 10n : E18;
  const params: CreateParams = {
    salt: keccak256(toHex("qdmv-demo")),
    interval: BigInt(cfg.intervalDays) * DAY,
    grace: cfg.grace,
    bounty,
    tokens: [tok.address],
    heirs,
  };
  const created = await client.createVaultFor({ owner: you, keyMode: cfg.keyMode === "ACCOUNT" ? KeyMode.ACCOUNT : KeyMode.DEVICE, key, params, value: fund });
  if (!created.tx.ok) throw new Error(`Could not create the vault: ${created.tx.revert?.reason}`);
  const vaultId = created.vaultId;

  progress("Depositing 1,200 sample qUSD (test token)");
  await sim.send({ from: you, to: tok.address, data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [dep.address, 1_200n * E18] }) });
  const dtx = await client.depositToken(vaultId, tok.address, 1_200n * E18, you);
  if (!dtx.ok) throw new Error(`Could not deposit tokens: ${dtx.revert?.reason}`);

  progress("Adding a sample agent allowance (5 QOR cap)");
  const ag = await client.setAgent(vaultId, key, {
    agent: PARTIES.agent.address,
    perTxLimit: 5n * E18,
    dailyLimit: 20n * E18,
    validUntil: sim.now + 30n * DAY,
    payees: [PARTIES.payee.address],
  });
  if (!ag.ok) throw new Error(`Could not set the agent: ${ag.revert?.reason}`);
  return Object.assign(rig, { sim, client, vaultAddr: dep.address, tokenAddr: tok.address, vaultId, key, heirKeys, observed, labels: cfg.heirs.map((h) => h.label), createTx: created.tx, cap });
}

export async function createDemoAdapter(progress: (m: string) => void): Promise<Adapter> {
  const a = new DemoAdapter();
  await a.boot(progress);
  return a;
}

class DemoAdapter implements Adapter {
  readonly kind = "demo" as const;
  readonly networkLabel = "Simulated chain · real bytecode";
  readonly parties: Parties = {
    you: { ...PARTIES.you }, heirA: { ...PARTIES.heirA }, heirB: { ...PARTIES.heirB },
    agent: { ...PARTIES.agent }, payee: { ...PARTIES.payee }, stranger: { ...PARTIES.stranger },
  };
  tokens: TokenInfo[] = [{ address: NATIVE, symbol: "QOR", decimals: 18 }];
  private rig!: Rig;
  private pending: (PqKeyPair & { seed: Uint8Array }) | null = null;

  async boot(progress: (m: string) => void): Promise<void> {
    this.rig = await build(progress);
    this.tokens = [
      { address: NATIVE, symbol: "QOR", decimals: 18 },
      { address: this.rig.tokenAddr, symbol: "qUSD", decimals: 18 },
    ];
  }

  async reset(): Promise<void> {
    this.pending = null;
    this.parties.heirA.label = DEFAULT_LABELS[0];
    this.parties.heirB.label = DEFAULT_LABELS[1];
    this.rig = await build(() => {});
    this.tokens = [
      { address: NATIVE, symbol: "QOR", decimals: 18 },
      { address: this.rig.tokenAddr, symbol: "qUSD", decimals: 18 },
    ];
  }

  async snapshot(): Promise<VaultView | null> {
    const { client, vaultId, sim } = this.rig;
    const state = Number(await client.stateOf(vaultId));
    if (state === 0) return null;
    const [v, dl, heirs, toks] = await Promise.all([client.getVault(vaultId), client.deadlines(vaultId), client.getHeirs(vaultId), client.getTokens(vaultId)]);
    const assets: Address[] = [NATIVE, ...toks];
    const balances = await Promise.all(assets.map(async (t) => ({ token: t as Hex, amount: await client.balanceOf(vaultId, t) })));
    const heirViews = await Promise.all(
      heirs.map(async (h, i) => ({
        account: h.account as Hex,
        payoutTo: h.payoutTo as Hex,
        bps: Number(h.bps),
        label: this.rig.labels[i] ?? `Heir ${i + 1}`,
        claimable: await Promise.all(assets.map(async (t) => ({ token: t as Hex, amount: await client.claimable(vaultId, BigInt(i), t) }))),
      })),
    );
    const ag = await client.getAgent(vaultId);
    return {
      id: vaultId,
      state: STATES[state] ?? "NONE",
      keyMode: v.keyMode === KeyMode.DEVICE ? "DEVICE" : "ACCOUNT",
      pubkeyHash: v.pubkeyHash,
      nonce: Number(v.nonce),
      now: Number(sim.now),
      lastCheckin: Number(v.lastCheckin),
      interval: Number(v.interval),
      grace: v.grace,
      warningAt: Number(dl.warningAt),
      deadline: Number(dl.deadline),
      bounty: v.bounty,
      balances,
      heirs: heirViews,
      agent: ag.agent === NATIVE ? null : { agent: ag.agent as Hex, token: ag.token as Hex, perTx: ag.perTxLimit, daily: ag.dailyLimit, spentToday: ag.spentToday, validUntil: Number(ag.validUntil), payees: [...ag.payees] as Hex[] },
    };
  }

  deviceKey(): DeviceKeyInfo {
    const pk = this.rig.key.publicKey;
    return { pubkeyHex: bytesToHex(pk), pubkeyHash: pqPubkeyHash(pk), pubkeyBytes: PQ_PUBKEY_LENGTH, sigBytes: PQ_SIGNATURE_LENGTH };
  }
  exportKey(): string {
    return exportDeviceKey(this.rig.key.seed);
  }
  async importKey(text: string, confirmed = false): Promise<ActionResult> {
    try {
      const next = importDeviceKey(text);
      const same = pqPubkeyHash(next.publicKey) === (await this.snapshot())?.pubkeyHash;
      if (!same && !confirmed) {
        return { ok: false, needsConfirm: true, title: "Import device key", detail: "This is not the key the vault pins. Signed actions would be refused. Import it anyway?", at: Date.now() };
      }
      this.rig.key = next;
      return { ok: true, title: "Device key imported", detail: same ? "This is the key the vault pins." : "It does not match the vault's pinned key, so signed actions will be refused.", at: Date.now() };
    } catch (e) {
      return { ok: false, title: "Import device key", detail: e instanceof Error ? e.message : "Bad key.", at: Date.now() };
    }
  }

  async checkIn() {
    const { client, vaultId, key } = this.rig;
    return ok("Check in", await client.checkIn(vaultId, key));
  }

  async withdraw(a: WithdrawArgs) {
    const { client, vaultId, key, sim } = this.rig;
    if (a.pq) return ok("Withdraw", await client.withdraw(vaultId, key, a.token, a.amount, a.to, {}));
    // Same call, empty signature: a thief with the classical key has nothing else to send.
    const v = await client.getVault(vaultId);
    const auth = { nonce: v.nonce, expiry: sim.now + 600n, sig: "0x" as Hex, pubkey: bytesToHex(key.publicKey) };
    const tx = await client.send("withdraw", [vaultId, a.token, a.amount, a.to, auth]);
    return ok("Withdraw without a signature", tx, tx.ok ? { detail: "That should have been refused." } : { intendedRefusal: true }, false);
  }

  async setHeirs(bpsA: number) {
    const { client, vaultId, key } = this.rig;
    const cur = await client.getHeirs(vaultId);
    const rest = cur.slice(2).reduce((n, h) => n + Number(h.bps), 0);
    const bpsB = 10000 - bpsA - rest;
    const heirs: Heir[] = cur.map((h, i) => ({ account: h.account, payoutTo: h.payoutTo, bps: i === 0 ? bpsA : i === 1 ? bpsB : Number(h.bps) }));
    const [la, lb] = this.rig.labels;
    return ok("Set heirs", await client.setHeirs(vaultId, key, heirs), { detail: `${la} ${bpsA / 100}%, ${lb} ${bpsB / 100}%.` });
  }

  async setAgent(a: AgentArgs) {
    const { client, vaultId, key, sim } = this.rig;
    return ok("Set agent allowance", await client.setAgent(vaultId, key, { agent: a.agent as Address, token: a.token as Address, perTxLimit: a.perTx, dailyLimit: a.daily, validUntil: sim.now + BigInt(a.validForSeconds), payees: a.payees as Address[] }));
  }

  async revokeAgent() {
    const { client, vaultId, key } = this.rig;
    return ok("Revoke agent", await client.revokeAgent(vaultId, key));
  }

  async agentPay(to: Hex, amount: bigint) {
    const { client, vaultId } = this.rig;
    const ag = await client.getAgent(vaultId);
    if (ag.agent === NATIVE) return { ok: false, title: "Agent pays", detail: "No agent is set.", at: Date.now() };
    const tx = await client.agentPay(vaultId, to, amount, ag.agent);
    const denied = tx.events.find((e) => e.eventName === "AgentPayDenied");
    if (denied) {
      const reason = DENY_REASONS[Number(denied.args.reason)] ?? "NONE";
      return ok("Agent pays", tx, { ok: false, denied: reason, detail: `The vault refused the payment: ${reason}. No money moved.` }, false);
    }
    return ok("Agent pays", tx, { detail: tx.ok ? "Paid inside the allowance." : undefined }, false);
  }

  async rotateKey() {
    const { client, vaultId, key } = this.rig;
    const next = pqKeygen();
    const tx = await client.rotateKey(vaultId, key, next);
    if (tx.ok) this.rig.key = next;
    return ok("Rotate device key", tx, { sigBytes: PQ_SIGNATURE_LENGTH * 2, detail: tx.ok ? "The old key no longer works. Back up the new one." : undefined });
  }

  async heirSetPayout(heirIndex: number, newPayout: Hex) {
    const { client, vaultId, heirKeys } = this.rig;
    const tx = await client.setPayout(vaultId, BigInt(heirIndex), newPayout as Address, heirKeys[heirIndex]);
    return ok("Change heir payout", tx, { detail: tx.ok ? `Signed by ${this.rig.labels[heirIndex] ?? `Heir ${heirIndex + 1}`}'s key, not yours.` : undefined });
  }

  async advance(seconds: number): Promise<ActionResult> {
    this.rig.sim.advanceTime(seconds);
    const d = seconds / 86400;
    return { ok: true, title: `Skip ${d >= 1 ? `${d} day${d === 1 ? "" : "s"}` : `${seconds} s`}`, detail: "Only the simulated clock moved.", at: Date.now() };
  }

  async trigger() {
    const { client, vaultId } = this.rig;
    const before = await client.balanceOf(vaultId, NATIVE);
    const tx = await client.trigger(vaultId, PARTIES.stranger.address);
    let detail = "Anyone may call this once the vault is overdue.";
    if (tx.ok) {
      const after = await client.balanceOf(vaultId, NATIVE);
      detail = `The caller earned the ${fmt(before - after)} QOR keeper bounty. ${fmt(after)} QOR is left for the heirs.`;
    }
    return ok("Trigger vault", tx, { detail }, false);
  }
  async settle() {
    const { client, vaultId } = this.rig;
    return ok("Pay heirs", await client.settle(vaultId, PARTIES.stranger.address), {}, false);
  }
  async claim(heirIndex: number, token: Hex) {
    const { client, vaultId } = this.rig;
    return ok("Claim", await client.claim(vaultId, BigInt(heirIndex), token, PARTIES.stranger.address), {}, false);
  }

  keyBytes(): Uint8Array {
    return (this.pending ?? this.rig.key).publicKey;
  }

  prepareKey(): Uint8Array {
    this.pending = pqKeygen();
    return this.pending.publicKey;
  }

  lastSignature(): SignatureInspect | null {
    return this.rig.cap.last;
  }

  async createVault(cfg: CreateConfig, progress: (m: string) => void = () => {}): Promise<ActionResult> {
    const bad = (detail: string): ActionResult => ({ ok: false, title: "Seal the vault", detail, at: Date.now() });
    if (cfg.heirs.length < 2 || cfg.heirs.length > 3) return bad("Name two or three heirs.");
    if (cfg.heirs.some((h) => !h.label.trim() || !Number.isInteger(h.bps) || h.bps <= 0)) return bad("Every heir needs a name and a share.");
    if (cfg.heirs.reduce((n, h) => n + h.bps, 0) !== 10000) return bad("The shares must add up to 100%.");
    if (!Number.isInteger(cfg.intervalDays) || cfg.intervalDays < 1 || cfg.intervalDays > 365) return bad("Pick a heartbeat interval of 1 to 365 days.");
    if (!Number.isInteger(cfg.grace) || !Number.isInteger(cfg.grace) || cfg.grace < 1 || cfg.grace > 12) return bad("Pick a grace of 1 to 12 missed check-ins.");
    if (!Number.isInteger(cfg.fundQor) || cfg.fundQor < 1 || cfg.fundQor > 1_000_000) return bad("Lock a whole number of test QOR, 1 to 1,000,000.");
    const clean = { ...cfg, heirs: cfg.heirs.map((h) => ({ ...h, label: h.label.trim() })) };
    try {
      this.rig = await build(progress, clean, this.pending ?? undefined);
    } catch (e) {
      return bad(e instanceof Error ? e.message : "The vault could not be created.");
    }
    this.pending = null;
    this.tokens = [
      { address: NATIVE, symbol: "QOR", decimals: 18 },
      { address: this.rig.tokenAddr, symbol: "qUSD", decimals: 18 },
    ];
    this.parties.heirA.label = clean.heirs[0].label;
    this.parties.heirB.label = clean.heirs[1].label;
    return ok("Seal the vault", this.rig.createTx, { detail: `${clean.heirs.map((h) => `${h.label} ${h.bps / 100}%`).join(", ")}. Locked ${clean.fundQor} QOR.` });
  }

  async labAttempt(variant: LabVariant): Promise<LabResult> {
    const { client, vaultId, key, sim } = this.rig;
    const titles: Record<LabVariant, string> = {
      valid: "Send it as signed",
      "flip-bit": "Flip one bit and send",
      "wrong-key": "Sign with a different key",
      replay: "Replay an old signature",
      expired: "Send an expired signature",
    };
    const v = await client.getVault(vaultId);
    const pkHash = v.pubkeyHash;
    const mk = (s: { vaultId: bigint; nonce: bigint; expiry: bigint }) => checkInDigest(client.domain, s);
    let fn = "checkIn";
    let args: unknown[];
    let inspect: SignatureInspect | null;
    let flippedAt: number | undefined;
    let originalByte: number | undefined;
    if (variant === "replay") {
      if (!this.rig.cap.replay) await client.checkIn(vaultId, key);
      const old = this.rig.cap.replay!;
      fn = old.fn;
      args = [...old.args];
      const sc = signedCall(fn, args)!;
      inspect = inspectOf(this.rig, vaultId, sc.action, sc.ah, sc.auth, pkHash, fn);
    } else {
      let auth: AuthStruct;
      if (variant === "expired") {
        auth = await client.buildAuth(vaultId, key, mk, { expiry: sim.now - 10n });
      } else if (variant === "wrong-key") {
        const other = pqKeygen();
        const good = await client.buildAuth(vaultId, key, mk);
        auth = { ...good, sig: bytesToHex(pqSign(mk({ vaultId, nonce: good.nonce, expiry: good.expiry }), other.secretKey)) };
      } else {
        auth = await client.buildAuth(vaultId, key, mk);
        if (variant === "flip-bit") {
          const sig = hexToBytes(auth.sig);
          flippedAt = Math.floor(sig.length / 2);
          originalByte = sig[flippedAt];
          sig[flippedAt] ^= 0x01;
          auth = { ...auth, sig: bytesToHex(sig) };
        }
      }
      args = [vaultId, auth];
      inspect = inspectOf(this.rig, vaultId, Action.CHECKIN, argsHash.checkIn(), auth, pkHash, "checkIn");
    }
    const tx = await client.send(fn, args);
    const sigBytes = inspect?.sigBytes ?? PQ_SIGNATURE_LENGTH;
    const extra: Partial<ActionResult> = tx.ok
      ? { detail: "The chain verified the signature with pqcVerify and accepted it.", sigBytes }
      : { sigBytes };
    const res = ok(titles[variant], tx, extra);
    if (tx.ok && inspect) this.rig.cap.last = inspect;
    return { ...res, sigBytes, inspect, variant, ...(flippedAt !== undefined ? { flippedAt, originalByte } : {}) };
  }

  async drill(onRow: (row: DrillRow) => void): Promise<DrillReport> {
    const snap = await this.snapshot();
    const live = snap && (snap.state === "ALIVE" || snap.state === "WARNING" || snap.state === "OVERDUE");
    if (!snap || !live || snap.balances.every((b) => b.amount === 0n)) throw new Error("Vault is empty or no longer active.");
    return runDrillForApp(this.rig, onRow);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runDrillForApp(rig: Rig, onRow: (row: DrillRow) => void): Promise<DrillReport> {
  const { sim, client, vaultId, key } = rig;
  // Let the page paint "Attacking" before the CPU-heavy part starts.
  await sleep(30);
  const before = await rig.client.balanceOf(vaultId, NATIVE);
  const tokenBefore = await client.balanceOf(vaultId, rig.tokenAddr);
  const rep = await runDrill({
    sim,
    client,
    vaultId,
    owner: PARTIES.you.address,
    attacker: PARTIES.stranger.address,
    observed: [...rig.observed],
    ownerPubkey: bytesToHex(key.publicKey),
  });
  const rows: DrillRow[] = [];
  for (const a of rep.attacks) {
    const tokenMoved = Object.values(a.movedTokens).reduce((x, y) => x + y, 0n);
    const moved = [a.movedNative > 0n ? `${fmt(a.movedNative)} QOR` : "", tokenMoved > 0n ? `${fmt(tokenMoved)} qUSD` : ""].filter(Boolean).join(" + ") || "0";
    const harmless = a.outcome === "executed" && a.valueMoved === 0n && !a.vaultMutated;
    const row: DrillRow = {
      name: titleCase(a.title),
      how: `${a.fn} as ${a.sender === PARTIES.you.address ? "the owner's classical key" : "the attacker"}`,
      blocked: a.outcome === "rejected" || harmless,
      harmless,
      revert: a.revertName ?? a.revertReason ?? (harmless ? "succeeded, changed nothing" : "succeeded"),
      valueMoved: moved,
    };
    rows.push(row);
    onRow(row);
    await sleep(70);
  }
  const dist = (rep as unknown as { distinctPaths?: number }).distinctPaths ?? rep.attempted;
  const reached = (rep as unknown as { reachedVerifier?: number }).reachedVerifier ?? 0;
  const scope = (rep as unknown as { scope?: string }).scope ?? "Attacks run with the owner's classical key against this vault, on the simulated chain.";
  const tokenMovedTotal = Object.values(rep.totalMovedTokens).reduce((x, y) => x + y, 0n);
  const keptOf = (start: bigint, moved: bigint) => (start === 0n ? null : Math.max(0, Number(((start - moved) * 10000n) / start) / 100));
  const pct = (n: number) => `${n % 1 === 0 ? n.toFixed(0) : n.toFixed(1)}%`;
  const parts: { sym: string; kept: number }[] = [];
  const kq = keptOf(before, rep.totalMovedNative);
  const kt = keptOf(tokenBefore, tokenMovedTotal);
  if (kq !== null) parts.push({ sym: "QOR", kept: kq });
  if (kt !== null) parts.push({ sym: "qUSD", kept: kt });
  return {
    rows,
    tried: rep.attempted,
    blocked: rows.filter((r) => r.blocked).length,
    valueKeptPct: parts.length ? Math.min(...parts.map((p) => p.kept)) : 0,
    valueKept: parts.map((p) => `${p.sym} ${pct(p.kept)}`).join(", "),
    distinctPaths: dist,
    reachedVerifier: reached,
    scope,
  };
}

const fmt = (v: bigint) => (Number(v) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 4 });
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
