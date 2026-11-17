/**
 * Shared test world: deploys QDMVault, installs the PQ precompile mock at 0x..0a01 / 0x..0a02, and gives
 * helpers to sign owner/heir actions with real ML-DSA-87 and register them in the mock.
 */
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, keccak256, parseEther, zeroAddress, type Address, type Hex } from "viem";
import {
  Action,
  KeyMode,
  NATIVE,
  PQC_KEY_STATUS_ADDRESS,
  PQC_VERIFY_ADDRESS,
  ZERO_HASH,
  checkInDigest,
  closeDigest,
  createDigest,
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
} from "../lib/encoding.js";
import { pqKey, signDigest, verifyReal, type PQKey } from "./pq.js";

// One network per process via create(); isolation between test files comes from resetting the mock in deployWorld.
export const conn = await network.create();
export const { viem, networkHelpers } = conn;
export const publicClient = await viem.getPublicClient();
export const testClient = await viem.getTestClient();

export const DAY = 86400;
export const E18 = 10n ** 18n;
export { NATIVE, KeyMode, Action, ZERO_HASH, zeroAddress, parseEther };

export interface Auth {
  nonce: bigint;
  expiry: bigint;
  sig: Hex;
  pubkey: Hex;
}

// ---------------------------------------------------------------- error helpers

function causes(e: any): any[] {
  const out: any[] = [];
  let c = e;
  while (c && out.length < 12) {
    out.push(c);
    c = c.cause;
  }
  return out;
}

/** Name (and args) of the custom error behind a viem failure, or undefined. */
export function revertInfo(e: any): { name?: string; args?: readonly unknown[]; message: string } {
  for (const c of causes(e)) {
    if (c?.data?.errorName) return { name: c.data.errorName, args: c.data.args, message: String(e?.shortMessage ?? e?.message) };
    if (c?.errorName) return { name: c.errorName, args: c.args, message: String(e?.shortMessage ?? e?.message) };
  }
  const message = causes(e).map((c) => c?.shortMessage ?? c?.message ?? "").join(" | ");
  // Errors from contracts outside the vault ABI (OpenZeppelin ERC-20 errors) only show up in the node's message.
  const m = /custom error '([A-Za-z0-9_]+)\(/.exec(message);
  if (m) return { name: m[1], message };
  return { message };
}

const norm = (v: unknown): unknown =>
  typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : Array.isArray(v) ? v.map(norm) : v;

/** Assert that the promise rejects with the named custom error (optionally with exact args). */
export async function expectError(p: Promise<unknown>, name: string, args?: readonly unknown[]): Promise<void> {
  try {
    await p;
  } catch (e) {
    const info = revertInfo(e);
    assert.equal(info.name, name, `expected ${name}, got ${info.name ?? "(no custom error)"}: ${info.message}`);
    if (args) assert.deepEqual(norm(info.args), norm(args), `${name} args`);
    return;
  }
  assert.fail(`expected revert ${name}, but the call succeeded`);
}

/** Assert any revert (used for OZ errors or reverts with no custom-error data). */
export async function expectRevert(p: Promise<unknown>, containing?: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    const info = revertInfo(e);
    if (containing) assert.ok(info.message.includes(containing) || info.name === containing, `revert reason ${info.name ?? info.message}`);
    return;
  }
  assert.fail("expected revert, but the call succeeded");
}

// -------------------------------------------------------------------- the world

export async function deployWorld() {
  const wallets = await viem.getWalletClients();
  const [deployer, owner, heir1, heir2, heir3, agent, attacker, payee1, payee2, payee3, relayer] = wallets;
  const chainId = BigInt(await publicClient.getChainId());

  // Install the mock bytecode at both precompile addresses (separate storage at each address).
  const impl = await viem.deployContract("MockQorePQC");
  const code = (await publicClient.getCode({ address: impl.address }))!;
  await testClient.setCode({ address: PQC_VERIFY_ADDRESS, bytecode: code });
  await testClient.setCode({ address: PQC_KEY_STATUS_ADDRESS, bytecode: code });
  const a01 = await viem.getContractAt("MockQorePQC", PQC_VERIFY_ADDRESS);
  const a02 = await viem.getContractAt("MockQorePQC", PQC_KEY_STATUS_ADDRESS);
  // setCode keeps old storage: bump the epoch so no registration, flag or raw answer leaks in from an earlier fixture/file.
  await a01.write.reset();
  await a02.write.reset();

  const vault = await viem.deployContract("QDMVault");
  const domain: Domain = { chainId, vault: vault.address };

  const w = {
    wallets, deployer, owner, heir1, heir2, heir3, agent, attacker, payee1, payee2, payee3, relayer,
    chainId, a01, a02, vault, domain,
  };
  return w;
}
export type World = Awaited<ReturnType<typeof deployWorld>>;

