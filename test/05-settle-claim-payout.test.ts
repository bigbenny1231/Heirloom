import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, keccak256, zeroAddress, type Address } from "viem";
import { splitShares } from "../lib/encoding.js";
import {
  E18, balance, expectRevert, deployToken, deployWorld, depositTokenTo, expectError, fundToken, makeAccountVault, makeDeviceVault,
  networkHelpers, now, overdueAndTrigger, params, parseEther, pqKey, registerAccount, registerHeirs, signPayout,
  stateOf, viem, warpBy, publicClient, ownerDo, act, type World,
} from "../testkit/harness.js";

const fresh = () => networkHelpers.loadFixture(deployWorld);
const A = (a: { account: { address: Address } }) => a.account.address;

type H = { account: Address; payoutTo: Address; bps: number };
const heirs = (w: World, bps: number[]): H[] =>
  bps.map((b, i) => ({ account: A(w.wallets[2 + i]), payoutTo: A(w.wallets[2 + i]), bps: b }));

async function setup(bps: number[], native: bigint, opts: { tokens?: Address[]; salt?: `0x${string}`; heirsOverride?: H[] } = {}) {
  const w = await fresh();
  const s = await makeAccountVault(w, { interval: 60n, grace: 0, heirs: opts.heirsOverride ?? heirs(w, bps), tokens: opts.tokens ?? [] }, native);
  return { w, s };
}

const sumHeirDelta = async (w: World, before: bigint[], n: number) => {
  let d = 0n;
  for (let i = 0; i < n; i++) d += (await balance(A(w.wallets[2 + i]))) - before[i];
  return d;
};
const snapBalances = async (w: World, n: number) => Promise.all(Array.from({ length: n }, (_, i) => balance(A(w.wallets[2 + i]))));

