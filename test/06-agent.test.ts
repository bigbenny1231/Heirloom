import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keccak256, parseEventLogs, zeroAddress, type Address } from "viem";
import { DenyReason } from "../lib/encoding.js";
import {
  E18, balance, deployToken, deployWorld, depositTokenTo, expectError, makeAccountVault, makeDeviceVault, networkHelpers,
  now, ownerDo, act, parseEther, signAuth, stateOf, viem, warpBy, warpTo, publicClient, type Scenario, type World,
} from "../testkit/harness.js";

const A = (a: { account: { address: Address } }) => a.account.address;
const DAY = 86400n;
const world = () => deployWorld();
const fresh = () => networkHelpers.loadFixture(world);

interface Cfg { perTx?: bigint; daily?: bigint; validFor?: bigint; token?: Address; payees?: Address[] }

/** ALIVE-for-30-days vault with native funds and an agent. */
async function setup(cfg: Cfg = {}, o: { salt?: `0x${string}` } = {}) {
  const w = await fresh();
  const tok = await deployToken(w, "AG");
  const s = await makeAccountVault(w, { interval: 30n * DAY, grace: 0, tokens: [tok.address], ...(o.salt ? { salt: o.salt } : {}) }, parseEther("10"));
  await depositTokenTo(w, s, tok, w.deployer, 1000n);
  const payees = cfg.payees ?? [A(w.payee1), A(w.payee2)];
  const validUntil = (await now()) + (cfg.validFor ?? 10n * DAY);
  await ownerDo(s, act.setAgent(A(w.agent), cfg.token ?? zeroAddress, cfg.perTx ?? parseEther("1"), cfg.daily ?? parseEther("2"), validUntil, payees));
  return { w, s, tok, validUntil, payees };
}

async function pay(w: World, id: bigint, to: Address, amount: bigint, from = w.agent) {
  const hash = await w.vault.write.agentPay([id, to, amount], { account: from.account });
  const rc = await publicClient.getTransactionReceipt({ hash });
  // read the outcome from the events: eth_call timestamps are not controllable the way block timestamps are
  const logs = parseEventLogs({ abi: w.vault.abi, logs: rc.logs });
  const paid = logs.some((l) => l.eventName === "AgentPaid");
  assert.ok(paid || logs.some((l) => l.eventName === "AgentPayDenied"), "agentPay must emit exactly one outcome event");
  return { paid, rc };
}
const denies = (w: World) => w.vault.getEvents.AgentPayDenied({}, { fromBlock: 0n });
const paids = (w: World) => w.vault.getEvents.AgentPaid({}, { fromBlock: 0n });