/** Register a real signature in the mock (only after noble verified it inside signDigest). */
export async function accept(w: World, key: PQKey, digest: Hex, sig: Hex) {
  if (!verifyReal(key, digest, sig)) throw new Error("harness refuses to register a signature that noble ML-DSA-87 does not verify");
  await w.a01.write.accept([key.hash, keccak256(digest), keccak256(sig)]);
}

/** Mark `account` as having `key` registered with proven possession (ACCOUNT mode / heirs). */
export async function registerAccount(w: World, account: Address, key: PQKey, o: { registered?: boolean; alg?: number; proven?: boolean } = {}) {
  await w.a02.write.setKeyStatus([account, o.registered ?? true, o.alg ?? 1, key.pubHex, o.proven ?? true]);
}

export async function now(): Promise<bigint> {
  return BigInt(await networkHelpers.time.latest());
}

export async function warpTo(ts: bigint | number) {
  await networkHelpers.time.increaseTo(ts);
}
export async function warpBy(sec: bigint | number) {
  await networkHelpers.time.increase(Number(sec));
}

// ------------------------------------------------------------------ signing

export interface SignOpts {
  nonce?: bigint;
  expiry?: bigint;
  /** register the triple in the mock (default true). false = the precompile will answer "invalid". */
  register?: boolean;
  /** digest domain override (wrong chain / wrong contract tests) */
  domain?: Domain;
  /** vault id override inside the digest (wrong vault tests) */
  digestVaultId?: bigint;
}

/** Build an Auth for any owner action. `digestFn` builds the digest for the action being signed. */
export async function signAuth(
  w: World,
  vaultId: bigint,
  key: PQKey,
  mode: KeyMode,
  digestFn: (d: Domain, s: Signed) => Hex,
  o: SignOpts = {},
): Promise<Auth> {
  const nonce = o.nonce ?? BigInt((await w.vault.read.getVault([vaultId])).nonce);
  const expiry = o.expiry ?? (await now()) + 600n;
  const digest = digestFn(o.domain ?? w.domain, { vaultId: o.digestVaultId ?? vaultId, nonce, expiry });
  const sig = signDigest(key, digest);
  if (o.register !== false) await accept(w, key, digest, sig);
  return { nonce, expiry, sig, pubkey: mode === KeyMode.DEVICE ? key.pubHex : "0x" };
}

// ----------------------------------------------------------- owner action table

type Wc = World["owner"];
export interface OwnerAct {
  name: string;
  action: Action;
  digest: (d: Domain, s: Signed) => Hex;
  send: (w: World, id: bigint, auth: Auth, from?: Wc) => Promise<Hex>;
}

const W = (w: World, from?: Wc) => (from ? w.vault.write : w.vault.write);
const acct = (w: World, from?: Wc) => ({ account: (from ?? w.relayer).account });

