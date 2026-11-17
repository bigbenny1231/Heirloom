import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keccak256, zeroAddress, type Hex } from "viem";
import { createDigest } from "../lib/encoding.js";
import {
  KeyMode, ZERO_HASH, accept, balance, defaultHeirs, deployToken, deployWorld, depositTokenTo, expectError, fundToken,
  makeAccountVault, makeAccountVaultFor, makeDeviceVault, networkHelpers, now, params, pqKey, registerAccount,
  signDigest, viem, warpBy, E18, ownerDo, act, type World,
} from "../testkit/harness.js";

const f = () => deployWorld();
const fresh = () => networkHelpers.loadFixture(f);

async function sigFor(w: World, owner: `0x${string}`, mode: KeyMode, key = pqKey("device"), p = params(w), expiry?: bigint, register = true) {
  const exp = expiry ?? (await now()) + 600n;
  const pk = mode === KeyMode.DEVICE ? key.hash : ZERO_HASH;
  const { vaultId, digest } = createDigest(w.domain, owner, mode, pk, p, exp);
  const sig = signDigest(key, digest);
  if (register) await accept(w, key, digest, sig);
  return { vaultId, digest, sig, exp, p };
}

describe("createVault (ACCOUNT, msg.sender is owner)", () => {
  it("creates, stores everything and deposits msg.value", async () => {
    const w = await fresh();
    const s = await makeAccountVault(w, { bounty: 7n, tokens: [] }, 5n * E18);
    const v = await w.vault.read.getVault([s.vaultId]);
    assert.equal(v.owner.toLowerCase(), w.owner.account.address.toLowerCase());
    assert.equal(v.keyMode, KeyMode.ACCOUNT);
    assert.equal(v.status, 1);
    assert.equal(v.interval, 3600n);
    assert.equal(v.grace, 2);
    assert.equal(v.nonce, 0n);
    assert.equal(v.pubkeyHash, ZERO_HASH);
    assert.equal(v.bounty, 7n);
    assert.equal(await w.vault.read.balanceOf([s.vaultId, zeroAddress]), 5n * E18);
    assert.equal(await balance(w.vault.address), 5n * E18);
    assert.equal((await w.vault.read.getHeirs([s.vaultId])).length, 3);
    assert.equal(Number(await w.vault.read.stateOf([s.vaultId])), 1);
  });

  it("emits VaultCreated, HeirsSet, Deposited", async () => {
    const w = await fresh();
    const s = await makeAccountVault(w, {}, 1n);
    const logs = await w.vault.getEvents.VaultCreated({}, { fromBlock: 0n });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].args.vaultId, s.vaultId);
    assert.equal((await w.vault.getEvents.HeirsSet({}, { fromBlock: 0n })).length, 1);
    assert.equal((await w.vault.getEvents.Deposited({}, { fromBlock: 0n })).length, 1);
  });

  it("refuses an owner with no usable PQ key: unregistered, wrong algorithm, possession not proven", async () => {
    const w = await fresh();
    const p = params(w);
    const call = () => w.vault.write.createVault([p], { account: w.owner.account, value: 1n });
    await expectError(call(), "PQKeyNotRegistered", [w.owner.account.address]);
    await registerAccount(w, w.owner.account.address, pqKey("owner"), { alg: 2 });
    await expectError(call(), "PQKeyWrongAlgorithm", [2]);
    await registerAccount(w, w.owner.account.address, pqKey("owner"), { proven: false });
    await expectError(call(), "PQKeyPossessionNotProven");
    await registerAccount(w, w.owner.account.address, pqKey("owner"), { registered: false });
    await expectError(call(), "PQKeyNotRegistered");
  });

  it("refuses when the precompile is inactive (empty returndata)", async () => {
    const w = await fresh();
    await registerAccount(w, w.owner.account.address, pqKey("owner"));
    await w.a02.write.setInactive([true]);
    await expectError(w.vault.write.createVault([params(w)], { account: w.owner.account }), "PrecompileUnavailable");
  });

  it("same owner + salt twice is VaultExists; other salt is a different vault", async () => {
    const w = await fresh();
    const s = await makeAccountVault(w);
    await expectError(w.vault.write.createVault([s.params], { account: w.owner.account }), "VaultExists", [s.vaultId]);
    await w.vault.write.createVault([params(w, { salt: keccak256("0x02") })], { account: w.owner.account });
  });

  it("L-1: squatting with the same salt but other parameters gives a different id; the legit create still works", async () => {
    const w = await fresh();
    await registerAccount(w, w.owner.account.address, pqKey("owner"));
    const legit = params(w, { salt: keccak256("0x5a17") });
    const evilParams = { ...legit, heirs: [{ account: w.attacker.account.address, payoutTo: w.attacker.account.address, bps: 10000 }], interval: 60n, grace: 0 };
    const owner = w.owner.account.address;
    const idLegit = await w.vault.read.computeVaultId([owner, KeyMode.ACCOUNT, ZERO_HASH, legit]);
    const idEvil = await w.vault.read.computeVaultId([owner, KeyMode.ACCOUNT, ZERO_HASH, evilParams]);
    assert.notEqual(idLegit, idEvil);
    // someone with the owner's EVM key front-runs with the same salt
    await w.vault.write.createVault([evilParams], { account: w.owner.account });
    await w.vault.write.createVault([legit], { account: w.owner.account, value: 7n });
    assert.equal((await w.vault.read.getHeirs([idLegit]))[0].bps, 5000);
    assert.equal(await w.vault.read.balanceOf([idLegit, zeroAddress]), 7n);
    assert.equal(await w.vault.read.balanceOf([idEvil, zeroAddress]), 0n);
    // and a signed creation (createVaultFor) is bound to the same params: the evil params cannot reuse the legit signature
    const g = await sigFor(w, owner, KeyMode.ACCOUNT, pqKey("owner"), params(w, { salt: keccak256("0x5a18") }));
    await expectError(
      w.vault.write.createVaultFor([owner, KeyMode.ACCOUNT, { ...g.p, heirs: evilParams.heirs }, g.exp, g.sig, "0x"], { account: w.attacker.account }),
      "PQSignatureInvalid",
    );
  });

  it("validates timing, tokens and heirs", async () => {
    const w = await fresh();
    await registerAccount(w, w.owner.account.address, pqKey("owner"));
    const mk = (over: object) => w.vault.write.createVault([params(w, over)], { account: w.owner.account });
    await expectError(mk({ interval: 59n }), "BadInterval");
    await expectError(mk({ interval: 365n * 86400n + 1n }), "BadInterval");
    await expectError(mk({ grace: 13 }), "BadGrace");
    await mk({ interval: 60n, grace: 12, salt: keccak256("0x10") });
    await mk({ interval: 365n * 86400n, grace: 0, salt: keccak256("0x11") });

    const t1 = await deployToken(w, "A");
    const t2 = await deployToken(w, "B");
    const t3 = await deployToken(w, "C");
    const t4 = await deployToken(w, "D");
    const t5 = await deployToken(w, "E");
    const addrs = [t1, t2, t3, t4, t5].map((t) => t.address);
    await expectError(mk({ tokens: addrs }), "BadTokens"); // 5 tokens
    await expectError(mk({ tokens: [addrs[0], addrs[0]] }), "BadTokens"); // duplicate
    await expectError(mk({ tokens: [zeroAddress] }), "BadTokens");
    await expectError(mk({ tokens: [w.payee1.account.address] }), "BadTokens"); // no code
    await expectError(mk({ tokens: [w.vault.address] }), "BadTokens");
    await mk({ tokens: addrs.slice(0, 4), salt: keccak256("0x12") });

    const h = defaultHeirs(w);
    await expectError(mk({ heirs: [] }), "BadHeirs");
    await expectError(mk({ heirs: [{ ...h[0], bps: 9999 }] }), "BadHeirs"); // sum != 10000
    await expectError(mk({ heirs: [{ ...h[0], bps: 10001 }] }), "BadHeirs");
    await expectError(mk({ heirs: [{ ...h[0], bps: 0 }, { ...h[1], bps: 10000 }] }), "BadHeirs");
    await expectError(mk({ heirs: [{ ...h[0], account: zeroAddress, bps: 10000 }] }), "BadHeirs");
    await expectError(mk({ heirs: [{ ...h[0], payoutTo: zeroAddress, bps: 10000 }] }), "BadHeirs");
    await expectError(mk({ heirs: [{ ...h[0], payoutTo: w.vault.address, bps: 10000 }] }), "BadHeirs");
    await expectError(mk({ heirs: [{ ...h[0], bps: 5000 }, { ...h[0], bps: 5000 }] }), "BadHeirs"); // duplicate account
    const eleven = Array.from({ length: 11 }, (_, i) => ({ account: w.wallets[i % 10 + 1].account.address, payoutTo: w.owner.account.address, bps: 1 }));
    await expectError(mk({ heirs: eleven }), "BadHeirs");
  });

  it("accepts exactly 10 heirs", async () => {
    const w = await fresh();
    await registerAccount(w, w.owner.account.address, pqKey("owner"));
    const heirs = w.wallets.slice(1, 11).map((x) => ({ account: x.account.address, payoutTo: x.account.address, bps: 1000 }));
    await w.vault.write.createVault([params(w, { heirs })], { account: w.owner.account });
  });
});