describe("agent allowance: policy order and deny reasons", () => {
  it("allowed payment: moves value, updates spent counters, emits AgentPaid, returns true", async () => {
    const { w, s } = await setup();
    const before = await balance(A(w.payee1));
    const r = await pay(w, s.vaultId, A(w.payee1), parseEther("0.4"));
    assert.equal(r.paid, true);
    assert.equal((await balance(A(w.payee1))) - before, parseEther("0.4"));
    assert.equal(await w.vault.read.balanceOf([s.vaultId, zeroAddress]), parseEther("9.6"));
    const ag = await w.vault.read.getAgent([s.vaultId]);
    assert.equal(ag.spentToday, parseEther("0.4"));
    assert.equal(ag.spentDay, BigInt(Math.floor(Number(await now()) / 86400)));
    const ev = await paids(w);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].args.amount, parseEther("0.4"));
    assert.equal(ev[0].args.spentToday, parseEther("0.4"));
  });

  it("each DenyReason: returns false, emits AgentPayDenied with the code, changes nothing", async () => {
    const { w, s } = await setup({ perTx: parseEther("1"), daily: parseEther("1.5") });
    const check = async (to: Address, amount: bigint, reason: DenyReason) => {
      const bal = await w.vault.read.balanceOf([s.vaultId, zeroAddress]);
      const ag0 = await w.vault.read.getAgent([s.vaultId]);
      const r = await pay(w, s.vaultId, to, amount);
      assert.equal(r.paid, false, DenyReason[reason]);
      const ev = await denies(w);
      assert.equal(ev.at(-1)!.args.reason, reason, DenyReason[reason]);
      assert.equal(ev.at(-1)!.args.amount, amount);
      assert.equal(await w.vault.read.balanceOf([s.vaultId, zeroAddress]), bal);
      assert.equal((await w.vault.read.getAgent([s.vaultId])).spentToday, ag0.spentToday);
    };
    await check(A(w.attacker), 1n, DenyReason.PAYEE_NOT_ALLOWED);
    await check(A(w.payee1), 0n, DenyReason.ZERO_AMOUNT);
    await check(A(w.payee1), parseEther("1") + 1n, DenyReason.OVER_PER_TX);
    // spend 1, then 1 more breaks the 1.5 daily cap
    assert.equal((await pay(w, s.vaultId, A(w.payee1), parseEther("1"))).paid, true);
    await check(A(w.payee1), parseEther("1"), DenyReason.OVER_DAILY);
    assert.equal((await pay(w, s.vaultId, A(w.payee1), parseEther("0.5"))).paid, true); // exactly the cap is fine
    await check(A(w.payee1), 1n, DenyReason.OVER_DAILY);
  });

  it("INSUFFICIENT_BALANCE when the vault holds less than the (otherwise legal) amount", async () => {
    const { w, s } = await setup({ perTx: parseEther("100"), daily: parseEther("100") });
    // owner withdraws almost everything (a PQ-signed action), leaving 0.5
    await ownerDo(s, act.withdraw(zeroAddress, parseEther("9.5"), A(w.owner)));
    const r = await pay(w, s.vaultId, A(w.payee1), parseEther("1"));
    assert.equal(r.paid, false);
    assert.equal((await denies(w)).at(-1)!.args.reason, DenyReason.INSUFFICIENT_BALANCE);
  });

  it("EXPIRED after validUntil (inclusive boundary)", async () => {
    const { w, s, validUntil } = await setup({ validFor: 1000n });
    await networkHelpers.time.setNextBlockTimestamp(Number(validUntil));
    assert.equal((await pay(w, s.vaultId, A(w.payee1), 1n)).paid, true); // t == validUntil still ok
    await networkHelpers.time.setNextBlockTimestamp(Number(validUntil + 1n));
    const r = await pay(w, s.vaultId, A(w.payee1), 1n);
    assert.equal(r.paid, false);
    assert.equal((await denies(w)).at(-1)!.args.reason, DenyReason.EXPIRED);
  });

  it("NOT_ALIVE in WARNING and OVERDUE (agent pay needs a fresh heartbeat, not just 'not triggered')", async () => {
    const w = await fresh();
    const s = await makeAccountVault(w, { interval: 3600n, grace: 2 }, parseEther("1"));
    await ownerDo(s, act.setAgent(A(w.agent), zeroAddress, 10n, 100n, (await now()) + 100n * DAY, [A(w.payee1)]));
    assert.equal((await pay(w, s.vaultId, A(w.payee1), 1n)).paid, true);
    await warpBy(3700); // WARNING
    assert.equal(await stateOf(w, s.vaultId), 2);
    let r = await pay(w, s.vaultId, A(w.payee1), 1n);
    assert.equal(r.paid, false);
    assert.equal((await denies(w)).at(-1)!.args.reason, DenyReason.NOT_ALIVE);
    await warpBy(3600 * 3); // OVERDUE
    r = await pay(w, s.vaultId, A(w.payee1), 1n);
    assert.equal(r.paid, false);
    assert.equal((await denies(w)).at(-1)!.args.reason, DenyReason.NOT_ALIVE);
    // a PQ-signed check-in makes it ALIVE again and the agent works again
    await ownerDo(s, act.checkIn());
    assert.equal((await pay(w, s.vaultId, A(w.payee1), 1n)).paid, true);
  });

  it("agentPay at exactly warningAt is NOT_ALIVE; one second earlier it still pays", async () => {
    const w = await fresh();
    const s = await makeAccountVault(w, { interval: 3600n, grace: 2 }, parseEther("1"));
    await ownerDo(s, act.setAgent(A(w.agent), zeroAddress, 10n, 100n, (await now()) + 100n * DAY, [A(w.payee1)]));
    const [warningAt] = await w.vault.read.deadlines([s.vaultId]);
    await networkHelpers.time.setNextBlockTimestamp(Number(warningAt - 1n));
    assert.equal((await pay(w, s.vaultId, A(w.payee1), 1n)).paid, true);
    await networkHelpers.time.setNextBlockTimestamp(Number(warningAt));
    assert.equal((await pay(w, s.vaultId, A(w.payee1), 1n)).paid, false);
    assert.equal((await denies(w)).at(-1)!.args.reason, DenyReason.NOT_ALIVE);
  });

  it("first failing rule wins: NOT_ALIVE > EXPIRED > PAYEE > ZERO > PER_TX > DAILY > BALANCE", async () => {
    const w = await fresh();
    const s = await makeAccountVault(w, { interval: 3600n, grace: 2 }, 5n);
    const validUntil = (await now()) + 5000n;
    await ownerDo(s, act.setAgent(A(w.agent), zeroAddress, 3n, 4n, validUntil, [A(w.payee1)]));
    const snap = await networkHelpers.takeSnapshot();
    // everything wrong at once -> payee? first rule is alive: warp into WARNING and past validUntil
    await warpTo(validUntil + 1000n); // WARNING (not alive) and expired
    await pay(w, s.vaultId, A(w.attacker), 0n);
    assert.equal((await denies(w)).at(-1)!.args.reason, DenyReason.NOT_ALIVE);
    await snap.restore();
    // alive + expired + wrong payee + zero amount -> EXPIRED
    await ownerDo(s, act.setTiming(30n * DAY, 0, 0n));
    await ownerDo(s, act.setAgent(A(w.agent), zeroAddress, 3n, 4n, (await now()) + 100n, [A(w.payee1)]));
    await warpBy(200);
    await pay(w, s.vaultId, A(w.attacker), 0n);
    assert.equal((await denies(w)).at(-1)!.args.reason, DenyReason.EXPIRED);
    await ownerDo(s, act.setAgent(A(w.agent), zeroAddress, 3n, 4n, (await now()) + 100n * DAY, [A(w.payee1)]));
    // wrong payee + zero amount + over per-tx -> PAYEE
    await pay(w, s.vaultId, A(w.attacker), 0n);
    assert.equal((await denies(w)).at(-1)!.args.reason, DenyReason.PAYEE_NOT_ALLOWED);
    // payee ok + zero -> ZERO (beats per-tx etc.)
    await pay(w, s.vaultId, A(w.payee1), 0n);
    assert.equal((await denies(w)).at(-1)!.args.reason, DenyReason.ZERO_AMOUNT);
    // over per tx (4 > 3) and over balance (5 holds, so no) -> PER_TX; per-tx beats daily
    await pay(w, s.vaultId, A(w.payee1), 4n);
    assert.equal((await denies(w)).at(-1)!.args.reason, DenyReason.OVER_PER_TX);
    // 3 ok, then 2 would exceed daily 4 -> DAILY, even though balance (2 left) could cover it
    assert.equal((await pay(w, s.vaultId, A(w.payee1), 3n)).paid, true);
    await pay(w, s.vaultId, A(w.payee1), 2n);
    assert.equal((await denies(w)).at(-1)!.args.reason, DenyReason.OVER_DAILY);
  });

  it("UTC day rollover resets the daily counter; same-day boundary does not", async () => {
    const { w, s } = await setup({ perTx: 10n, daily: 15n });
    const t0 = await now();
    const midnight = (t0 / DAY + 1n) * DAY;
    assert.equal((await pay(w, s.vaultId, A(w.payee1), 10n)).paid, true);
    assert.equal((await pay(w, s.vaultId, A(w.payee1), 10n)).paid, false); // OVER_DAILY
    await networkHelpers.time.setNextBlockTimestamp(Number(midnight - 1n));
    assert.equal((await pay(w, s.vaultId, A(w.payee1), 10n)).paid, false); // still the same UTC day
    await networkHelpers.time.setNextBlockTimestamp(Number(midnight));
    assert.equal((await pay(w, s.vaultId, A(w.payee1), 10n)).paid, true); // new day
    const ag = await w.vault.read.getAgent([s.vaultId]);
    assert.equal(ag.spentToday, 10n);
    assert.equal(ag.spentDay, midnight / DAY);
    // worst case across a midnight is 2 x daily
    assert.equal((await pay(w, s.vaultId, A(w.payee1), 5n)).paid, true);
    assert.equal((await pay(w, s.vaultId, A(w.payee1), 1n)).paid, false);
  });

  it("leaked agent key: total loss is bounded by dailyLimit per UTC day, only to payees", async () => {
    const { w, s } = await setup({ perTx: 100n, daily: 250n });
    const t0 = await now();
    const midnight = (t0 / DAY + 1n) * DAY;
    await networkHelpers.time.setNextBlockTimestamp(Number(midnight - 50n));
    let stolen = 0n;
    for (let i = 0; i < 5; i++) if ((await pay(w, s.vaultId, A(w.payee1), 100n)).paid) stolen += 100n;
    await networkHelpers.time.setNextBlockTimestamp(Number(midnight + 5n));
    for (let i = 0; i < 5; i++) if ((await pay(w, s.vaultId, A(w.payee1), 100n)).paid) stolen += 100n;
    assert.ok(stolen <= 2n * 250n, `stolen ${stolen}`);
    assert.equal((await pay(w, s.vaultId, A(w.agent), 1n)).paid, false); // the agent itself is not a payee
  });

  it("an agent payment is not a check-in: lastCheckin and nonce never move", async () => {
    const { w, s } = await setup();
    const v0 = await w.vault.read.getVault([s.vaultId]);
    await warpBy(500);
    await pay(w, s.vaultId, A(w.payee1), 1n);
    const v1 = await w.vault.read.getVault([s.vaultId]);
    assert.equal(v1.lastCheckin, v0.lastCheckin);
    assert.equal(v1.nonce, v0.nonce);
  });

  it("a payee that rejects value reverts the whole payment (counters untouched)", async () => {
    const w = await fresh();
    const bad = await viem.deployContract("EvilReceiver");
    const s = await makeAccountVault(w, { interval: 30n * DAY, grace: 0 }, parseEther("1"));
    await bad.write.setMode([1]);
    await ownerDo(s, act.setAgent(A(w.agent), zeroAddress, 10n, 100n, (await now()) + 10n * DAY, [bad.address]));
    await expectError(w.vault.write.agentPay([s.vaultId, bad.address, 5n], { account: w.agent.account }), "TransferFailed");
    assert.equal((await w.vault.read.getAgent([s.vaultId])).spentToday, 0n);
    assert.equal(await w.vault.read.balanceOf([s.vaultId, zeroAddress]), parseEther("1"));
  });
});

