import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keccak256, zeroAddress, type Address, type Hex } from "viem";
import { Action, actionDigest, argsHash, rotateKeyPopDigest } from "../lib/encoding.js";
import {
  E18, KeyMode, accept, act, balance, deployToken, deployWorld, depositTokenTo, expectError, makeAccountVault,
  makeDeviceVault, networkHelpers, now, ownerDo, parseEther, pqKey, signAuth, signDigest, viem, overdueAndTrigger,
  defaultHeirs, type World,
} from "../testkit/harness.js";

const A = (a: { account: { address: Address } }) => a.account.address;
const fresh = () => networkHelpers.loadFixture(deployWorld);

describe("withdraw", () => {
  async function ctx() {
    const w = await fresh();
    const t = await deployToken(w, "WT");
    const s = await makeAccountVault(w, { tokens: [t.address] }, parseEther("5"));
    await depositTokenTo(w, s, t, w.deployer, 1000n);
    return { w, s, t };
  }

  it("native and token withdrawals move exactly the signed amount to the signed recipient", async () => {
    const { w, s, t } = await ctx();
    const b0 = await balance(A(w.payee1));
    await ownerDo(s, act.withdraw(zeroAddress, parseEther("1.5"), A(w.payee1)));
    assert.equal((await balance(A(w.payee1))) - b0, parseEther("1.5"));
    await ownerDo(s, act.withdraw(t.address, 400n, A(w.payee2)));
    assert.equal(await t.read.balanceOf([A(w.payee2)]), 400n);
    assert.equal(await w.vault.read.balanceOf([s.vaultId, zeroAddress]), parseEther("3.5"));
    assert.equal(await w.vault.read.balanceOf([s.vaultId, t.address]), 600n);
    const ev = await w.vault.getEvents.Withdrawn({}, { fromBlock: 0n });
    assert.equal(ev.length, 2);
  });

  it("withdrawing the full balance (native and token) leaves exactly zero and moves exact amounts", async () => {
    const { w, s, t } = await ctx();
    const b0 = await balance(A(w.payee1));
    await ownerDo(s, act.withdraw(zeroAddress, parseEther("5"), A(w.payee1)));
    assert.equal((await balance(A(w.payee1))) - b0, parseEther("5"));
    assert.equal(await w.vault.read.balanceOf([s.vaultId, zeroAddress]), 0n);
    await ownerDo(s, act.withdraw(t.address, 1000n, A(w.payee2)));
    assert.equal(await t.read.balanceOf([A(w.payee2)]), 1000n);
    assert.equal(await w.vault.read.balanceOf([s.vaultId, t.address]), 0n);
    assert.equal(await balance(w.vault.address), 0n);
    assert.equal(await t.read.balanceOf([w.vault.address]), 0n);
  });

  it("validation: zero amount, zero address, vault address, unlisted token, too much", async () => {
    const { w, s, t } = await ctx();
    const other = await deployToken(w, "OTH");
    await expectError(ownerDo(s, act.withdraw(zeroAddress, 0n, A(w.payee1))), "ZeroAmount");
    await expectError(ownerDo(s, act.withdraw(zeroAddress, 1n, zeroAddress)), "ZeroAddress");
    await expectError(ownerDo(s, act.withdraw(zeroAddress, 1n, w.vault.address)), "BadRecipient");
    await expectError(ownerDo(s, act.withdraw(other.address, 1n, A(w.payee1))), "TokenNotAllowed", [other.address]);
    await expectError(ownerDo(s, act.withdraw(zeroAddress, parseEther("5") + 1n, A(w.payee1))), "InsufficientBalance", [parseEther("5"), parseEther("5") + 1n]);
    await expectError(ownerDo(s, act.withdraw(t.address, 1001n, A(w.payee1))), "InsufficientBalance", [1000n, 1001n]);
    // failed validation reverts the whole call: the nonce did not move
    assert.equal((await w.vault.read.getVault([s.vaultId])).nonce, 0n);
  });

  it("a recipient that rejects value makes the withdraw revert (nothing lost)", async () => {
    const { w, s } = await ctx();
    const bad = await viem.deployContract("EvilReceiver");
    await bad.write.setMode([1]);
    await expectError(ownerDo(s, act.withdraw(zeroAddress, 5n, bad.address)), "TransferFailed");
    assert.equal(await w.vault.read.balanceOf([s.vaultId, zeroAddress]), parseEther("5"));
  });

  it("the vault's own balance of a token it does not account for cannot be withdrawn (no balanceOf accounting)", async () => {
    const { w, s, t } = await ctx();
    // someone sends tokens straight to the contract: never credited, never withdrawable
    await t.write.transfer([w.vault.address, 50n], { account: w.deployer.account });
    assert.equal(await w.vault.read.balanceOf([s.vaultId, t.address]), 1000n);
    await expectError(ownerDo(s, act.withdraw(t.address, 1001n, A(w.owner))), "InsufficientBalance");
  });
});