export const act = {
  checkIn: (): OwnerAct => ({
    name: "checkIn", action: Action.CHECKIN,
    digest: (d, s) => checkInDigest(d, s),
    send: (w, id, a, f) => w.vault.write.checkIn([id, a], acct(w, f)),
  }),
  withdraw: (token: Address, amount: bigint, to: Address): OwnerAct => ({
    name: "withdraw", action: Action.WITHDRAW,
    digest: (d, s) => withdrawDigest(d, s, token, amount, to),
    send: (w, id, a, f) => w.vault.write.withdraw([id, token, amount, to, a], acct(w, f)),
  }),
  setHeirs: (heirs: Heir[]): OwnerAct => ({
    name: "setHeirs", action: Action.SET_HEIRS,
    digest: (d, s) => setHeirsDigest(d, s, heirs),
    send: (w, id, a, f) => w.vault.write.setHeirs([id, heirs, a], acct(w, f)),
  }),
  setTiming: (interval: bigint, grace: number, bounty: bigint): OwnerAct => ({
    name: "setTiming", action: Action.SET_TIMING,
    digest: (d, s) => setTimingDigest(d, s, interval, grace, bounty),
    send: (w, id, a, f) => w.vault.write.setTiming([id, interval, grace, bounty, a], acct(w, f)),
  }),
  setAgent: (agent: Address, token: Address, perTx: bigint, daily: bigint, validUntil: bigint, payees: Address[]): OwnerAct => ({
    name: "setAgent", action: Action.SET_AGENT,
    digest: (d, s) => setAgentDigest(d, s, agent, token, perTx, daily, validUntil, payees),
    send: (w, id, a, f) => w.vault.write.setAgent([id, agent, token, perTx, daily, validUntil, payees, a], acct(w, f)),
  }),
  revokeAgent: (): OwnerAct => ({
    name: "revokeAgent", action: Action.REVOKE_AGENT,
    digest: (d, s) => revokeAgentDigest(d, s),
    send: (w, id, a, f) => w.vault.write.revokeAgent([id, a], acct(w, f)),
  }),
  close: (to: Address): OwnerAct => ({
    name: "close", action: Action.CLOSE,
    digest: (d, s) => closeDigest(d, s, to),
    send: (w, id, a, f) => w.vault.write.close([id, to, a], acct(w, f)),
  }),
  /** Rotation: the PoP by the new key is signed at send time from the auth's own nonce and expiry. */
  rotate: (newKey: PQKey, opts: { popKey?: PQKey; registerPop?: boolean } = {}): OwnerAct => ({
    name: "rotateKey", action: Action.ROTATE_KEY,
    digest: (d, s) => rotateKeyDigest(d, s, newKey.hash),
    send: async (w, id, a, f) => {
      const popDigest = rotateKeyPopDigest(w.domain, { vaultId: id, nonce: a.nonce, expiry: a.expiry }, newKey.hash);
      const signer = opts.popKey ?? newKey;
      const popSig = signDigest(signer, popDigest);
      if (opts.registerPop !== false) await accept(w, signer, popDigest, popSig);
      return w.vault.write.rotateKey([id, newKey.pubHex, popSig, a], acct(w, f));
    },
  }),
};
void W;

/** Sign and submit an owner action in one go (happy path). */
export async function doOwner(w: World, vaultId: bigint, key: PQKey, mode: KeyMode, a: OwnerAct, o: SignOpts = {}) {
  const auth = await signAuth(w, vaultId, key, mode, a.digest, o);
  return a.send(w, vaultId, auth);
}

// ------------------------------------------------------------- vault creation

export interface Scenario {
  w: World;
  vaultId: bigint;
  mode: KeyMode;
  key: PQKey;
  params: CreateParams;
}

export function defaultHeirs(w: World): Heir[] {
  return [
    { account: w.heir1.account.address, payoutTo: w.heir1.account.address, bps: 5000 },
    { account: w.heir2.account.address, payoutTo: w.heir2.account.address, bps: 3000 },
    { account: w.heir3.account.address, payoutTo: w.heir3.account.address, bps: 2000 },
  ];
}

export function params(w: World, over: Partial<CreateParams> = {}): CreateParams {
  return {
    salt: keccak256("0x01"),
    interval: 3600n,
    grace: 2,
    bounty: 0n,
    tokens: [],
    heirs: defaultHeirs(w),
    ...over,
  };
}

/** Register heir account keys (needed for setPayout). */
export async function registerHeirs(w: World) {
  await registerAccount(w, w.heir1.account.address, pqKey("heir1"));
  await registerAccount(w, w.heir2.account.address, pqKey("heir2"));
  await registerAccount(w, w.heir3.account.address, pqKey("heir3"));
}

/** ACCOUNT-mode vault owned by w.owner via createVault(). */
export async function makeAccountVault(w: World, over: Partial<CreateParams> = {}, value = 0n): Promise<Scenario> {
  const key = pqKey("owner");
  await registerAccount(w, w.owner.account.address, key);
  const p = params(w, over);
  const vaultId = await w.vault.read.computeVaultId([w.owner.account.address, KeyMode.ACCOUNT, ZERO_HASH, p]);
  await w.vault.write.createVault([p], { account: w.owner.account, value });
  return { w, vaultId, mode: KeyMode.ACCOUNT, key, params: p };
}