describe("settle: splitting", () => {
  it("one heir gets everything; vault emptied; Settled emitted", async () => {
    const { w, s } = await setup([10000], parseEther("3"));
    const before = await snapBalances(w, 1);
    await overdueAndTrigger(w, s.vaultId);
    await w.vault.write.settle([s.vaultId], { account: w.attacker.account });
    assert.equal(await sumHeirDelta(w, before, 1), parseEther("3"));
    assert.equal(await w.vault.read.balanceOf([s.vaultId, zeroAddress]), 0n);
    assert.equal(await balance(w.vault.address), 0n);
    assert.equal(await stateOf(w, s.vaultId), 5);
    assert.equal((await w.vault.getEvents.Settled({}, { fromBlock: 0n })).length, 1);
  });

  it("10 heirs, uneven bps, exact sum", async () => {
    const bps = [1500, 1500, 1200, 1000, 1000, 900, 800, 700, 700, 700];
    assert.equal(bps.reduce((a, b) => a + b), 10000);
    const total = 1_000_000_007n;
    const { w, s } = await setup(bps, total);
    const before = await snapBalances(w, 10);
    await overdueAndTrigger(w, s.vaultId, w.wallets[15]); // a wallet that is not one of the heirs, so deltas are exact
    await w.vault.write.settle([s.vaultId], { account: w.wallets[15].account });
    const expected = splitShares(total, bps);
    for (let i = 0; i < 10; i++) assert.equal((await balance(A(w.wallets[2 + i]))) - before[i], expected[i], `heir ${i}`);
    assert.equal(expected.reduce((a, b) => a + b, 0n), total);
    assert.equal(await balance(w.vault.address), 0n);
  });

  it("dust: 10 wei across 3 heirs goes 3/3/4, remainder to the last heir", async () => {
    const { w, s } = await setup([3334, 3333, 3333], 10n);
    const before = await snapBalances(w, 3);
    await overdueAndTrigger(w, s.vaultId);
    await w.vault.write.settle([s.vaultId]);
    const d = [0, 1, 2].map(async (i) => (await balance(A(w.wallets[2 + i]))) - before[i]);
    assert.deepEqual(await Promise.all(d), [3n, 3n, 4n]);
    assert.deepEqual(splitShares(10n, [3334, 3333, 3333]), [3n, 3n, 4n]);
  });

  it("tiny balance: 1 wei goes entirely to the last heir; zero shares are skipped (no events)", async () => {
    const { w, s } = await setup([5000, 5000], 1n);
    await overdueAndTrigger(w, s.vaultId);
    await w.vault.write.settle([s.vaultId]);
    const paid = await w.vault.getEvents.HeirPaid({}, { fromBlock: 0n });
    assert.equal(paid.length, 1);
    assert.equal(paid[0].args.heirIndex, 1n);
    assert.equal(paid[0].args.amount, 1n);
  });

  it("native + 2 tokens: every asset split, sum paid equals pre-settle balance, nothing left behind", async () => {
    const w = await fresh();
    const t1 = await deployToken(w, "T1");
    const t2 = await deployToken(w, "T2");
    const s = await makeAccountVault(w, { interval: 60n, grace: 0, heirs: heirs(w, [5000, 3000, 2000]), tokens: [t1.address, t2.address] }, parseEther("7") + 3n);
    await depositTokenTo(w, s, t1, w.deployer, 1_000_003n);
    await depositTokenTo(w, s, t2, w.deployer, 77n);
    const before = await snapBalances(w, 3);
    const t1Before = await Promise.all([0, 1, 2].map((i) => t1.read.balanceOf([A(w.wallets[2 + i])])));
    await overdueAndTrigger(w, s.vaultId);
    await w.vault.write.settle([s.vaultId]);
    const bps = [5000, 3000, 2000];
    const n = splitShares(parseEther("7") + 3n, bps);
    const a = splitShares(1_000_003n, bps);
    const b = splitShares(77n, bps);
    for (let i = 0; i < 3; i++) {
      const h = A(w.wallets[2 + i]);
      assert.equal((await balance(h)) - before[i], n[i]);
      assert.equal((await t1.read.balanceOf([h])) - t1Before[i], a[i]);
      assert.equal(await t2.read.balanceOf([h]), b[i]);
    }
    assert.equal(await balance(w.vault.address), 0n);
    assert.equal(await t1.read.balanceOf([w.vault.address]), 0n);
    assert.equal(await t2.read.balanceOf([w.vault.address]), 0n);
    for (const asset of [zeroAddress, t1.address, t2.address]) assert.equal(await w.vault.read.balanceOf([s.vaultId, asset]), 0n);
  });

  it("settle before trigger / twice / unknown vault reverts", async () => {
    const { w, s } = await setup([10000], 1n);
    await expectError(w.vault.write.settle([s.vaultId]), "WrongStatus", [1]);
    await expectError(w.vault.write.settle([555n]), "VaultNotFound", [555n]);
    await overdueAndTrigger(w, s.vaultId);
    await w.vault.write.settle([s.vaultId]);
    await expectError(w.vault.write.settle([s.vaultId]), "WrongStatus", [3]);
  });

  it("a vault with only tokens (no native) settles; a vault with nothing settles cleanly", async () => {
    const w = await fresh();
    const t = await deployToken(w);
    const s = await makeAccountVault(w, { interval: 60n, grace: 0, heirs: heirs(w, [10000]), tokens: [t.address] });
    const empty = await makeAccountVault(w, { interval: 60n, grace: 0, heirs: heirs(w, [10000]), salt: keccak256("0x99") });
    await depositTokenTo(w, s, t, w.deployer, 500n);
    await overdueAndTrigger(w, s.vaultId);
    await w.vault.write.settle([s.vaultId]);
    assert.equal(await t.read.balanceOf([A(w.heir1)]), 500n);
    await w.vault.write.trigger([empty.vaultId]);
    await w.vault.write.settle([empty.vaultId]);
    assert.equal(await stateOf(w, empty.vaultId), 5);
  });

  it("DEVICE-mode vault settles the same way", async () => {
    const w = await fresh();
    const s = await makeDeviceVault(w, { interval: 60n, grace: 0, heirs: heirs(w, [6000, 4000]) }, parseEther("1"));
    const before = await snapBalances(w, 2);
    await overdueAndTrigger(w, s.vaultId);
    await w.vault.write.settle([s.vaultId]);
    assert.equal(await sumHeirDelta(w, before, 2), parseEther("1"));
  });

  it("the heirs list changed by the owner before the deadline is what settles", async () => {
    const { w, s } = await setup([5000, 5000], parseEther("1"));
    await ownerDo(s, act.setHeirs([{ account: A(w.heir3), payoutTo: A(w.heir3), bps: 10000 }]));
    const before = await balance(A(w.heir3));
    await overdueAndTrigger(w, s.vaultId);
    await w.vault.write.settle([s.vaultId]);
    assert.equal((await balance(A(w.heir3))) - before, parseEther("1"));
  });
});