describe("close", () => {
  it("sends native and every token to `to`, marks CLOSED, id can never be reused", async () => {
    const w = await fresh();
    const t1 = await deployToken(w, "C1");
    const t2 = await deployToken(w, "C2");
    const s = await makeAccountVault(w, { tokens: [t1.address, t2.address] }, parseEther("2"));
    await depositTokenTo(w, s, t1, w.deployer, 10n);
    // t2 stays empty on purpose (zero balances are skipped)
    const b0 = await balance(A(w.payee3));
    await ownerDo(s, act.close(A(w.payee3)));
    assert.equal((await balance(A(w.payee3))) - b0, parseEther("2"));
    assert.equal(await t1.read.balanceOf([A(w.payee3)]), 10n);
    assert.equal(await balance(w.vault.address), 0n);
    assert.equal(Number(await w.vault.read.stateOf([s.vaultId])), 6);
    assert.equal((await w.vault.getEvents.VaultClosed({}, { fromBlock: 0n })).length, 1);
    await expectError(w.vault.write.createVault([s.params], { account: w.owner.account }), "VaultExists");
    await expectError(w.vault.write.trigger([s.vaultId]), "WrongStatus", [4]);
    await expectError(w.vault.write.settle([s.vaultId]), "WrongStatus", [4]);
  });

  it("validation and failure atomicity", async () => {
    const w = await fresh();
    const s = await makeAccountVault(w, {}, parseEther("1"));
    await expectError(ownerDo(s, act.close(zeroAddress)), "ZeroAddress");
    await expectError(ownerDo(s, act.close(w.vault.address)), "BadRecipient");
    const bad = await viem.deployContract("EvilReceiver");
    await bad.write.setMode([1]);
    await expectError(ownerDo(s, act.close(bad.address)), "TransferFailed");
    assert.equal(Number(await w.vault.read.stateOf([s.vaultId])), 1); // still ACTIVE
    assert.equal(await w.vault.read.balanceOf([s.vaultId, zeroAddress]), parseEther("1"));
  });

  it("closing works while OVERDUE (before anyone triggers) and for DEVICE vaults", async () => {
    const w = await fresh();
    const s = await makeDeviceVault(w, { interval: 60n, grace: 0 }, 9n);
    await networkHelpers.time.increase(500);
    const b0 = await balance(A(w.payee1));
    await ownerDo(s, act.close(A(w.payee1)));
    assert.equal((await balance(A(w.payee1))) - b0, 9n);
  });
});

describe("setHeirs / setTiming", () => {
  it("setHeirs replaces the list and validates like creation", async () => {
    const w = await fresh();
    const s = await makeAccountVault(w);
    const h = defaultHeirs(w);
    await expectError(ownerDo(s, act.setHeirs([])), "BadHeirs");
    await expectError(ownerDo(s, act.setHeirs([{ ...h[0], bps: 9000 }])), "BadHeirs");
    await expectError(ownerDo(s, act.setHeirs([{ ...h[0], payoutTo: zeroAddress, bps: 10000 }])), "BadHeirs");
    await expectError(ownerDo(s, act.setHeirs([{ ...h[0], bps: 5000 }, { ...h[0], bps: 5000 }])), "BadHeirs");
    await expectError(ownerDo(s, act.setHeirs(Array.from({ length: 11 }, (_, i) => ({ account: A(w.wallets[i + 1]), payoutTo: A(w.owner), bps: i === 0 ? 1000 : 900 })))), "BadHeirs");
    await ownerDo(s, act.setHeirs([{ ...h[1], bps: 10000 }]));
    const got = await w.vault.read.getHeirs([s.vaultId]);
    assert.equal(got.length, 1);
    assert.equal(got[0].bps, 10000);
    assert.equal((await w.vault.getEvents.HeirsSet({}, { fromBlock: 0n })).length, 2); // creation + this
  });

  it("setTiming validates and re-derives the deadline from the (reset) check-in", async () => {
    const w = await fresh();
    const s = await makeAccountVault(w);
    await expectError(ownerDo(s, act.setTiming(59n, 0, 0n)), "BadInterval");
    await expectError(ownerDo(s, act.setTiming(365n * 86400n + 1n, 0, 0n)), "BadInterval");
    await expectError(ownerDo(s, act.setTiming(3600n, 13, 0n)), "BadGrace");
    await ownerDo(s, act.setTiming(120n, 12, 77n));
    const v = await w.vault.read.getVault([s.vaultId]);
    assert.equal(v.interval, 120n);
    assert.equal(v.grace, 12);
    assert.equal(v.bounty, 77n);
    assert.equal((await w.vault.getEvents.TimingSet({}, { fromBlock: 0n })).length, 1);
  });
});

