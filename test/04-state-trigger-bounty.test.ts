import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, zeroAddress } from "viem";
import { State, Status, deriveActiveState, triggerBounty } from "../lib/encoding.js";
import {
  KeyMode, act, balance, deployWorld, expectError, makeAccountVault, makeDeviceVault, networkHelpers, now, ownerDo,
  parseEther, publicClient, signAuth, stateOf, viem, warpBy, warpTo, type Scenario,
} from "../testkit/harness.js";

const INTERVAL = 3600n;
const world = () => deployWorld();
const fresh = () => networkHelpers.loadFixture(world);

async function mk(over = {}, value = parseEther("10")): Promise<Scenario> {
  const w = await fresh();
  return makeAccountVault(w, { interval: INTERVAL, grace: 2, ...over }, value);
}

describe("state machine with time travel", () => {
  it("ALIVE -> WARNING -> OVERDUE at the documented boundaries", async () => {
    const s = await mk();
    const v = await s.w.vault.read.getVault([s.vaultId]);
    const last = v.lastCheckin;
    const [warningAt, deadline] = await s.w.vault.read.deadlines([s.vaultId]);
    assert.equal(warningAt, last + INTERVAL);
    assert.equal(deadline, last + INTERVAL * 3n);
    assert.equal(await stateOf(s.w, s.vaultId), State.ALIVE);

    await warpTo(last + INTERVAL - 30n);
    assert.equal(await stateOf(s.w, s.vaultId), State.ALIVE);
    await warpTo(last + INTERVAL + 30n);
    assert.equal(await stateOf(s.w, s.vaultId), State.WARNING);
    await warpTo(last + INTERVAL * 3n - 30n);
    assert.equal(await stateOf(s.w, s.vaultId), State.WARNING);
    await warpTo(last + INTERVAL * 3n + 30n);
    assert.equal(await stateOf(s.w, s.vaultId), State.OVERDUE);
    // mirror in encoding.ts agrees
    assert.equal(deriveActiveState(last, INTERVAL, 2, last + INTERVAL * 3n + 30n), State.OVERDUE);
    assert.equal(deriveActiveState(last, INTERVAL, 2, last + INTERVAL + 30n), State.WARNING);
  });

  it("exact boundaries: stateOf at warningAt-1 / warningAt / deadline-1 / deadline (and the TS mirror)", async () => {
    const s = await mk();
    const [warningAt, deadline] = await s.w.vault.read.deadlines([s.vaultId]);
    const last = (await s.w.vault.read.getVault([s.vaultId])).lastCheckin;
    // mine a block at exactly `ts`, then read the view in that block's own environment
    const stateAt = async (ts: bigint) => {
      await warpTo(ts);
      const bn = await publicClient.getBlockNumber();
      return Number(await s.w.vault.read.stateOf([s.vaultId], { blockNumber: bn }));
    };
    assert.equal(await stateAt(warningAt - 1n), State.ALIVE);
    assert.equal(await stateAt(warningAt), State.WARNING);
    assert.equal(await stateAt(deadline - 1n), State.WARNING);
    assert.equal(await stateAt(deadline), State.OVERDUE);
    assert.equal(deriveActiveState(last, INTERVAL, 2, warningAt - 1n), State.ALIVE);
    assert.equal(deriveActiveState(last, INTERVAL, 2, warningAt), State.WARNING);
    assert.equal(deriveActiveState(last, INTERVAL, 2, deadline - 1n), State.WARNING);
    assert.equal(deriveActiveState(last, INTERVAL, 2, deadline), State.OVERDUE);
    assert.equal(deriveActiveState(last, INTERVAL, 0, last + INTERVAL - 1n), State.ALIVE);
    assert.equal(deriveActiveState(last, INTERVAL, 0, last + INTERVAL), State.OVERDUE);
  });

  it("grace 0 has no WARNING state", async () => {
    const s = await mk({ grace: 0 });
    const last = (await s.w.vault.read.getVault([s.vaultId])).lastCheckin;
    await warpTo(last + INTERVAL + 30n);
    assert.equal(await stateOf(s.w, s.vaultId), State.OVERDUE);
  });

  it("unknown id: NONE state and zero deadlines", async () => {
    const s = await mk();
    assert.equal(await stateOf(s.w, 12345n), State.NONE);
    assert.deepEqual(await s.w.vault.read.deadlines([12345n]), [0n, 0n]);
  });

  it("trigger before the deadline reverts NotOverdue(deadline), exactly at the deadline succeeds", async () => {
    const s = await mk();
    const [, deadline] = await s.w.vault.read.deadlines([s.vaultId]);
    await expectError(s.w.vault.write.trigger([s.vaultId]), "NotOverdue", [deadline]);
    await warpTo(deadline - 5n);
    await networkHelpers.time.setNextBlockTimestamp(Number(deadline - 1n));
    await expectError(s.w.vault.write.trigger([s.vaultId], { account: s.w.attacker.account }), "NotOverdue", [deadline]);
    await networkHelpers.time.setNextBlockTimestamp(Number(deadline));
    await s.w.vault.write.trigger([s.vaultId], { account: s.w.attacker.account });
    assert.equal(await stateOf(s.w, s.vaultId), State.TRIGGERED);
    assert.equal((await s.w.vault.read.getVault([s.vaultId])).triggeredAt, deadline);
  });

  it("an owner action while OVERDUE (before anyone triggers) revives the vault", async () => {
    const s = await mk();
    const [, deadline] = await s.w.vault.read.deadlines([s.vaultId]);
    await warpTo(deadline + 100n);
    assert.equal(await stateOf(s.w, s.vaultId), State.OVERDUE);
    await ownerDo(s, act.checkIn());
    assert.equal(await stateOf(s.w, s.vaultId), State.ALIVE);
    await expectError(s.w.vault.write.trigger([s.vaultId]), "NotOverdue");
  });

  it("every owner action resets the clock (not only checkIn)", async () => {
    const s = await mk();
    const last0 = (await s.w.vault.read.getVault([s.vaultId])).lastCheckin;
    await warpBy(2000);
    await ownerDo(s, act.withdraw(zeroAddress, 1n, s.w.payee1.account.address));
    const last1 = (await s.w.vault.read.getVault([s.vaultId])).lastCheckin;
    assert.ok(last1 >= last0 + 2000n);
    await warpBy(1000);
    await ownerDo(s, act.setTiming(7200n, 0, 0n));
    const v = await s.w.vault.read.getVault([s.vaultId]);
    assert.ok(v.lastCheckin >= last1 + 1000n);
    const [warningAt, deadline] = await s.w.vault.read.deadlines([s.vaultId]);
    assert.equal(warningAt, v.lastCheckin + 7200n);
    assert.equal(deadline, v.lastCheckin + 7200n);
  });

  it("a deposit does not keep the vault alive (agent payments: see 06)", async () => {
    const s = await mk();
    const [, deadline] = await s.w.vault.read.deadlines([s.vaultId]);
    await warpTo(deadline - 100n);
    await s.w.vault.write.depositNative([s.vaultId], { value: 1n });
    await warpTo(deadline + 1n);
    assert.equal(await stateOf(s.w, s.vaultId), State.OVERDUE);
  });

  it("trigger: unknown vault, double trigger, owner actions locked afterwards", async () => {
    const s = await mk();
    await expectError(s.w.vault.write.trigger([777n]), "VaultNotFound", [777n]);
    const [, deadline] = await s.w.vault.read.deadlines([s.vaultId]);
    // sign while still valid, trigger lands first, signature is dead
    const pending = await signAuth(s.w, s.vaultId, s.key, s.mode, act.checkIn().digest, { expiry: deadline + 10_000n });
    await warpTo(deadline + 1n);
    await s.w.vault.write.trigger([s.vaultId]);
    assert.equal(Number((await s.w.vault.read.getVault([s.vaultId])).status), Status.TRIGGERED);
    await expectError(s.w.vault.write.trigger([s.vaultId]), "WrongStatus", [2]);
    await expectError(s.w.vault.write.checkIn([s.vaultId, pending]), "WrongStatus", [2]);
    await expectError(
      s.w.vault.write.withdraw([s.vaultId, zeroAddress, 1n, s.w.owner.account.address, pending]),
      "WrongStatus",
      [2],
    );
    assert.equal(await stateOf(s.w, s.vaultId), State.TRIGGERED);
  });

  it("DEVICE-mode vault follows the same state machine", async () => {
    const w = await fresh();
    const s = await makeDeviceVault(w, { interval: INTERVAL, grace: 1 }, 1n);
    const last = (await w.vault.read.getVault([s.vaultId])).lastCheckin;
    await warpTo(last + INTERVAL * 2n + 30n);
    assert.equal(await stateOf(w, s.vaultId), State.OVERDUE);
    await w.vault.write.trigger([s.vaultId]);
    assert.equal(await stateOf(w, s.vaultId), State.TRIGGERED);
  });
});