describe("settle: hostile heirs and tokens", () => {
  async function receiverSetup(mode: number) {
    const w = await fresh();
    const bad = await viem.deployContract("EvilReceiver");
    await bad.write.setMode([mode]);
    const hs: H[] = [
      { account: A(w.heir1), payoutTo: A(w.heir1), bps: 4000 },
      { account: bad.address, payoutTo: bad.address, bps: 3000 },
      { account: A(w.heir3), payoutTo: A(w.heir3), bps: 3000 },
    ];
    const s = await makeAccountVault(w, { interval: 60n, grace: 0, heirs: hs }, parseEther("10"));
    return { w, s, bad };
  }

  it("a reverting heir: its share is credited, the other heirs are paid in the same tx", async () => {
    const { w, s, bad } = await receiverSetup(1);
    const b1 = await balance(A(w.heir1));
    const b3 = await balance(A(w.heir3));
    await overdueAndTrigger(w, s.vaultId);
    await w.vault.write.settle([s.vaultId]);
    assert.equal((await balance(A(w.heir1))) - b1, parseEther("4"));
    assert.equal((await balance(A(w.heir3))) - b3, parseEther("3"));
    assert.equal(await w.vault.read.claimable([s.vaultId, 1n, zeroAddress]), parseEther("3"));
    assert.equal(await balance(bad.address), 0n);
    assert.equal(await balance(w.vault.address), parseEther("3")); // still held, accounted as claimable
    assert.equal((await w.vault.getEvents.HeirCredited({}, { fromBlock: 0n })).length, 1);
    assert.equal(await w.vault.read.balanceOf([s.vaultId, zeroAddress]), 0n);
  });

  it("a gas-burning heir: capped, credited, settlement completes", async () => {
    const { w, s, bad } = await receiverSetup(2);
    const b3 = await balance(A(w.heir3));
    await overdueAndTrigger(w, s.vaultId);
    const hash = await w.vault.write.settle([s.vaultId]);
    const rc = await publicClient.getTransactionReceipt({ hash });
    assert.ok(rc.gasUsed < 600_000n, `gas ${rc.gasUsed}`);
    assert.equal(await w.vault.read.claimable([s.vaultId, 1n, zeroAddress]), parseEther("3"));
    assert.equal((await balance(A(w.heir3))) - b3, parseEther("3"));
    assert.equal(await balance(bad.address), 0n);
  });

  it("claim: pays the heir's CURRENT payoutTo after setPayout; replay of the claim reverts", async () => {
    const { w, s, bad } = await receiverSetup(1);
    await registerAccount(w, bad.address, pqKey("badheir"));
    await overdueAndTrigger(w, s.vaultId);
    await w.vault.write.settle([s.vaultId]);
    // claiming to the still-reverting payout fails and keeps the credit
    await expectError(w.vault.write.claim([s.vaultId, 1n, zeroAddress], { account: w.attacker.account }), "TransferFailed");
    assert.equal(await w.vault.read.claimable([s.vaultId, 1n, zeroAddress]), parseEther("3"));
    // heir PQ-signs a new payout address (works after settle)
    const au = await signPayout(w, s.vaultId, pqKey("badheir"), 1n, bad.address, A(w.payee1));
    await w.vault.write.setPayout([s.vaultId, 1n, A(w.payee1), au.nonce, au.expiry, au.sig], { account: w.attacker.account });
    const before = await balance(A(w.payee1));
    await w.vault.write.claim([s.vaultId, 1n, zeroAddress], { account: w.attacker.account });
    assert.equal((await balance(A(w.payee1))) - before, parseEther("3"));
    assert.equal(await w.vault.read.claimable([s.vaultId, 1n, zeroAddress]), 0n);
    await expectError(w.vault.write.claim([s.vaultId, 1n, zeroAddress]), "NothingToClaim");
    assert.equal(await balance(w.vault.address), 0n);
  });

  it("claim guards: before settle, bad index, nothing to claim, unknown vault", async () => {
    const { w, s } = await receiverSetup(1);
    await expectError(w.vault.write.claim([s.vaultId, 0n, zeroAddress]), "WrongStatus", [1]);
    await expectError(w.vault.write.claim([999n, 0n, zeroAddress]), "VaultNotFound");
    await overdueAndTrigger(w, s.vaultId);
    await expectError(w.vault.write.claim([s.vaultId, 0n, zeroAddress]), "WrongStatus", [2]);
    await w.vault.write.settle([s.vaultId]);
    await expectError(w.vault.write.claim([s.vaultId, 9n, zeroAddress]), "BadHeirIndex");
    await expectError(w.vault.write.claim([s.vaultId, 0n, zeroAddress]), "NothingToClaim"); // heir 0 was paid
  });

  async function tokenSetup(mode: number) {
    const w = await fresh();
    const evil = await viem.deployContract("EvilToken", [A(w.deployer), 1_000_000n * E18]);
    const good = await deployToken(w, "GOOD");
    const hs = heirs(w, [5000, 5000]);
    const s = await makeAccountVault(w, { interval: 60n, grace: 0, heirs: hs, tokens: [evil.address, good.address] }, parseEther("1"));
    await evil.write.approve([w.vault.address, 1000n], { account: w.deployer.account });
    await w.vault.write.depositToken([s.vaultId, evil.address, 1000n], { account: w.deployer.account });
    await depositTokenTo(w, s, good, w.deployer, 600n);
    await evil.write.setMode([mode]);
    return { w, s, evil, good };
  }

  for (const [name, mode] of [["returns false", 1], ["reverts", 2], ["burns gas", 4]] as const) {
    it(`token that ${name} on transfer: credited, other assets and heirs unaffected, settle completes`, async () => {
      const { w, s, evil, good } = await tokenSetup(mode);
      const nb = await snapBalances(w, 2);
      await overdueAndTrigger(w, s.vaultId);
      await w.vault.write.settle([s.vaultId]);
      assert.equal(await w.vault.read.claimable([s.vaultId, 0n, evil.address]), 500n);
      assert.equal(await w.vault.read.claimable([s.vaultId, 1n, evil.address]), 500n);
      assert.equal(await good.read.balanceOf([A(w.heir1)]), 300n);
      assert.equal(await good.read.balanceOf([A(w.heir2)]), 300n);
      assert.equal(await sumHeirDelta(w, nb, 2), parseEther("1"));
      assert.equal(await evil.read.balanceOf([w.vault.address]), 1000n);
      assert.equal(await w.vault.read.balanceOf([s.vaultId, evil.address]), 0n);
      // heal the token, claims now succeed
      await evil.write.setMode([0]);
      await w.vault.write.claim([s.vaultId, 0n, evil.address]);
      await w.vault.write.claim([s.vaultId, 1n, evil.address]);
      assert.equal(await evil.read.balanceOf([A(w.heir1)]), 500n);
      assert.equal(await evil.read.balanceOf([A(w.heir2)]), 500n);
    });
  }

  it("token with a returndata bomb does not break settlement", async () => {
    const { w, s, evil } = await tokenSetup(6);
    await overdueAndTrigger(w, s.vaultId);
    const hash = await w.vault.write.settle([s.vaultId]);
    const rc = await publicClient.getTransactionReceipt({ hash });
    assert.ok(rc.gasUsed < 1_500_000n, `gas ${rc.gasUsed}`);
    // returning 1 MiB costs far more than the 150k push cap, so the push fails and the share is credited
    assert.equal(await w.vault.read.claimable([s.vaultId, 0n, evil.address]), 500n);
    assert.equal(await evil.read.balanceOf([w.vault.address]), 1000n);
  });

  it("USDT-style token (no return value) is paid normally", async () => {
    const { w, s, evil } = await tokenSetup(7);
    await overdueAndTrigger(w, s.vaultId);
    await w.vault.write.settle([s.vaultId]);
    assert.equal(await evil.read.balanceOf([A(w.heir1)]), 500n);
    assert.equal((await w.vault.getEvents.HeirCredited({}, { fromBlock: 0n })).length, 0);
  });

  it("withdraw of a reverting token fails for that vault only; balances untouched", async () => {
    const { w, s, evil, good } = await tokenSetup(2);
    const { signAuth } = await import("../testkit/harness.js");
    const au = await signAuth(w, s.vaultId, s.key, s.mode, act.withdraw(evil.address, 10n, A(w.payee1)).digest);
    await expectRevert(w.vault.write.withdraw([s.vaultId, evil.address, 10n, A(w.payee1), au]), "EvilToken: revert");
    assert.equal(await w.vault.read.balanceOf([s.vaultId, good.address]), 600n);
    assert.equal(await w.vault.read.balanceOf([s.vaultId, evil.address]), 1000n);
  });

  it("starving settle of gas never converts a payment into a claim: either it succeeds fully or it reverts", async () => {
    const w = await fresh();
    const rs = await Promise.all([0, 1, 2].map(() => viem.deployContract("EvilReceiver")));
    const hs: H[] = rs.map((r, i) => ({ account: r.address, payoutTo: r.address, bps: i === 2 ? 3334 : 3333 }));
    const s = await makeAccountVault(w, { interval: 60n, grace: 0, heirs: hs }, parseEther("3"));
    await overdueAndTrigger(w, s.vaultId);
    const snap = await networkHelpers.takeSnapshot();
    let succeeded = 0;
    let insufficientGas = 0;
    for (let g = 100_000; g <= 700_000; g += 20_000) {
      let ok = false;
      try {
        await w.vault.write.settle([s.vaultId], { gas: BigInt(g) });
        ok = true;
      } catch (e: any) {
        const name = e?.cause?.data?.errorName ?? "";
        if (name === "InsufficientGas") insufficientGas++;
      }
      if (ok) {
        succeeded++;
        assert.equal((await w.vault.getEvents.HeirCredited({}, { fromBlock: 0n })).length, 0, `gas ${g} produced credits`);
        assert.equal(await balance(w.vault.address), 0n);
      }
      await snap.restore();
      // restore consumes the snapshot id in some versions; take a fresh one
      Object.assign(snap, await networkHelpers.takeSnapshot());
    }
    assert.ok(succeeded > 0, "some gas level must succeed");
    assert.ok(insufficientGas > 0, "starved levels must hit InsufficientGas, not partial settlement");
  });
});

