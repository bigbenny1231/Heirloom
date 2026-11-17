/**
 * Hostile tokens and receivers try to re-enter the vault from inside its own external calls.
 * Every state-changing function is nonReentrant, so each inner call must fail with
 * ReentrancyGuardReentrantCall (0x3ee5aeb5) and the outer call must still do exactly what it should.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, keccak256, zeroAddress, type Address, type Hex } from "viem";
import {
  act, balance, deployWorld, depositTokenTo, makeAccountVault, networkHelpers, now, ownerDo, overdueAndTrigger,
  parseEther, signAuth, viem, E18, type World,
} from "../testkit/harness.js";

const A = (a: { account: { address: Address } }) => a.account.address;
const fresh = () => networkHelpers.loadFixture(deployWorld);
const GUARD = "0x3ee5aeb5";

const callData = (w: World, fn: string, args: readonly unknown[]): Hex =>
  encodeFunctionData({ abi: w.vault.abi, functionName: fn as never, args: args as never });

function assertBlocked(attempted: boolean, succeeded: boolean, ret: Hex, what: string) {
  assert.equal(attempted, true, `${what}: reentry was attempted`);
  assert.equal(succeeded, false, `${what}: reentry must fail`);
  assert.ok(ret.startsWith(GUARD), `${what}: expected ReentrancyGuardReentrantCall, got ${ret.slice(0, 10)}`);
}

describe("reentrant token", () => {
  async function ctx(reenter: (w: World, id: bigint) => Hex, mode = 3) {
    const w = await fresh();
    const evil = await viem.deployContract("EvilToken", [A(w.deployer), 1_000_000n * E18]);
    const s = await makeAccountVault(w, { interval: 60n, grace: 0, tokens: [evil.address] }, parseEther("1"));
    await evil.write.setReentry([w.vault.address, reenter(w, s.vaultId), true, true]);
    await evil.write.setMode([mode]);
    return { w, s, evil };
  }

  it("during depositToken (transferFrom): reenter depositNative, depositToken, trigger", async () => {
    for (const mk of [
      (w: World, id: bigint) => callData(w, "depositNative", [id]),
      (w: World, id: bigint) => callData(w, "trigger", [id]),
      (w: World, id: bigint) => callData(w, "settle", [id]),
    ]) {
      const { w, s, evil } = await ctx(mk);
      await evil.write.approve([w.vault.address, 100n], { account: w.deployer.account });
      await w.vault.write.depositToken([s.vaultId, evil.address, 100n], { account: w.deployer.account });
      assertBlocked(await evil.read.reentryAttempted(), await evil.read.reentrySucceeded(), await evil.read.lastReentryReturn(), "deposit");
      assert.equal(await w.vault.read.balanceOf([s.vaultId, evil.address]), 100n); // credited exactly once
    }
  });

  it("during the heirs' token push inside settle: reenter settle / claim / trigger", async () => {
    for (const mk of [
      (w: World, id: bigint) => callData(w, "settle", [id]),
      (w: World, id: bigint) => callData(w, "claim", [id, 0n, zeroAddress]),
      (w: World, id: bigint) => callData(w, "trigger", [id]),
    ]) {
      const { w, s, evil } = await ctx(mk, 0);
      await evil.write.approve([w.vault.address, 1000n], { account: w.deployer.account });
      await w.vault.write.depositToken([s.vaultId, evil.address, 1000n], { account: w.deployer.account });
      await evil.write.setMode([3]);
      await overdueAndTrigger(w, s.vaultId);
      await w.vault.write.settle([s.vaultId]);
      assertBlocked(await evil.read.reentryAttempted(), await evil.read.reentrySucceeded(), await evil.read.lastReentryReturn(), "settle push");
      // the heirs were paid the whole token balance exactly once (3 heirs: 50/30/20)
      assert.equal(await evil.read.balanceOf([A(w.heir1)]), 500n);
      assert.equal(await evil.read.balanceOf([A(w.heir2)]), 300n);
      assert.equal(await evil.read.balanceOf([A(w.heir3)]), 200n);
      assert.equal(await evil.read.balanceOf([w.vault.address]), 0n);
    }
  });

  it("during an owner withdraw of the token: reenter withdraw with the very same auth", async () => {
    const w = await fresh();
    const evil = await viem.deployContract("EvilToken", [A(w.deployer), 1_000_000n * E18]);
    const s = await makeAccountVault(w, { interval: 3600n, grace: 0, tokens: [evil.address] });
    await evil.write.approve([w.vault.address, 1000n], { account: w.deployer.account });
    await w.vault.write.depositToken([s.vaultId, evil.address, 1000n], { account: w.deployer.account });
    const a = act.withdraw(evil.address, 400n, A(w.payee1));
    const auth = await signAuth(w, s.vaultId, s.key, s.mode, a.digest);
    await evil.write.setReentry([w.vault.address, callData(w, "withdraw", [s.vaultId, evil.address, 400n, A(w.payee1), auth]), true, true]);
    await evil.write.setMode([3]);
    await a.send(w, s.vaultId, auth);
    assertBlocked(await evil.read.reentryAttempted(), await evil.read.reentrySucceeded(), await evil.read.lastReentryReturn(), "withdraw");
    assert.equal(await evil.read.balanceOf([A(w.payee1)]), 400n);
    assert.equal(await w.vault.read.balanceOf([s.vaultId, evil.address]), 600n);
  });

  it("during an owner close: reenter close", async () => {
    const w = await fresh();
    const evil = await viem.deployContract("EvilToken", [A(w.deployer), 1_000_000n * E18]);
    const s = await makeAccountVault(w, { interval: 3600n, grace: 0, tokens: [evil.address] }, parseEther("1"));
    await evil.write.approve([w.vault.address, 1000n], { account: w.deployer.account });
    await w.vault.write.depositToken([s.vaultId, evil.address, 1000n], { account: w.deployer.account });
    const a = act.close(A(w.payee1));
    const auth = await signAuth(w, s.vaultId, s.key, s.mode, a.digest);
    await evil.write.setReentry([w.vault.address, callData(w, "close", [s.vaultId, A(w.payee1), auth]), true, true]);
    await evil.write.setMode([3]);
    await a.send(w, s.vaultId, auth);
    assertBlocked(await evil.read.reentryAttempted(), await evil.read.reentrySucceeded(), await evil.read.lastReentryReturn(), "close");
    assert.equal(await evil.read.balanceOf([A(w.payee1)]), 1000n);
  });

  it("during an agent token payment: reenter agentPay", async () => {
    const w = await fresh();
    const evil = await viem.deployContract("EvilToken", [A(w.deployer), 1_000_000n * E18]);
    const s = await makeAccountVault(w, { interval: 3600n * 24n, grace: 0, tokens: [evil.address] });
    await evil.write.approve([w.vault.address, 1000n], { account: w.deployer.account });
    await w.vault.write.depositToken([s.vaultId, evil.address, 1000n], { account: w.deployer.account });
    await ownerDo(s, act.setAgent(A(w.agent), evil.address, 100n, 100n, (await now()) + 3600n, [A(w.payee1)]));
    await evil.write.setReentry([w.vault.address, callData(w, "agentPay", [s.vaultId, A(w.payee1), 100n]), false, true]);
    await evil.write.setMode([3]);
    await w.vault.write.agentPay([s.vaultId, A(w.payee1), 100n], { account: w.agent.account });
    // inner call came from the token (not the agent): blocked by the guard before the agent check
    assertBlocked(await evil.read.reentryAttempted(), await evil.read.reentrySucceeded(), await evil.read.lastReentryReturn(), "agentPay");
    assert.equal(await evil.read.balanceOf([A(w.payee1)]), 100n);
    assert.equal((await w.vault.read.getAgent([s.vaultId])).spentToday, 100n);
  });
});

describe("reentrant native receiver", () => {
  it("during an owner withdraw: receiver tries withdraw, checkIn, depositNative, trigger", async () => {
    for (const fn of ["checkIn", "depositNative", "trigger"] as const) {
      const w = await fresh();
      const r = await viem.deployContract("EvilReceiver");
      const s = await makeAccountVault(w, { interval: 3600n, grace: 0 }, parseEther("1"));
      const a = act.withdraw(zeroAddress, 100n, r.address);
      const auth = await signAuth(w, s.vaultId, s.key, s.mode, a.digest);
      const data =
        fn === "checkIn" ? callData(w, "checkIn", [s.vaultId, auth])
        : fn === "depositNative" ? callData(w, "depositNative", [s.vaultId])
        : callData(w, "trigger", [s.vaultId]);
      await r.write.setReentry([w.vault.address, data]);
      await r.write.setMode([3]);
      await a.send(w, s.vaultId, auth);
      assertBlocked(await r.read.reentryAttempted(), await r.read.reentrySucceeded(), await r.read.lastReentryReturn(), `withdraw->${fn}`);
      assert.equal(await r.read.received(), 100n);
      assert.equal(await w.vault.read.balanceOf([s.vaultId, zeroAddress]), parseEther("1") - 100n);
    }
  });

  it("during the trigger bounty: caller contract reenters trigger and settle", async () => {
    for (const fn of ["trigger", "settle"] as const) {
      const w = await fresh();
      const r = await viem.deployContract("EvilReceiver");
      const s = await makeAccountVault(w, { interval: 60n, grace: 0, bounty: parseEther("0.1") }, parseEther("1"));
      await r.write.setReentry([w.vault.address, callData(w, fn, [s.vaultId])]);
      await r.write.setMode([3]);
      await networkHelpers.time.increase(61);
      await r.write.exec([w.vault.address, callData(w, "trigger", [s.vaultId])]);
      assertBlocked(await r.read.reentryAttempted(), await r.read.reentrySucceeded(), await r.read.lastReentryReturn(), `bounty->${fn}`);
      assert.equal(await r.read.received(), parseEther("0.1"));
      assert.equal(Number(await w.vault.read.stateOf([s.vaultId])), 4);
    }
  });

  it("during settle: heir contract reenters settle and claim; it is still paid once", async () => {
    for (const fn of ["settle", "claim"] as const) {
      const w = await fresh();
      const r = await viem.deployContract("EvilReceiver");
      const s = await makeAccountVault(
        w,
        { interval: 60n, grace: 0, heirs: [{ account: r.address, payoutTo: r.address, bps: 10000 }] },
        parseEther("1"),
      );
      await r.write.setReentry([w.vault.address, fn === "settle" ? callData(w, "settle", [s.vaultId]) : callData(w, "claim", [s.vaultId, 0n, zeroAddress])]);
      await r.write.setMode([3]);
      await overdueAndTrigger(w, s.vaultId);
      await w.vault.write.settle([s.vaultId]);
      // push gas cap is 50k: the receive() with its SSTOREs and the failed inner call may or may not fit.
      // Either way the money is conserved: paid to the heir or credited, never both, never lost.
      const got = await r.read.received();
      const credited = await w.vault.read.claimable([s.vaultId, 0n, zeroAddress]);
      assert.equal(got + credited, parseEther("1"));
      assert.equal(await balance(w.vault.address), credited);
      assert.equal(await r.read.reentrySucceeded(), false);
    }
  });

  it("during claim: heir reenters claim; it receives exactly the credited amount once", async () => {
    const w = await fresh();
    const r = await viem.deployContract("EvilReceiver");
    const s = await makeAccountVault(
      w,
      { interval: 60n, grace: 0, heirs: [{ account: r.address, payoutTo: r.address, bps: 10000 }] },
      parseEther("1"),
    );
    await r.write.setMode([1]); // reverts during settle -> credited
    await overdueAndTrigger(w, s.vaultId);
    await w.vault.write.settle([s.vaultId]);
    assert.equal(await w.vault.read.claimable([s.vaultId, 0n, zeroAddress]), parseEther("1"));
    await r.write.setReentry([w.vault.address, callData(w, "claim", [s.vaultId, 0n, zeroAddress])]);
    await r.write.setMode([3]);
    await w.vault.write.claim([s.vaultId, 0n, zeroAddress]);
    assertBlocked(await r.read.reentryAttempted(), await r.read.reentrySucceeded(), await r.read.lastReentryReturn(), "claim");
    assert.equal(await r.read.received(), parseEther("1"));
    assert.equal(await balance(w.vault.address), 0n);
  });

  it("during agentPay: a payee that is also the agent contract reenters agentPay", async () => {
    const w = await fresh();
    const r = await viem.deployContract("EvilReceiver");
    const s = await makeAccountVault(w, { interval: 3600n * 24n, grace: 0 }, parseEther("1"));
    await ownerDo(s, act.setAgent(r.address, zeroAddress, 100n, 1000n, (await now()) + 3600n, [r.address]));
    await r.write.setReentry([w.vault.address, callData(w, "agentPay", [s.vaultId, r.address, 100n])]);
    await r.write.setMode([3]);
    await r.write.exec([w.vault.address, callData(w, "agentPay", [s.vaultId, r.address, 100n])]);
    assertBlocked(await r.read.reentryAttempted(), await r.read.reentrySucceeded(), await r.read.lastReentryReturn(), "agentPay");
    assert.equal(await r.read.received(), 100n);
    assert.equal((await w.vault.read.getAgent([s.vaultId])).spentToday, 100n);
  });

  it("during close: receiver reenters close", async () => {
    const w = await fresh();
    const r = await viem.deployContract("EvilReceiver");
    const s = await makeAccountVault(w, { interval: 3600n, grace: 0 }, parseEther("1"));
    const a = act.close(r.address);
    const auth = await signAuth(w, s.vaultId, s.key, s.mode, a.digest);
    await r.write.setReentry([w.vault.address, callData(w, "close", [s.vaultId, r.address, auth])]);
    await r.write.setMode([3]);
    await a.send(w, s.vaultId, auth);
    assertBlocked(await r.read.reentryAttempted(), await r.read.reentrySucceeded(), await r.read.lastReentryReturn(), "close");
    assert.equal(await r.read.received(), parseEther("1"));
  });
});

void keccak256;