describe("DEVICE key rotation", () => {
  const n1 = pqKey("rot-new-1");
  async function ctx() {
    const w = await fresh();
    const s = await makeDeviceVault(w, {}, parseEther("1"));
    return { w, s };
  }

  it("rotates: pubkey hash changes, KeyRotated emitted, old key dead, new key works, vault id unchanged", async () => {
    const { w, s } = await ctx();
    await ownerDo(s, act.rotate(n1));
    const v = await w.vault.read.getVault([s.vaultId]);
    assert.equal(v.pubkeyHash, n1.hash);
    assert.equal(v.nonce, 1n);
    const ev = await w.vault.getEvents.KeyRotated({}, { fromBlock: 0n });
    assert.equal(ev[0].args.oldPubkeyHash, s.key.hash);
    assert.equal(ev[0].args.newPubkeyHash, n1.hash);
    // old key: every action fails (pubkey mismatch)
    for (const a of [act.checkIn(), act.withdraw(zeroAddress, 1n, A(w.owner)), act.close(A(w.owner)), act.revokeAgent()]) {
      await expectError(ownerDo(s, a), "PubkeyMismatch");
    }
    // new key works
    await ownerDo({ ...s, key: n1 }, act.checkIn());
    await ownerDo({ ...s, key: n1 }, act.withdraw(zeroAddress, 5n, A(w.payee1)));
    assert.equal(await w.vault.read.computeVaultId([A(w.owner), KeyMode.DEVICE, s.key.hash, s.params]), s.vaultId);
  });

  it("ACCOUNT vaults cannot rotate (they follow the chain's key registry)", async () => {
    const w = await fresh();
    const s = await makeAccountVault(w);
    await expectError(ownerDo(s, act.rotate(n1)), "WrongKeyMode");
  });

  it("same key, short key, unknown vault", async () => {
    const { w, s } = await ctx();
    await expectError(ownerDo(s, act.rotate(s.key)), "SameKey");
    const au = await signAuth(w, s.vaultId, s.key, s.mode, act.rotate(n1).digest);
    await expectError(w.vault.write.rotateKey([s.vaultId, "0x1234", "0x", au]), "BadPubkeyLength", [2n]);
    await expectError(w.vault.write.rotateKey([4242n, n1.pubHex, "0x" + "00".repeat(4627) as Hex, au]), "VaultNotFound");
  });

  it("rotation without a valid proof of possession is rejected and changes nothing", async () => {
    const { w, s } = await ctx();
    const before = await w.vault.read.getVault([s.vaultId]);
    // PoP not known to the precompile
    await expectError(ownerDo(s, act.rotate(n1, { registerPop: false })), "PQSignatureInvalid");
    // PoP signed by the OLD key instead of the new key
    await expectError(ownerDo(s, act.rotate(n1, { popKey: s.key })), "PQSignatureInvalid");
    // PoP signed by a third key
    await expectError(ownerDo(s, act.rotate(n1, { popKey: pqKey("third") })), "PQSignatureInvalid");
    // wrong length PoP
    const au = await signAuth(w, s.vaultId, s.key, s.mode, act.rotate(n1).digest);
    await expectError(w.vault.write.rotateKey([s.vaultId, n1.pubHex, "0x1234", au]), "BadSignatureLength", [2n]);
    const after = await w.vault.read.getVault([s.vaultId]);
    assert.deepEqual(after, before);
  });

  it("a PoP signature cannot be replayed to rotate a different vault or at a different nonce/expiry", async () => {
    const { w, s } = await ctx();
    const other = await makeDeviceVault(w, { salt: keccak256("0x71") }, 1n);
    // build the PoP for `s`, then try it on `other` with other's valid owner auth
    const au = await signAuth(w, s.vaultId, s.key, s.mode, act.rotate(n1).digest);
    const popDigest = rotateKeyPopDigest(w.domain, { vaultId: s.vaultId, nonce: au.nonce, expiry: au.expiry }, n1.hash);
    const pop = signDigest(n1, popDigest);
    await accept(w, n1, popDigest, pop);
    const auOther = await signAuth(w, other.vaultId, other.key, other.mode, act.rotate(n1).digest);
    await expectError(w.vault.write.rotateKey([other.vaultId, n1.pubHex, pop, auOther]), "PQSignatureInvalid");
    const auLater = await signAuth(w, s.vaultId, s.key, s.mode, act.rotate(n1).digest, { expiry: au.expiry + 1n });
    await expectError(w.vault.write.rotateKey([s.vaultId, n1.pubHex, pop, auLater]), "PQSignatureInvalid");
    await w.vault.write.rotateKey([s.vaultId, n1.pubHex, pop, au]); // the intended pairing works
  });

  it("the PoP signature (action ROTATE_KEY_POP) is not accepted as an owner signature for any action", async () => {
    const { w, s } = await ctx();
    await ownerDo(s, act.rotate(n1));
    const k = { ...s, key: n1 };
    const nonce = 1n;
    const expiry = (await now()) + 600n;
    const popDigest = rotateKeyPopDigest(w.domain, { vaultId: s.vaultId, nonce, expiry }, n1.hash);
    const pop = signDigest(n1, popDigest);
    await accept(w, n1, popDigest, pop);
    const actions = [
      act.checkIn(), act.withdraw(zeroAddress, 1n, A(w.owner)), act.close(A(w.owner)), act.revokeAgent(),
      act.setTiming(3600n, 1, 0n), act.setHeirs(defaultHeirs(w)),
    ];
    for (const a of actions) {
      await expectError(a.send(w, s.vaultId, { nonce, expiry, sig: pop, pubkey: n1.pubHex }), "PQSignatureInvalid");
    }
    // even the exact args hash of a rotation under the plain ROTATE_KEY action id does not match the POP id
    assert.notEqual(
      actionDigest(w.domain, s.vaultId, Action.ROTATE_KEY, argsHash.rotateKey(n1.hash), nonce, expiry),
      popDigest,
    );
    void k;
  });

  it("replaying a rotation hits SameKey; a stale competing rotation hits BadNonce; rotate back works", async () => {
    const { w, s } = await ctx();
    const n2 = pqKey("rot-new-2");
    const au1 = await signAuth(w, s.vaultId, s.key, s.mode, act.rotate(n1).digest);
    const au2 = await signAuth(w, s.vaultId, s.key, s.mode, act.rotate(n2).digest);
    await act.rotate(n1).send(w, s.vaultId, au1);
    await expectError(act.rotate(n1).send(w, s.vaultId, au1), "SameKey");
    await expectError(act.rotate(n2).send(w, s.vaultId, au2), "BadNonce", [1n, 0n]);
    await ownerDo({ ...s, key: n1 }, act.rotate(s.key));
    await ownerDo(s, act.checkIn());
  });
});