describe("settle gas pre-check (L-2)", () => {
  it("a heir that needs ~45k gas at entry is paid, not credited, at every gas level where settle succeeds (incl. the minimum)", async () => {
    const w = await fresh();
    const r = await viem.deployContract("EvilReceiver");
    await r.write.setMode([4]); // NEED_GAS
    await r.write.setRequiredGas([45_000n]);
    const s = await makeAccountVault(w, { interval: 60n, grace: 0, heirs: [{ account: r.address, payoutTo: r.address, bps: 10000 }] }, parseEther("1"));
    await overdueAndTrigger(w, s.vaultId);
    let snap = await networkHelpers.takeSnapshot();
    let first: number | undefined;
    let ok = 0;
    for (let g = 60_000; g <= 400_000; g += 250) {
      let done = false;
      try {
        await w.vault.write.settle([s.vaultId], { gas: BigInt(g) });
        done = true;
      } catch {}
      if (done) {
        ok++;
        first ??= g;
        assert.equal(await w.vault.read.claimable([s.vaultId, 0n, zeroAddress]), 0n, `credited at gas ${g}`);
        assert.equal(await balance(r.address), parseEther("1"), `unpaid at gas ${g}`);
        if (ok >= 6) break;
      }
      await snap.restore();
      snap = await networkHelpers.takeSnapshot();
    }
    assert.ok(first !== undefined, "settle must succeed at some gas level");
  });
});