/** DEVICE-mode vault created by createVaultFor() with a PoP signature, submitted by the relayer. */
export async function makeDeviceVault(w: World, over: Partial<CreateParams> = {}, value = 0n, keyLabel = "device"): Promise<Scenario> {
  const key = pqKey(keyLabel);
  const p = params(w, over);
  const owner = w.owner.account.address;
  const expiry = (await now()) + 600n;
  const { vaultId, digest } = createDigest(w.domain, owner, KeyMode.DEVICE, key.hash, p, expiry);
  const sig = signDigest(key, digest);
  await accept(w, key, digest, sig);
  await w.vault.write.createVaultFor([owner, KeyMode.DEVICE, p, expiry, sig, key.pubHex], { account: w.relayer.account, value });
  return { w, vaultId, mode: KeyMode.DEVICE, key, params: p };
}

/** ACCOUNT-mode vault created for the owner by a relayer with a PQ signature (owner sends no EVM tx). */
export async function makeAccountVaultFor(w: World, over: Partial<CreateParams> = {}, value = 0n): Promise<Scenario> {
  const key = pqKey("owner");
  await registerAccount(w, w.owner.account.address, key);
  const p = params(w, over);
  const owner = w.owner.account.address;
  const expiry = (await now()) + 600n;
  const { vaultId, digest } = createDigest(w.domain, owner, KeyMode.ACCOUNT, ZERO_HASH, p, expiry);
  const sig = signDigest(key, digest);
  await accept(w, key, digest, sig);
  await w.vault.write.createVaultFor([owner, KeyMode.ACCOUNT, p, expiry, sig, "0x"], { account: w.relayer.account, value });
  return { w, vaultId, mode: KeyMode.ACCOUNT, key, params: p };
}

export async function ownerDo(s: Scenario, a: OwnerAct, o: SignOpts = {}) {
  return doOwner(s.w, s.vaultId, s.key, s.mode, a, o);
}

export async function deployToken(w: World, label = "TKN", supply = 1_000_000n * E18, recipient?: Address) {
  return viem.deployContract("TestToken", [label, label, recipient ?? w.deployer.account.address, supply]);
}

export async function fundToken(w: World, token: { write: any; address: Address }, to: Address, amount: bigint) {
  await token.write.transfer([to, amount], { account: w.deployer.account });
}

export async function depositTokenTo(w: World, s: { vaultId: bigint }, token: any, from: Wc, amount: bigint) {
  await token.write.approve([w.vault.address, amount], { account: from.account });
  await w.vault.write.depositToken([s.vaultId, token.address, amount], { account: from.account });
}

export async function balance(addr: Address): Promise<bigint> {
  return publicClient.getBalance({ address: addr });
}

export async function stateOf(w: World, id: bigint): Promise<number> {
  return Number(await w.vault.read.stateOf([id]));
}

/** Total real holdings of the vault contract (native + tokens) for "nothing moved" assertions. */
export async function holdings(w: World, tokens: { read: any; address: Address }[]) {
  const native = await balance(w.vault.address);
  const toks: bigint[] = [];
  for (const t of tokens) toks.push(await t.read.balanceOf([w.vault.address]));
  return { native, toks };
}

/** Heir-signed SET_PAYOUT. nonce defaults to the heir's current nonce for this vault. */
export async function signPayout(
  w: World,
  vaultId: bigint,
  key: PQKey,
  heirIndex: bigint,
  heir: Address,
  newPayout: Address,
  o: SignOpts = {},
) {
  const nonce = o.nonce ?? (await w.vault.read.heirNonce([vaultId, heir]));
  const expiry = o.expiry ?? (await now()) + 600n;
  const digest = setPayoutDigest(o.domain ?? w.domain, { vaultId: o.digestVaultId ?? vaultId, nonce, expiry }, heirIndex, heir, newPayout);
  const sig = signDigest(key, digest);
  if (o.register !== false) await accept(w, key, digest, sig);
  return { nonce, expiry, sig };
}

/** Warp past the full deadline and trigger. Returns the trigger tx hash. */
export async function overdueAndTrigger(w: World, vaultId: bigint, from?: Wc) {
  const [, deadline] = await w.vault.read.deadlines([vaultId]);
  await warpTo(deadline + 1n);
  return w.vault.write.trigger([vaultId], { account: (from ?? w.relayer).account });
}

export { getAddress, keccak256, pqKey, signDigest, setPayoutDigest };
export type { PQKey, Heir, CreateParams, Domain, Signed };