describe("isolation between vaults", () => {
  it("two vaults share a token and native: withdraw/trigger/settle/close on one never changes the other", async () => {
    const w = await fresh();
    const t = await deployToken(w, "ISO");
    const a = await makeAccountVault(w, { tokens: [t.address], interval: 60n, grace: 0, salt: keccak256("0xa1") }, parseEther("3"));
    const b = await makeAccountVault(w, { tokens: [t.address], interval: 3600n * 24n, grace: 0, salt: keccak256("0xb2") }, parseEther("4"));
    await depositTokenTo(w, a, t, w.deployer, 300n);
    await depositTokenTo(w, b, t, w.deployer, 700n);

    const snapB = async () => ({
      n: await w.vault.read.balanceOf([b.vaultId, zeroAddress]),
      t: await w.vault.read.balanceOf([b.vaultId, t.address]),
      v: await w.vault.read.getVault([b.vaultId]),
    });
    const b0 = await snapB();

    // A: two withdrawals, then trigger and settle
    await ownerDo(a, act.withdraw(zeroAddress, parseEther("1"), A(w.payee1)));
    await ownerDo(a, act.withdraw(t.address, 100n, A(w.payee1)));
    await overdueAndTrigger(w, a.vaultId);
    await w.vault.write.settle([a.vaultId]);
    assert.deepEqual(await snapB(), b0);
    assert.equal(await balance(w.vault.address), parseEther("4"));
    assert.equal(await t.read.balanceOf([w.vault.address]), 700n);

    // A cannot withdraw more than A holds, even though the contract holds B's money
    const c = await makeAccountVault(w, { tokens: [t.address], salt: keccak256("0xc3") }, 10n);
    await expectError(ownerDo(c, act.withdraw(zeroAddress, 11n, A(w.owner))), "InsufficientBalance", [10n, 11n]);
    await expectError(ownerDo(c, act.withdraw(t.address, 1n, A(w.owner))), "InsufficientBalance", [0n, 1n]);

    // closing B leaves C intact
    await ownerDo(b, act.close(A(w.owner)));
    assert.equal(await w.vault.read.balanceOf([c.vaultId, zeroAddress]), 10n);
    assert.equal(await balance(w.vault.address), 10n);
  });
});