describe("setPayout (heir PQ signature)", () => {
  async function ctx() {
    const w = await fresh();
    await registerHeirs(w);
    const s = await makeAccountVault(w, { interval: 60n, grace: 0, heirs: heirs(w, [5000, 5000]) }, parseEther("2"));
    return { w, s };
  }
  const send = (w: World, id: bigint, idx: bigint, to: Address, a: { nonce: bigint; expiry: bigint; sig: `0x${string}` }) =>
    w.vault.write.setPayout([id, idx, to, a.nonce, a.expiry, a.sig], { account: w.attacker.account });

  it("happy path before trigger: payout changes, heir nonce increments, vault clock and nonce untouched", async () => {
    const { w, s } = await ctx();
    const v0 = await w.vault.read.getVault([s.vaultId]);
    const au = await signPayout(w, s.vaultId, pqKey("heir1"), 0n, A(w.heir1), A(w.payee1));
    await send(w, s.vaultId, 0n, A(w.payee1), au);
    assert.equal((await w.vault.read.getHeirs([s.vaultId]))[0].payoutTo.toLowerCase(), A(w.payee1).toLowerCase());
    assert.equal(await w.vault.read.heirNonce([s.vaultId, A(w.heir1)]), 1n);
    const v1 = await w.vault.read.getVault([s.vaultId]);
    assert.equal(v1.nonce, v0.nonce);
    assert.equal(v1.lastCheckin, v0.lastCheckin);
    assert.equal((await w.vault.getEvents.PayoutSet({}, { fromBlock: 0n })).length, 1);
    // settle pays the new address
    const before = await balance(A(w.payee1));
    await overdueAndTrigger(w, s.vaultId);
    await w.vault.write.settle([s.vaultId]);
    assert.equal((await balance(A(w.payee1))) - before, parseEther("1"));
  });

  it("works after trigger and after settle, but not on a closed vault", async () => {
    const { w, s } = await ctx();
    await overdueAndTrigger(w, s.vaultId);
    const a1 = await signPayout(w, s.vaultId, pqKey("heir1"), 0n, A(w.heir1), A(w.payee1));
    await send(w, s.vaultId, 0n, A(w.payee1), a1);
    await w.vault.write.settle([s.vaultId]);
    const a2 = await signPayout(w, s.vaultId, pqKey("heir1"), 0n, A(w.heir1), A(w.payee2));
    await send(w, s.vaultId, 0n, A(w.payee2), a2);

    const c = await makeAccountVault(w, { salt: keccak256("0x31"), heirs: heirs(w, [10000]) });
    await ownerDo(c, act.close(A(w.owner)));
    const a3 = await signPayout(w, c.vaultId, pqKey("heir1"), 0n, A(w.heir1), A(w.payee1));
    await expectError(send(w, c.vaultId, 0n, A(w.payee1), a3), "WrongStatus", [4]);
    await expectError(send(w, 1234n, 0n, A(w.payee1), a3), "VaultNotFound");
  });

  it("replay: the same signature twice fails with BadNonce", async () => {
    const { w, s } = await ctx();
    const au = await signPayout(w, s.vaultId, pqKey("heir1"), 0n, A(w.heir1), A(w.payee1));
    await send(w, s.vaultId, 0n, A(w.payee1), au);
    await expectError(send(w, s.vaultId, 0n, A(w.payee1), au), "BadNonce", [1n, 0n]);
  });

  it("another heir's key cannot move my share; the attacker's own key neither", async () => {
    const { w, s } = await ctx();
    const stolen = await signPayout(w, s.vaultId, pqKey("heir2"), 0n, A(w.heir1), A(w.attacker));
    await expectError(send(w, s.vaultId, 0n, A(w.attacker), stolen), "PQSignatureInvalid");
    await registerAccount(w, A(w.attacker), pqKey("attacker"));
    const own = await signPayout(w, s.vaultId, pqKey("attacker"), 0n, A(w.heir1), A(w.attacker));
    await expectError(send(w, s.vaultId, 0n, A(w.attacker), own), "PQSignatureInvalid");
    // a signature binds the heir index: heir1's signature for index 0 is not valid for index 1
    const sig0 = await signPayout(w, s.vaultId, pqKey("heir1"), 0n, A(w.heir1), A(w.payee1));
    await expectError(send(w, s.vaultId, 1n, A(w.payee1), sig0), "PQSignatureInvalid");
    // and cannot be redirected to a different payout
    await expectError(send(w, s.vaultId, 0n, A(w.attacker), sig0), "PQSignatureInvalid");
  });

  it("guards: bad index, expired, zero/self payout, wrong nonce, unregistered heir key states", async () => {
    const { w, s } = await ctx();
    const ok = await signPayout(w, s.vaultId, pqKey("heir1"), 0n, A(w.heir1), A(w.payee1));
    await expectError(send(w, s.vaultId, 5n, A(w.payee1), ok), "BadHeirIndex");
    const t = await now();
    const old = await signPayout(w, s.vaultId, pqKey("heir1"), 0n, A(w.heir1), A(w.payee1), { expiry: t - 1n });
    await expectError(send(w, s.vaultId, 0n, A(w.payee1), old), "SignatureExpired");
    const z = await signPayout(w, s.vaultId, pqKey("heir1"), 0n, A(w.heir1), zeroAddress);
    await expectError(send(w, s.vaultId, 0n, zeroAddress, z), "ZeroAddress");
    const me = await signPayout(w, s.vaultId, pqKey("heir1"), 0n, A(w.heir1), w.vault.address);
    await expectError(send(w, s.vaultId, 0n, w.vault.address, me), "BadRecipient");
    const bad = await signPayout(w, s.vaultId, pqKey("heir1"), 0n, A(w.heir1), A(w.payee1), { nonce: 4n });
    await expectError(send(w, s.vaultId, 0n, A(w.payee1), bad), "BadNonce", [0n, 4n]);
    await registerAccount(w, A(w.heir1), pqKey("heir1"), { proven: false });
    await expectError(send(w, s.vaultId, 0n, A(w.payee1), ok), "PQKeyPossessionNotProven");
    await registerAccount(w, A(w.heir1), pqKey("heir1"), { alg: 2 });
    await expectError(send(w, s.vaultId, 0n, A(w.payee1), ok), "PQKeyWrongAlgorithm");
    await registerAccount(w, A(w.heir1), pqKey("heir1"), { registered: false });
    await expectError(send(w, s.vaultId, 0n, A(w.payee1), ok), "PQKeyNotRegistered");
    await w.a02.write.setInactive([true]);
    await expectError(send(w, s.vaultId, 0n, A(w.payee1), ok), "PrecompileUnavailable");
  });

  it("inactive verify precompile fails closed", async () => {
    const { w, s } = await ctx();
    const ok = await signPayout(w, s.vaultId, pqKey("heir1"), 0n, A(w.heir1), A(w.payee1));
    await w.a01.write.setInactive([true]);
    await expectError(send(w, s.vaultId, 0n, A(w.payee1), ok), "PrecompileUnavailable");
  });

  it("heir nonces survive an owner's setHeirs: an old signature stays dead", async () => {
    const { w, s } = await ctx();
    const au = await signPayout(w, s.vaultId, pqKey("heir1"), 0n, A(w.heir1), A(w.payee1));
    await send(w, s.vaultId, 0n, A(w.payee1), au);
    await ownerDo(s, act.setHeirs(heirs(w, [5000, 5000]))); // same accounts, list replaced
    assert.equal(await w.vault.read.heirNonce([s.vaultId, A(w.heir1)]), 1n);
    await expectError(send(w, s.vaultId, 0n, A(w.payee1), au), "BadNonce");
    // payout was reset to the owner's new list
    assert.equal((await w.vault.read.getHeirs([s.vaultId]))[0].payoutTo.toLowerCase(), A(w.heir1).toLowerCase());
  });

  it("a signature for vault A cannot be used on vault B", async () => {
    const { w, s } = await ctx();
    const b = await makeAccountVault(w, { salt: keccak256("0x44"), heirs: heirs(w, [5000, 5000]) });
    const au = await signPayout(w, s.vaultId, pqKey("heir1"), 0n, A(w.heir1), A(w.payee1));
    await expectError(send(w, b.vaultId, 0n, A(w.payee1), au), "PQSignatureInvalid");
  });
});

void encodeFunctionData; void fundToken; void params; void warpBy;