describe("createVaultFor (signed creation)", () => {
  it("ACCOUNT mode: relayer submits, owner sends no tx; value is deposited", async () => {
    const w = await fresh();
    const s = await makeAccountVaultFor(w, {}, 3n);
    const v = await w.vault.read.getVault([s.vaultId]);
    assert.equal(v.owner.toLowerCase(), w.owner.account.address.toLowerCase());
    assert.equal(await w.vault.read.balanceOf([s.vaultId, zeroAddress]), 3n);
  });

  it("DEVICE mode: pins keccak(pubkey); PoP is the creation signature", async () => {
    const w = await fresh();
    const s = await makeDeviceVault(w, {}, 2n);
    const v = await w.vault.read.getVault([s.vaultId]);
    assert.equal(v.keyMode, KeyMode.DEVICE);
    assert.equal(v.pubkeyHash, pqKey("device").hash);
    assert.equal(s.vaultId, await w.vault.read.computeVaultId([w.owner.account.address, KeyMode.DEVICE, pqKey("device").hash, s.params]));
  });

  it("rejects replay: the same creation again is VaultExists", async () => {
    const w = await fresh();
    const key = pqKey("device");
    const p = params(w);
    const owner = w.owner.account.address;
    const g = await sigFor(w, owner, KeyMode.DEVICE, key, p);
    await w.vault.write.createVaultFor([owner, KeyMode.DEVICE, p, g.exp, g.sig, key.pubHex], { account: w.relayer.account });
    await expectError(w.vault.write.createVaultFor([owner, KeyMode.DEVICE, p, g.exp, g.sig, key.pubHex], { account: w.relayer.account }), "VaultExists");
  });

  it("rejects: zero owner, expired, bad lengths, unexpected pubkey, bad sig, tampered params", async () => {
    const w = await fresh();
    const key = pqKey("device");
    const p = params(w);
    const owner = w.owner.account.address;
    const g = await sigFor(w, owner, KeyMode.DEVICE, key, p);
    const call = (o: Partial<{ owner: `0x${string}`; mode: KeyMode; p: typeof p; exp: bigint; sig: Hex; pk: Hex }> = {}) =>
      w.vault.write.createVaultFor([o.owner ?? owner, o.mode ?? KeyMode.DEVICE, o.p ?? p, o.exp ?? g.exp, o.sig ?? g.sig, o.pk ?? key.pubHex], { account: w.relayer.account });

    await expectError(call({ owner: zeroAddress }), "ZeroAddress");
    await expectError(call({ pk: "0x1234" }), "BadPubkeyLength", [2n]);
    await expectError(call({ sig: "0x1234" }), "BadSignatureLength", [2n]);
    await expectError(call({ sig: ("0x" + "00".repeat(4628)) as Hex }), "BadSignatureLength", [4628n]);
    await expectError(call({ sig: "0x" }), "BadSignatureLength", [0n]); // ECDSA-only: nothing to verify
    await expectError(call({ mode: KeyMode.ACCOUNT, pk: key.pubHex }), "UnexpectedPubkey");
    // tampered params: signature was for p, not p2 -> mock has no triple -> invalid
    await expectError(call({ p: params(w, { bounty: 1n }) }), "PQSignatureInvalid");
    // signature for another expiry
    await expectError(call({ exp: g.exp + 1n }), "PQSignatureInvalid");
    // unregistered signature (precompile says false)
    const g2 = await sigFor(w, owner, KeyMode.DEVICE, key, params(w, { salt: keccak256("0x77") }), undefined, false);
    await expectError(call({ p: g2.p, exp: g2.exp, sig: g2.sig }), "PQSignatureInvalid");
    await warpBy(601);
    await expectError(call(), "SignatureExpired");
  });

  it("DEVICE: a signature by a different key than the supplied pubkey fails", async () => {
    const w = await fresh();
    const keyA = pqKey("device");
    const keyB = pqKey("other-device");
    const p = params(w);
    const owner = w.owner.account.address;
    // sign the digest for keyA's vault id with keyB
    const exp = (await now()) + 600n;
    const { digest } = createDigest(w.domain, owner, KeyMode.DEVICE, keyA.hash, p, exp);
    const sig = signDigest(keyB, digest);
    await accept(w, keyB, digest, sig);
    await expectError(w.vault.write.createVaultFor([owner, KeyMode.DEVICE, p, exp, sig, keyA.pubHex], { account: w.relayer.account }), "PQSignatureInvalid");
  });

  it("ACCOUNT mode needs the owner's registered key", async () => {
    const w = await fresh();
    const owner = w.owner.account.address;
    const p = params(w);
    const g = await sigFor(w, owner, KeyMode.ACCOUNT, pqKey("owner"), p);
    const call = () => w.vault.write.createVaultFor([owner, KeyMode.ACCOUNT, p, g.exp, g.sig, "0x"], { account: w.relayer.account });
    await expectError(call(), "PQKeyNotRegistered");
    await registerAccount(w, owner, pqKey("owner"), { alg: 3 });
    await expectError(call(), "PQKeyWrongAlgorithm", [3]);
    await registerAccount(w, owner, pqKey("owner"), { proven: false });
    await expectError(call(), "PQKeyPossessionNotProven");
    await registerAccount(w, owner, pqKey("other"));
    await expectError(call(), "PQSignatureInvalid"); // registered key is not the signer
    await registerAccount(w, owner, pqKey("owner"));
    await call();
  });

  it("inactive precompile: createVaultFor fails closed in both modes", async () => {
    const w = await fresh();
    const owner = w.owner.account.address;
    await registerAccount(w, owner, pqKey("owner"));
    const p = params(w);
    const gd = await sigFor(w, owner, KeyMode.DEVICE, pqKey("device"), p);
    const ga = await sigFor(w, owner, KeyMode.ACCOUNT, pqKey("owner"), p);
    await w.a01.write.setInactive([true]);
    await expectError(w.vault.write.createVaultFor([owner, KeyMode.DEVICE, p, gd.exp, gd.sig, pqKey("device").pubHex], { account: w.relayer.account }), "PrecompileUnavailable");
    await w.a02.write.setInactive([true]);
    await expectError(w.vault.write.createVaultFor([owner, KeyMode.ACCOUNT, p, ga.exp, ga.sig, "0x"], { account: w.relayer.account }), "PrecompileUnavailable");
  });

  it("the id is bound to owner, key mode and key: an attacker cannot squat someone else's id", async () => {
    const w = await fresh();
    const key = pqKey("device");
    const p = params(w);
    // attacker uses its own key for the same salt: a different id, victim's id stays free
    const atk = pqKey("attacker-device");
    const exp = (await now()) + 600n;
    const mine = createDigest(w.domain, w.attacker.account.address, KeyMode.DEVICE, atk.hash, p, exp);
    const sig = signDigest(atk, mine.digest);
    await accept(w, atk, mine.digest, sig);
    await w.vault.write.createVaultFor([w.attacker.account.address, KeyMode.DEVICE, p, exp, sig, atk.pubHex], { account: w.attacker.account });
    const victimId = createDigest(w.domain, w.owner.account.address, KeyMode.DEVICE, key.hash, p, exp).vaultId;
    assert.notEqual(victimId, mine.vaultId);
    assert.equal(Number(await w.vault.read.stateOf([victimId])), 0);
  });
});