describe("trigger bounty", () => {
  async function run(bounty: bigint, value: bigint) {
    const w = await fresh();
    const s = await makeAccountVault(w, { interval: 60n, grace: 0, bounty }, value);
    const caller = await viem.deployContract("EvilReceiver");
    await warpBy(61);
    const data = encodeFunctionData({ abi: w.vault.abi, functionName: "trigger", args: [s.vaultId] });
    await caller.write.exec([w.vault.address, data]);
    return { w, s, caller, received: await caller.read.received(), remaining: await w.vault.read.balanceOf([s.vaultId, zeroAddress]) };
  }

  it("zero native balance: bounty is 0, trigger still works", async () => {
    const r = await run(5n, 0n);
    assert.equal(r.received, 0n);
    assert.equal(await stateOf(r.w, r.s.vaultId), State.TRIGGERED);
  });

  it("bounty above 10% is capped at 10% of the native balance", async () => {
    const r = await run(parseEther("5"), parseEther("10"));
    assert.equal(r.received, parseEther("1"));
    assert.equal(r.remaining, parseEther("9"));
    assert.equal(triggerBounty(parseEther("5"), parseEther("10")), parseEther("1"));
  });

  it("bounty below 10% is paid in full", async () => {
    const r = await run(parseEther("0.25"), parseEther("10"));
    assert.equal(r.received, parseEther("0.25"));
    assert.equal(r.remaining, parseEther("9.75"));
  });

  it("zero bounty pays nothing and emits bountyPaid 0", async () => {
    const r = await run(0n, parseEther("10"));
    assert.equal(r.received, 0n);
    const ev = await r.w.vault.getEvents.Triggered({}, { fromBlock: 0n });
    assert.equal(ev[0].args.bountyPaid, 0n);
    assert.equal(ev[0].args.caller?.toLowerCase(), r.caller.address.toLowerCase());
  });

  it("10% rounds down: 15 wei balance caps a big bounty at 1 wei", async () => {
    const r = await run(1000n, 15n);
    assert.equal(r.received, 1n);
    assert.equal(triggerBounty(1000n, 15n), 1n);
  });

  it("bounty goes to the caller (msg.sender), not the vault owner or heirs", async () => {
    const w = await fresh();
    const s = await makeAccountVault(w, { interval: 60n, grace: 0, bounty: parseEther("1") }, parseEther("20"));
    await warpBy(61);
    const before = await balance(w.attacker.account.address);
    const hash = await w.vault.write.trigger([s.vaultId], { account: w.attacker.account });
    const rcpt = await (await viem.getPublicClient()).getTransactionReceipt({ hash });
    const after = await balance(w.attacker.account.address);
    assert.equal(after - before + rcpt.gasUsed * rcpt.effectiveGasPrice, parseEther("1"));
  });

  it("a caller that cannot receive the bounty gets TransferFailed and the vault stays untriggered", async () => {
    const w = await fresh();
    const s = await makeAccountVault(w, { interval: 60n, grace: 0, bounty: 100n }, parseEther("1"));
    const caller = await viem.deployContract("EvilReceiver");
    await caller.write.setMode([1]); // REVERT
    await warpBy(61);
    const data = encodeFunctionData({ abi: w.vault.abi, functionName: "trigger", args: [s.vaultId] });
    const pc = await viem.getPublicClient();
    const sim = await pc.simulateContract({ address: caller.address, abi: caller.abi, functionName: "exec", args: [w.vault.address, data] });
    assert.equal(sim.result[0], false);
    await caller.write.exec([w.vault.address, data]); // inner call fails, the outer tx succeeds
    assert.equal(await stateOf(w, s.vaultId), State.OVERDUE);
    assert.equal(await w.vault.read.balanceOf([s.vaultId, zeroAddress]), parseEther("1"));
  });

  it("an agent is revoked by trigger", async () => {
    const w = await fresh();
    const s = await makeAccountVault(w, { interval: 3600n, grace: 0 }, parseEther("1"));
    await ownerDo(s, act.setAgent(w.agent.account.address, zeroAddress, 10n, 100n, 4_000_000_000n, [w.payee1.account.address]));
    assert.equal((await w.vault.read.getAgent([s.vaultId])).agent.toLowerCase(), w.agent.account.address.toLowerCase());
    await warpBy(3601);
    await w.vault.write.trigger([s.vaultId]);
    assert.equal((await w.vault.read.getAgent([s.vaultId])).agent, zeroAddress);
    const ev = await w.vault.getEvents.AgentRevoked({}, { fromBlock: 0n });
    assert.equal(ev.length, 1);
  });
});

void KeyMode; void now;