describe("agent allowance: who may call, lifecycle", () => {
  it("only the agent: owner, attacker, anyone else get NotAgent; no agent set means NotAgent for all", async () => {
    const { w, s } = await setup();
    for (const who of [w.owner, w.attacker, w.payee1, w.deployer]) {
      await expectError(w.vault.write.agentPay([s.vaultId, A(w.payee1), 1n], { account: who.account }), "NotAgent");
    }
    const bare = await makeAccountVault(w, { salt: keccak256("0x61") }, 1n);
    await expectError(w.vault.write.agentPay([bare.vaultId, A(w.payee1), 1n], { account: w.agent.account }), "NotAgent");
    await expectError(w.vault.write.agentPay([999n, A(w.payee1), 1n], { account: w.agent.account }), "NotAgent");
  });

  it("an agent of vault A cannot pay out of vault B", async () => {
    const { w, s } = await setup();
    const b = await makeAccountVault(w, { salt: keccak256("0x62"), interval: 30n * DAY }, parseEther("5"));
    await expectError(w.vault.write.agentPay([b.vaultId, A(w.payee1), 1n], { account: w.agent.account }), "NotAgent");
    assert.equal(await w.vault.read.balanceOf([b.vaultId, zeroAddress]), parseEther("5"));
    void s;
  });

  it("revokeAgent (PQ-signed) removes the agent with an event; revoke with no agent is a plain check-in", async () => {
    const { w, s } = await setup();
    await ownerDo(s, act.revokeAgent());
    assert.equal((await w.vault.read.getAgent([s.vaultId])).agent, zeroAddress);
    assert.equal((await w.vault.getEvents.AgentRevoked({}, { fromBlock: 0n })).length, 1);
    await expectError(w.vault.write.agentPay([s.vaultId, A(w.payee1), 1n], { account: w.agent.account }), "NotAgent");
    await ownerDo(s, act.revokeAgent()); // no agent: succeeds, no second event
    assert.equal((await w.vault.getEvents.AgentRevoked({}, { fromBlock: 0n })).length, 1);
  });

  it("close() deletes the agent (trigger: see 04)", async () => {
    const { w, s } = await setup();
    await ownerDo(s, act.close(A(w.owner)));
    assert.equal((await w.vault.read.getAgent([s.vaultId])).agent, zeroAddress);
    await expectError(w.vault.write.agentPay([s.vaultId, A(w.payee1), 1n], { account: w.agent.account }), "NotAgent");
  });

  it("setAgent replaces the agent and resets spent counters", async () => {
    const { w, s } = await setup({ perTx: 10n, daily: 10n });
    await pay(w, s.vaultId, A(w.payee1), 10n);
    assert.equal((await w.vault.read.getAgent([s.vaultId])).spentToday, 10n);
    await ownerDo(s, act.setAgent(A(w.attacker), zeroAddress, 10n, 10n, (await now()) + DAY, [A(w.payee3)]));
    const ag = await w.vault.read.getAgent([s.vaultId]);
    assert.equal(ag.spentToday, 0n);
    assert.equal(ag.agent.toLowerCase(), A(w.attacker).toLowerCase());
    assert.deepEqual(ag.payees.map((x) => x.toLowerCase()), [A(w.payee3).toLowerCase()]);
    await expectError(w.vault.write.agentPay([s.vaultId, A(w.payee3), 1n], { account: w.agent.account }), "NotAgent");
    assert.equal((await pay(w, s.vaultId, A(w.payee3), 1n, w.attacker)).paid, true);
  });

  it("DEVICE-mode vault can have an agent too", async () => {
    const w = await fresh();
    const s = await makeDeviceVault(w, { interval: 30n * DAY, grace: 0 }, parseEther("1"));
    await ownerDo(s, act.setAgent(A(w.agent), zeroAddress, 10n, 100n, (await now()) + DAY, [A(w.payee1)]));
    assert.equal((await pay(w, s.vaultId, A(w.payee1), 7n)).paid, true);
  });
});