describe("deposits", () => {
  it("native: anyone can deposit; zero rejected; unknown vault rejected", async () => {
    const w = await fresh();
    const s = await makeAccountVault(w);
    await w.vault.write.depositNative([s.vaultId], { account: w.attacker.account, value: 9n });
    assert.equal(await w.vault.read.balanceOf([s.vaultId, zeroAddress]), 9n);
    await expectError(w.vault.write.depositNative([s.vaultId], { account: w.attacker.account, value: 0n }), "ZeroAmount");
    await expectError(w.vault.write.depositNative([123n], { value: 1n }), "VaultNotFound", [123n]);
  });

  it("deposits are not check-ins", async () => {
    const w = await fresh();
    const s = await makeAccountVault(w);
    const before = (await w.vault.read.getVault([s.vaultId])).lastCheckin;
    await warpBy(100);
    await w.vault.write.depositNative([s.vaultId], { value: 1n });
    assert.equal((await w.vault.read.getVault([s.vaultId])).lastCheckin, before);
  });

  it("token: allowed token only, credits the measured amount, zero rejected", async () => {
    const w = await fresh();
    const t = await deployToken(w);
    const other = await deployToken(w, "OTH");
    const s = await makeAccountVault(w, { tokens: [t.address] });
    await depositTokenTo(w, s, t, w.deployer, 100n);
    assert.equal(await w.vault.read.balanceOf([s.vaultId, t.address]), 100n);
    await other.write.approve([w.vault.address, 5n], { account: w.deployer.account });
    await expectError(w.vault.write.depositToken([s.vaultId, other.address, 5n], { account: w.deployer.account }), "TokenNotAllowed", [other.address]);
    await expectError(w.vault.write.depositToken([s.vaultId, t.address, 0n], { account: w.deployer.account }), "ZeroAmount");
    await expectError(w.vault.write.depositToken([777n, t.address, 1n], { account: w.deployer.account }), "VaultNotFound");
    await fundToken(w, t, w.attacker.account.address, 10n);
    await depositTokenTo(w, s, t, w.attacker, 10n);
    assert.equal(await w.vault.read.balanceOf([s.vaultId, t.address]), 110n);
    assert.equal(await t.read.balanceOf([w.vault.address]), 110n);
  });

  it("token: no allowance means the transfer reverts (SafeERC20 path)", async () => {
    const w = await fresh();
    const t = await deployToken(w);
    const s = await makeAccountVault(w, { tokens: [t.address] });
    await expectError(w.vault.write.depositToken([s.vaultId, t.address, 1n], { account: w.deployer.account }), "ERC20InsufficientAllowance");
  });

  it("fee-on-transfer token credits only what arrived", async () => {
    const w = await fresh();
    const evil = await viem.deployContract("EvilToken", [w.deployer.account.address, 1_000_000n * E18]);
    await evil.write.setMode([5]); // FEE_ON_TRANSFER
    const s = await makeAccountVault(w, { tokens: [evil.address] });
    await evil.write.approve([w.vault.address, 10_000n], { account: w.deployer.account });
    await w.vault.write.depositToken([s.vaultId, evil.address, 10_000n], { account: w.deployer.account });
    assert.equal(await w.vault.read.balanceOf([s.vaultId, evil.address]), 9_900n);
    assert.equal(await evil.read.balanceOf([w.vault.address]), 9_900n);
  });

  it("fee-on-transfer: small amounts still credit exactly the received amount", async () => {
    const w = await fresh();
    const evil = await viem.deployContract("EvilToken", [w.deployer.account.address, 1000n]);
    await evil.write.setMode([5]);
    const s = await makeAccountVault(w, { tokens: [evil.address] });
    await evil.write.approve([w.vault.address, 50n], { account: w.deployer.account });
    await w.vault.write.depositToken([s.vaultId, evil.address, 50n], { account: w.deployer.account });
    assert.equal(await w.vault.read.balanceOf([s.vaultId, evil.address]), 50n);
  });

  it("deposits are refused once SETTLED or CLOSED; allowed while TRIGGERED", async () => {
    const w = await fresh();
    const s = await makeAccountVault(w, { grace: 0, interval: 60n }, 100n);
    await warpBy(61);
    await w.vault.write.trigger([s.vaultId], { account: w.attacker.account });
    await w.vault.write.depositNative([s.vaultId], { value: 5n }); // TRIGGERED: still ok
    await w.vault.write.settle([s.vaultId]);
    await expectError(w.vault.write.depositNative([s.vaultId], { value: 1n }), "WrongStatus", [3]);

    const c = await makeAccountVault(w, { salt: keccak256("0x55") }, 10n);
    await ownerDo(c, act.close(w.owner.account.address));
    await expectError(w.vault.write.depositNative([c.vaultId], { value: 1n }), "WrongStatus", [4]);
  });

  it("no receive and no fallback: plain sends and unknown selectors revert", async () => {
    const w = await fresh();
    let reverted = false;
    try { await w.deployer.sendTransaction({ to: w.vault.address, value: 1n }); } catch { reverted = true; }
    assert.ok(reverted, "plain transfer must revert");
    reverted = false;
    try { await w.deployer.sendTransaction({ to: w.vault.address, data: "0xdeadbeef" }); } catch { reverted = true; }
    assert.ok(reverted, "unknown selector must revert");
    assert.equal(await balance(w.vault.address), 0n);
  });
});
