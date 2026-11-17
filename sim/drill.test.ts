import { beforeEach, describe, expect, it } from "vitest";
import { checkInDigest, withdrawDigest, NATIVE } from "../lib/encoding.ts";
import { runDrill, type ObservedAction } from "./drill.ts";
import { expectOk } from "./client.ts";
import { ACCOUNTS as A, ETH, accountVault, deviceVault, newWorld } from "./testkit.ts";
import type { World } from "./world.ts";
import { bytesToHex } from "viem";

let w: World;
beforeEach(async () => {
  w = await newWorld();
});

/** A vault with history: signed check-ins and a withdrawal the attacker could have scraped from calldata. */
async function seasoned(mode: "account" | "device") {
  const id = mode === "account" ? await accountVault(w, 1, 10n * ETH) : await deviceVault(w, 2, 10n * ETH);
  const key = mode === "account" ? w.keys.owner : w.keys.device;
  await w.tokenApprove(A.owner, w.vault, 100n * ETH);
  expectOk(await w.client.depositToken(id, w.token, 100n * ETH, A.owner));
  const observed: ObservedAction[] = [];

  const a1 = await w.client.buildAuth(id, key, (s) => checkInDigest(w.client.domain, s));
  expectOk(await w.client.send("checkIn", [id, a1]));
  observed.push({ fn: "checkIn", args: [id, a1] });

  const a2 = await w.client.buildAuth(id, key, (s) => withdrawDigest(w.client.domain, s, NATIVE, ETH, A.payee));
  expectOk(await w.client.send("withdraw", [id, NATIVE, ETH, A.payee, a2]));
  observed.push({ fn: "withdraw", args: [id, NATIVE, ETH, A.payee, a2] });

  // a signed-but-never-submitted check-in that has since expired (leaked in a mempool, say)
  const a3 = await w.client.buildAuth(id, key, (s) => checkInDigest(w.client.domain, s), { ttl: 30n });
  observed.push({ fn: "checkIn", args: [id, a3] });
  w.sim.advanceTime(60);
  return { id, observed };
}