describe("agent allowance: token mode and setAgent validation", () => {
  it("token agent pays the vault token only", async () => {
    const w = await fresh();
    const tok = await deployToken(w, "AG");
    const s = await makeAccountVault(w, { interval: 30n * DAY, grace: 0, tokens: [tok.address] }, parseEther("1"));
    await depositTokenTo(w, s, tok, w.deployer, 1000n);
    await ownerDo(s, act.setAgent(A(w.agent), tok.address, 100n, 300n, (await now()) + DAY, [A(w.payee1)]));
    assert.equal((await pay(w, s.vaultId, A(w.payee1), 60n)).paid, true);
    assert.equal(await tok.read.balanceOf([A(w.payee1)]), 60n);
    assert.equal(await w.vault.read.balanceOf([s.vaultId, tok.address]), 940n);
    assert.equal(await w.vault.read.balanceOf([s.vaultId, zeroAddress]), parseEther("1")); // native untouched
    assert.equal((await pay(w, s.vaultId, A(w.payee1), 101n)).paid, false);
  });

  it("setAgent validation", async () => {
    const w = await fresh();
    const tok = await deployToken(w, "AG");
    const other = await deployToken(w, "OT");
    const s = await makeAccountVault(w, { interval: 30n * DAY, grace: 0, tokens: [tok.address] }, 1n);
    const t = await now();
    const ok = [A(w.payee1)];
    const set = (agent: Address, token: Address, perTx: bigint, daily: bigint, vu: bigint, payees: Address[]) =>
      ownerDo(s, act.setAgent(agent, token, perTx, daily, vu, payees));
    await expectError(set(zeroAddress, zeroAddress, 1n, 1n, t + 99n, ok), "BadAgent");
    await expectError(set(A(w.owner), zeroAddress, 1n, 1n, t + 99n, ok), "BadAgent"); // owner can never be the agent
    await expectError(set(w.vault.address, zeroAddress, 1n, 1n, t + 99n, ok), "BadAgent");
    await expectError(set(A(w.agent), zeroAddress, 0n, 1n, t + 99n, ok), "BadAgent");
    await expectError(set(A(w.agent), zeroAddress, 2n, 1n, t + 99n, ok), "BadAgent"); // perTx > daily
    await expectError(set(A(w.agent), zeroAddress, 1n, 1n, t, ok), "BadAgent"); // validUntil in the past
    await expectError(set(A(w.agent), other.address, 1n, 1n, t + 99n, ok), "TokenNotAllowed");
    await expectError(set(A(w.agent), zeroAddress, 1n, 1n, t + 99n, []), "BadPayees");
    await expectError(set(A(w.agent), zeroAddress, 1n, 1n, t + 99n, Array.from({ length: 9 }, (_, i) => A(w.wallets[i + 1]))), "BadPayees");
    await expectError(set(A(w.agent), zeroAddress, 1n, 1n, t + 99n, [zeroAddress]), "BadPayees");
    await expectError(set(A(w.agent), zeroAddress, 1n, 1n, t + 99n, [w.vault.address]), "BadPayees");
    await expectError(set(A(w.agent), zeroAddress, 1n, 1n, t + 99n, [A(w.payee1), A(w.payee1)]), "BadPayees");
    await set(A(w.agent), zeroAddress, 1n, 1n, t + 99n + 1000n, Array.from({ length: 8 }, (_, i) => A(w.wallets[i + 1]))); // 8 payees ok
    await set(A(w.agent), tok.address, 1n, 1n, t + 5000n, ok);
    // exact boundary: validUntil == block.timestamp is refused, block.timestamp + 1 is accepted
    {
      const at = (await now()) + 1000n;
      const bad = act.setAgent(A(w.agent), zeroAddress, 1n, 1n, at, ok);
      const good = act.setAgent(A(w.agent), zeroAddress, 1n, 1n, at + 1n, ok);
      // sign first (registering signatures mines blocks), then pin the next block's timestamp
      const aBad = await signAuth(w, s.vaultId, s.key, s.mode, bad.digest, { expiry: at + 100n });
      const aGood = await signAuth(w, s.vaultId, s.key, s.mode, good.digest, { expiry: at + 100n });
      await networkHelpers.time.setNextBlockTimestamp(Number(at));
      await expectError(bad.send(w, s.vaultId, aBad), "BadAgent");
      await networkHelpers.time.setNextBlockTimestamp(Number(at));
      await good.send(w, s.vaultId, aGood);
      assert.equal((await w.vault.read.getAgent([s.vaultId])).validUntil, at + 1n);
    }
  });
});
