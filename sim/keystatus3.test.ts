import { beforeEach, describe, expect, it } from "vitest";
import { NATIVE, State, checkInDigest, withdrawDigest } from "../lib/encoding.ts";
import { runDrill, type ObservedAction } from "./drill.ts";
import { expectOk } from "./client.ts";
import { ACCOUNTS as A, ETH, accountVault, newWorld, params } from "./testkit.ts";
import type { World } from "./world.ts";

// Official @qorechain/evm ABI: pqcKeyStatus -> (bool registered, uint8 algorithmId, bytes pubkey), no possessionProven.
let w: World;
beforeEach(async () => {
  w = await newWorld({ keyStatusShape: 3 });
});

describe("pqcKeyStatus returns the 3-value shape", () => {
  it("sim reports shape 3", () => {
    expect(w.sim.pqc.keyStatusShape).toBe(3);
  });

  it("core ACCOUNT flow works: create (signed), check in, withdraw, agent, trigger, settle, setPayout", async () => {
    const id = await accountVault(w, 1, 6n * ETH, { interval: 600n, grace: 0, bounty: 0n });
    expectOk(await w.client.checkIn(id, w.keys.owner));
    const before = await w.sim.balanceOf(A.payee);
    expectOk(await w.client.withdraw(id, w.keys.owner, NATIVE, ETH, A.payee));
    expect((await w.sim.balanceOf(A.payee)) - before).toBe(ETH);
    expectOk(
      await w.client.setAgent(id, w.keys.owner, { agent: A.agent, perTxLimit: ETH, dailyLimit: ETH, validUntil: w.sim.now + 99999n, payees: [A.payee] }),
    );
    expectOk(await w.client.agentPay(id, A.payee, 1n, A.agent));
    const np = "0x0000000000000000000000000000000000000c99" as const;
    expectOk(await w.client.setPayout(id, 0n, np, w.keys.heir1));
    w.sim.advanceTime(700);
    expectOk(await w.client.trigger(id, A.keeper));
    expectOk(await w.client.settle(id, A.keeper));
    expect(await w.client.stateOf(id)).toBe(State.SETTLED);
    expect(await w.sim.balanceOf(np)).toBeGreaterThan(0n);
  });

  it("plain createVault (no signature) is refused under shape 3 because possession cannot be shown", async () => {
    const { tx } = await w.client.createVault(params(w, 8), { sender: A.owner, value: ETH });
    expect(tx.ok).toBe(false);
    expect(tx.revert?.name).toBe("PQKeyPossessionNotProven");
  });

  it("a wrong key is still rejected by the verifier", async () => {
    const id = await accountVault(w, 1);
    expect((await w.client.checkIn(id, w.keys.heir1)).revert?.name).toBe("PQSignatureInvalid");
  });

  it("an unregistered owner is refused", async () => {
    w.sim.unregisterAccountKey(A.owner);
    const r = await w.client.createVaultFor({ owner: A.owner, keyMode: 0, key: w.keys.owner, params: params(w, 5) });
    expect(r.tx.ok).toBe(false);
  });

  it("the Q-Day drill moves zero value under the 3-value shape", async () => {
    const id = await accountVault(w, 1, 10n * ETH);
    await w.tokenApprove(A.owner, w.vault, 50n * ETH);
    expectOk(await w.client.depositToken(id, w.token, 50n * ETH, A.owner));
    const a1 = await w.client.buildAuth(id, w.keys.owner, (s) => checkInDigest(w.client.domain, s));
    expectOk(await w.client.send("checkIn", [id, a1]));
    const a2 = await w.client.buildAuth(id, w.keys.owner, (s) => withdrawDigest(w.client.domain, s, NATIVE, ETH, A.payee));
    expectOk(await w.client.send("withdraw", [id, NATIVE, ETH, A.payee, a2]));
    const observed: ObservedAction[] = [
      { fn: "checkIn", args: [id, a1] },
      { fn: "withdraw", args: [id, NATIVE, ETH, A.payee, a2] },
    ];
    const r = await runDrill({ sim: w.sim, client: w.client, vaultId: id, owner: A.owner, attacker: A.attacker, observed });
    expect(r.executed).toBe(0);
    expect(r.zeroValueMoved).toBe(true);
    expect(r.reachedVerifier).toBeGreaterThan(10);
  });

  it("negative control under shape 3: broken verifier lets the drill through", async () => {
    const id = await accountVault(w, 1, 10n * ETH);
    w.sim.setUnsafeAcceptAll(true);
    const r = await runDrill({ sim: w.sim, client: w.client, vaultId: id, owner: A.owner, attacker: A.attacker });
    expect(r.totalMovedNative > 0n).toBe(true);
  });

  it("setKeyStatusShape switches at runtime", async () => {
    w.sim.setKeyStatusShape(4);
    const id = await accountVault(w, 1);
    expectOk(await w.client.checkIn(id, w.keys.owner));
  });
});