describe("Q-Day drill bot", () => {
  for (const mode of ["account", "device"] as const) {
    it(`moves zero value and mutates nothing against a ${mode.toUpperCase()} vault`, async () => {
      const { id, observed } = await seasoned(mode);
      const other = await accountVault(w, 50, ETH); // a second vault for cross-vault reuse
      const otherAuth = await w.client.buildAuth(other, w.keys.owner, (s) => checkInDigest(w.client.domain, s));
      observed.push({ fn: "checkIn", args: [other, otherAuth] });

      const nativeBefore = await w.sim.balanceOf(w.vault);
      const tokenBefore = await w.tokenBalance(w.vault);
      const report = await runDrill({
        sim: w.sim,
        client: w.client,
        vaultId: id,
        owner: A.owner,
        attacker: A.attacker,
        observed,
        ownerPubkey: mode === "device" ? bytesToHex(w.keys.device.publicKey) : undefined,
      });

      expect(report.attempted).toBeGreaterThanOrEqual(35);
      expect(report.skipped).toEqual([]);
      const executed = report.attacks.filter((a) => a.outcome === "executed").map((a) => `${a.id}: ${a.title}`);
      expect(executed).toEqual([]);
      expect(report.rejected).toBe(report.attempted);
      expect(report.totalMovedNative).toBe(0n);
      expect(Object.values(report.totalMovedTokens).every((n) => n === 0n)).toBe(true);
      expect(report.vaultMutated).toBe(false);
      expect(report.zeroValueMoved).toBe(true);
      // the contract still holds exactly what it held
      expect(await w.sim.balanceOf(w.vault)).toBe(nativeBefore);
      expect(await w.tokenBalance(w.vault)).toBe(tokenBefore);
      expect(await w.sim.balanceOf(A.attacker)).toBe(1_000n * ETH);

      // every owner action was covered by every kind of forged auth
      const cats = new Set(report.attacks.map((a) => a.category));
      for (const c of ["no-signature", "garbage-signature", "wrong-key", "expired", "replay", "cross-vault", "stall", "agent", "erc20", "early", "direct-send", "heir"]) {
        expect(cats.has(c as never), c).toBe(true);
      }
      // signature checks, not luck: the garbage / wrong-key attacks hit the PQ verifier or key check
      const sigRejects = report.attacks.filter((a) => a.category === "wrong-key" || a.category === "garbage-signature");
      const names = new Set(sigRejects.map((a) => a.revertName));
      expect([...names].every((n) => ["PQSignatureInvalid", "PubkeyMismatch", "WrongKeyMode", "WrongStatus"].includes(n!))).toBe(true);
    });
  }

  it("the vault still works for its real owner right after the drill", async () => {
    const { id } = await seasoned("account");
    await runDrill({ sim: w.sim, client: w.client, vaultId: id, owner: A.owner, attacker: A.attacker });
    expectOk(await w.client.checkIn(id, w.keys.owner));
    expectOk(await w.client.withdraw(id, w.keys.owner, NATIVE, ETH, A.payee));
  });

  it("drills a vault that is already OVERDUE/TRIGGERED without moving anything beyond the legit settlement path", async () => {
    const id = await accountVault(w, 7, 4n * ETH, { interval: 600n, grace: 0, bounty: 0n });
    w.sim.advanceTime(700);
    const report = await runDrill({ sim: w.sim, client: w.client, vaultId: id, owner: A.owner, attacker: A.attacker });
    // on an overdue vault trigger/settle are the legitimate inheritance path, so the drill skips them
    expect(report.skipped.length).toBeGreaterThan(0);
    expect(report.executed).toBe(0);
    expect(report.totalMovedNative).toBe(0n);
    expect(report.zeroValueMoved).toBe(true);
    // ...and the heirs are still protected: someone else can still trigger and settle
    expectOk(await w.client.trigger(id, A.keeper));
    expectOk(await w.client.settle(id, A.keeper));
    expect(await w.sim.balanceOf(A.heirPayout1)).toBeGreaterThan(1_000n * ETH);
  });

  for (const mode of ["account", "device"] as const) {
    it(`negative control (${mode}): with a deliberately broken verifier the same drill DOES move value`, async () => {
      const { id } = await seasoned(mode);
      w.sim.setUnsafeAcceptAll(true);
      const report = await runDrill({
        sim: w.sim,
        client: w.client,
        vaultId: id,
        owner: A.owner,
        attacker: A.attacker,
        ownerPubkey: mode === "device" ? bytesToHex(w.keys.device.publicKey) : undefined,
      });
      // the nonce no longer masks anything: attacks are independent and several really succeed
      expect(report.executed).toBeGreaterThan(3);
      expect(report.totalMovedNative > 0n).toBe(true);
      expect(Object.values(report.totalMovedTokens).some((n) => n > 0n)).toBe(true);
      expect(report.attacks.filter((a) => a.revertName === "BadNonce").length).toBe(0);
    });
  }

  it("report metadata: scope, distinct paths, verifier reach, blockedBy", async () => {
    const { id, observed } = await seasoned("account");
    const r = await runDrill({ sim: w.sim, client: w.client, vaultId: id, owner: A.owner, attacker: A.attacker, observed });
    expect(r.scope).toMatch(/not simulated here/);
    expect(r.distinctPaths).toBeGreaterThan(20);
    expect(r.reachedVerifier).toBeGreaterThan(10);
    expect(r.attacks.filter((a) => a.fn === "transferFrom").every((a) => a.blockedBy === "token")).toBe(true);
    const send = r.attacks.find((a) => a.fn === "(send)")!;
    expect(send.revertReason).toBe("refused (no receive function)");
    const tokenW = r.attacks.find((a) => a.id === "withdraw:token/none")!;
    expect(tokenW).toBeTruthy();
    expect(r.attacks.some((a) => a.category === "expired")).toBe(true);
    // the pristine-state rollback leaves the world untouched
    expect(await w.client.balanceOf(id)).toBe(9n * ETH);
  });
});
