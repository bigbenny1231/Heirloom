import { beforeEach, describe, expect, it } from "vitest";
import { DenyReason, KeyMode, NATIVE, State, Status, ZERO_HASH, pubkeyHash } from "../lib/encoding.ts";
import { pqKeygen } from "../lib/pq.ts";
import { expectOk } from "./client.ts";
import { ACCOUNTS as A, ETH, accountVault, deviceVault, ev, heirs3, names, newWorld, params, salt } from "./testkit.ts";
import type { World } from "./world.ts";

let w: World;
beforeEach(async () => {
  w = await newWorld();
});

describe("create", () => {
  it("ACCOUNT mode via createVaultFor: id, state, native balance", async () => {
    const id = await accountVault(w, 1, 5n * ETH);
    const v = await w.client.getVault(id);
    expect(v.owner.toLowerCase()).toBe(A.owner);
    expect(v.keyMode).toBe(KeyMode.ACCOUNT);
    expect(v.status).toBe(Status.ACTIVE);
    expect(v.pubkeyHash).toBe(ZERO_HASH);
    expect(await w.client.stateOf(id)).toBe(State.ALIVE);
    expect(await w.client.balanceOf(id)).toBe(5n * ETH);
    expect(id).toBe(await w.client.computeVaultId(A.owner, KeyMode.ACCOUNT, ZERO_HASH, params(w, 1)));
  });

  it("ACCOUNT mode via plain createVault (msg.sender is the owner)", async () => {
    const { tx, vaultId } = await w.client.createVault(params(w, 3), { sender: A.owner, value: ETH });
    expectOk(tx);
    expect((await w.client.getVault(vaultId)).owner.toLowerCase()).toBe(A.owner);
  });

  it("DEVICE mode pins keccak(pubkey); PoP signature is the creation proof", async () => {
    const id = await deviceVault(w, 2, 2n * ETH);
    const v = await w.client.getVault(id);
    expect(v.keyMode).toBe(KeyMode.DEVICE);
    expect(v.pubkeyHash).toBe(pubkeyHash(w.keys.device.publicKey));
  });

  it("rejects a DEVICE creation signed by a different key than the one pinned", async () => {
    // sign with device2 but present device's pubkey: the verify must fail
    const { digestToMessage, createDigest } = await import("../lib/encoding.ts");
    void digestToMessage;
    const p = params(w, 9);
    const pk = pubkeyHash(w.keys.device.publicKey);
    const expiry = w.sim.now + 600n;
    const { digest } = createDigest(w.client.domain, A.owner, KeyMode.DEVICE, pk, p, expiry);
    const { pqSign } = await import("../lib/pq.ts");
    const { bytesToHex } = await import("viem");
    const sig = bytesToHex(pqSign(digest, w.keys.device2.secretKey));
    const tx = await w.client.send("createVaultFor", [A.owner, KeyMode.DEVICE, p, expiry, sig, bytesToHex(w.keys.device.publicKey)]);
    expect(tx.ok).toBe(false);
    expect(tx.revert?.name).toBe("PQSignatureInvalid");
  });

  it("duplicate id is refused", async () => {
    await accountVault(w, 1);
    const r = await w.client.createVaultFor({ owner: A.owner, keyMode: KeyMode.ACCOUNT, key: w.keys.owner, params: params(w, 1) });
    expect(r.tx.revert?.name).toBe("VaultExists");
  });
});

describe("deposits, check-in, withdraw", () => {
  it("native and token deposits are open to anyone and tracked per vault", async () => {
    const id = await accountVault(w, 1, ETH);
    expectOk(await w.client.depositNative(id, 2n * ETH, A.attacker));
    await w.tokenApprove(A.owner, w.vault, 500n * ETH);
    const d = expectOk(await w.client.depositToken(id, w.token, 500n * ETH, A.owner));
    expect(names(d)).toContain("Deposited");
    expect(await w.client.balanceOf(id)).toBe(3n * ETH);
    expect(await w.client.balanceOf(id, w.token)).toBe(500n * ETH);
    expect(await w.tokenBalance(w.vault)).toBe(500n * ETH);
  });

  it("a non-allowed token is refused", async () => {
    const id = await accountVault(w, 1, ETH, { tokens: [] });
    await w.tokenApprove(A.owner, w.vault, 1n);
    const tx = await w.client.depositToken(id, w.token, 1n, A.owner);
    expect(tx.revert?.name).toBe("TokenNotAllowed");
  });

  it("checkIn (ACCOUNT) bumps nonce and lastCheckin, relayed by anyone", async () => {
    const id = await accountVault(w, 1);
    w.sim.advanceTime(1000);
    const tx = expectOk(await w.client.checkIn(id, w.keys.owner, { sender: A.relayer }));
    expect(tx.from).toBe(A.relayer);
    expect(ev(tx, "CheckedIn")).toBeTruthy();
    const v = await w.client.getVault(id);
    expect(v.nonce).toBe(1n);
    expect(v.lastCheckin).toBe(tx.timestamp);
  });

  it("withdraw native and token with a PQ signature (ACCOUNT and DEVICE)", async () => {
    for (const mode of ["account", "device"] as const) {
      const id = mode === "account" ? await accountVault(w, 11, 4n * ETH) : await deviceVault(w, 12, 4n * ETH);
      const key = mode === "account" ? w.keys.owner : w.keys.device;
      await w.tokenApprove(A.owner, w.vault, 100n * ETH);
      expectOk(await w.client.depositToken(id, w.token, 100n * ETH, A.owner));
      const before = await w.sim.balanceOf(A.payee);
      const tx = expectOk(await w.client.withdraw(id, key, NATIVE, ETH, A.payee));
      expect(ev(tx, "Withdrawn")).toBeTruthy();
      expect((await w.sim.balanceOf(A.payee)) - before).toBe(ETH);
      expectOk(await w.client.withdraw(id, key, w.token, 40n * ETH, A.payee));
      expect(await w.client.balanceOf(id, w.token)).toBe(60n * ETH);
      expect((await w.client.getVault(id)).nonce).toBe(2n);
    }
  });

  it("withdraw more than the balance reverts InsufficientBalance", async () => {
    const id = await accountVault(w, 1, ETH);
    const tx = await w.client.withdraw(id, w.keys.owner, NATIVE, 2n * ETH, A.payee);
    expect(tx.revert?.name).toBe("InsufficientBalance");
  });

  it("setTiming and setHeirs apply and keep the vault alive", async () => {
    const id = await accountVault(w, 1);
    expectOk(await w.client.setTiming(id, w.keys.owner, 7200n, 2, 0n));
    const v = await w.client.getVault(id);
    expect(v.interval).toBe(7200n);
    expect(v.grace).toBe(2);
    const two = [
      { account: A.heir1, payoutTo: A.heirPayout1, bps: 6000 },
      { account: A.heir2, payoutTo: A.heirPayout2, bps: 4000 },
    ];
    expectOk(await w.client.setHeirs(id, w.keys.owner, two));
    expect((await w.client.getHeirs(id)).length).toBe(2);
  });

  it("close withdraws everything and ends the vault", async () => {
    const id = await accountVault(w, 1, 3n * ETH);
    await w.tokenApprove(A.owner, w.vault, 10n * ETH);
    expectOk(await w.client.depositToken(id, w.token, 10n * ETH, A.owner));
    const before = await w.sim.balanceOf(A.payee);
    expectOk(await w.client.close(id, w.keys.owner, A.payee));
    expect((await w.sim.balanceOf(A.payee)) - before).toBe(3n * ETH);
    expect(await w.tokenBalance(A.payee)).toBe(10n * ETH);
    expect(await w.client.stateOf(id)).toBe(State.CLOSED);
  });
});

describe("agent", () => {
  it("pays within limits, denies the rest with on-chain events, resets daily", async () => {
    const id = await accountVault(w, 1, 5n * ETH);
    const until = w.sim.now + 30n * 86400n;
    expectOk(
      await w.client.setAgent(id, w.keys.owner, {
        agent: A.agent,
        perTxLimit: ETH / 2n,
        dailyLimit: ETH,
        validUntil: until,
        payees: [A.payee],
      }),
    );
    const ok1 = expectOk(await w.client.agentPay(id, A.payee, ETH / 2n, A.agent));
    expect(ev(ok1, "AgentPaid")).toBeTruthy();
    expect(await w.sim.balanceOf(A.payee)).toBeGreaterThan(1000n * ETH);

    const denied = async (to: `0x${string}`, amt: bigint) => {
      const tx = expectOk(await w.client.agentPay(id, to, amt, A.agent));
      const e = ev(tx, "AgentPayDenied");
      expect(e).toBeTruthy();
      return Number(e!.args.reason);
    };
    expect(await denied(A.attacker, 1n)).toBe(DenyReason.PAYEE_NOT_ALLOWED);
    expect(await denied(A.payee, 0n)).toBe(DenyReason.ZERO_AMOUNT);
    expect(await denied(A.payee, ETH)).toBe(DenyReason.OVER_PER_TX);
    expectOk(await w.client.agentPay(id, A.payee, ETH / 2n, A.agent)); // daily now 1 ETH
    expect(await denied(A.payee, 1n)).toBe(DenyReason.OVER_DAILY);
    // next UTC day
    w.sim.advanceTime(86400);
    expectOk(await w.client.checkIn(id, w.keys.owner)); // the vault must be ALIVE again for the agent to pay
    expect(ev(expectOk(await w.client.agentPay(id, A.payee, ETH / 2n, A.agent)), "AgentPaid")).toBeTruthy();
    // non-agent caller reverts
    const bad = await w.client.agentPay(id, A.payee, 1n, A.attacker);
    expect(bad.revert?.name).toBe("NotAgent");
  });

  it("is refused once the vault is not ALIVE and revoked on trigger", async () => {
    const id = await accountVault(w, 1, 5n * ETH, { interval: 600n, grace: 1 });
    expectOk(
      await w.client.setAgent(id, w.keys.owner, {
        agent: A.agent,
        perTxLimit: ETH,
        dailyLimit: 2n * ETH,
        validUntil: w.sim.now + 86400n * 30n,
        payees: [A.payee],
      }),
    );
    w.sim.advanceTime(700); // WARNING
    const tx = expectOk(await w.client.agentPay(id, A.payee, 1n, A.agent));
    expect(Number(ev(tx, "AgentPayDenied")!.args.reason)).toBe(DenyReason.NOT_ALIVE);
    w.sim.advanceTime(700); // OVERDUE
    expectOk(await w.client.trigger(id, A.keeper));
    const after = await w.client.agentPay(id, A.payee, 1n, A.agent);
    expect(after.revert?.name).toBe("NotAgent");
  });

  it("revokeAgent removes the agent", async () => {
    const id = await accountVault(w, 1, 5n * ETH);
    expectOk(
      await w.client.setAgent(id, w.keys.owner, { agent: A.agent, perTxLimit: ETH, dailyLimit: ETH, validUntil: w.sim.now + 99999n, payees: [A.payee] }),
    );
    expectOk(await w.client.revokeAgent(id, w.keys.owner));
    expect((await w.client.agentPay(id, A.payee, 1n, A.agent)).revert?.name).toBe("NotAgent");
  });
});

describe("inheritance: overdue, trigger, settle, claim", () => {
  it("walks ALIVE -> WARNING -> OVERDUE with time travel; early trigger/settle revert", async () => {
    const id = await accountVault(w, 1, 10n * ETH, { interval: 3600n, grace: 1 });
    expect(await w.client.stateOf(id)).toBe(State.ALIVE);
    expect((await w.client.trigger(id, A.keeper)).revert?.name).toBe("NotOverdue");
    expect((await w.client.settle(id, A.keeper)).revert?.name).toBe("WrongStatus");
    w.sim.advanceTime(3700);
    expect(await w.client.stateOf(id)).toBe(State.WARNING);
    expect((await w.client.trigger(id, A.keeper)).revert?.name).toBe("NotOverdue");
    w.sim.advanceTime(3700);
    expect(await w.client.stateOf(id)).toBe(State.OVERDUE);
    // owner returns while overdue but before anyone triggered: alive again
    expectOk(await w.client.checkIn(id, w.keys.owner));
    expect(await w.client.stateOf(id)).toBe(State.ALIVE);
  });

  it("full run: trigger pays bounty, settle splits native + token by bps, dust to the last heir", async () => {
    const id = await accountVault(w, 1, 10n * ETH, { interval: 600n, grace: 0, bounty: ETH });
    await w.tokenApprove(A.owner, w.vault, 1000n * ETH + 1n);
    expectOk(await w.client.depositToken(id, w.token, 1000n * ETH + 1n, A.owner));
    w.sim.advanceTime(700);
    const keeperBefore = await w.sim.balanceOf(A.keeper);
    const trig = expectOk(await w.client.trigger(id, A.keeper));
    const bounty = ETH; // 10% of 10 ETH = 1 ETH, bounty = 1 ETH
    expect(Number(ev(trig, "Triggered")!.args.bountyPaid)).toBe(Number(bounty));
    expect((await w.sim.balanceOf(A.keeper)) - keeperBefore).toBe(bounty);
    expect(await w.client.stateOf(id)).toBe(State.TRIGGERED);
    // owner is locked out after trigger
    expect((await w.client.checkIn(id, w.keys.owner)).revert?.name).toBe("WrongStatus");

    const p1 = await w.sim.balanceOf(A.heirPayout1);
    const p2 = await w.sim.balanceOf(A.heirPayout2);
    const p3 = await w.sim.balanceOf(A.heirPayout3);
    const st = expectOk(await w.client.settle(id, A.keeper));
    expect(names(st).filter((n) => n === "HeirPaid").length).toBe(6); // 3 heirs x (native + token)
    const total = 9n * ETH;
    expect((await w.sim.balanceOf(A.heirPayout1)) - p1).toBe((total * 5000n) / 10000n);
    expect((await w.sim.balanceOf(A.heirPayout2)) - p2).toBe((total * 3000n) / 10000n);
    expect((await w.sim.balanceOf(A.heirPayout3)) - p3).toBe((total * 2000n) / 10000n);
    const tk = 1000n * ETH + 1n;
    expect(await w.tokenBalance(A.heirPayout1)).toBe((tk * 5000n) / 10000n);
    expect(await w.tokenBalance(A.heirPayout3)).toBe(tk - (tk * 5000n) / 10000n - (tk * 3000n) / 10000n); // dust to last
    expect(await w.client.balanceOf(id)).toBe(0n);
    expect(await w.client.stateOf(id)).toBe(State.SETTLED);
    expect(await w.sim.balanceOf(w.vault)).toBe(0n);
  });

  it("setPayout by the heir's own PQ key; replay and wrong key are rejected; claim goes to the new payout", async () => {
    const id = await accountVault(w, 1, 4n * ETH, { interval: 600n, grace: 0, bounty: 0n });
    const newPayout = "0x0000000000000000000000000000000000000c99" as const;
    const tx = expectOk(await w.client.setPayout(id, 0n, newPayout, w.keys.heir1));
    expect(ev(tx, "PayoutSet")).toBeTruthy();
    // replay of the same nonce
    expect((await w.client.setPayout(id, 0n, newPayout, w.keys.heir1, { nonce: 0n })).revert?.name).toBe("BadNonce");
    // another heir's key cannot change heir 0
    const bad = await w.client.setPayout(id, 0n, A.attacker, w.keys.heir2);
    expect(bad.revert?.name).toBe("PQSignatureInvalid");
    w.sim.advanceTime(700);
    expectOk(await w.client.trigger(id, A.keeper));
    expectOk(await w.client.settle(id, A.keeper));
    expect(await w.sim.balanceOf(newPayout)).toBe(2n * ETH); // 50% of 4 ETH
  });

  it("claim: nothing to claim when every push succeeded", async () => {
    const id = await accountVault(w, 1, 2n * ETH, { interval: 600n, grace: 0, bounty: 0n });
    w.sim.advanceTime(700);
    expectOk(await w.client.trigger(id));
    expectOk(await w.client.settle(id));
    expect((await w.client.claim(id, 0n)).revert?.name).toBe("NothingToClaim");
  });
});

describe("key rotation (DEVICE)", () => {
  it("rotates with a PoP by the new key; old key is rejected afterwards, new key works", async () => {
    const id = await deviceVault(w, 2, 3n * ETH);
    const rot = expectOk(await w.client.rotateKey(id, w.keys.device, w.keys.device2));
    expect(ev(rot, "KeyRotated")).toBeTruthy();
    expect((await w.client.getVault(id)).pubkeyHash).toBe(pubkeyHash(w.keys.device2.publicKey));
    const oldTry = await w.client.checkIn(id, w.keys.device);
    expect(oldTry.ok).toBe(false);
    expect(oldTry.revert?.name).toBe("PubkeyMismatch");
    expectOk(await w.client.checkIn(id, w.keys.device2));
  });

  it("rotation without a valid PoP from the new key is rejected", async () => {
    const id = await deviceVault(w, 2);
    const stranger = pqKeygen(new Uint8Array(32).fill(77));
    const { rotateKeyDigest, rotateKeyPopDigest } = await import("../lib/encoding.ts");
    const { pqSign } = await import("../lib/pq.ts");
    const { bytesToHex } = await import("viem");
    const newHash = pubkeyHash(w.keys.device2.publicKey);
    const s = { vaultId: id, nonce: 0n, expiry: w.sim.now + 600n };
    const authSig = bytesToHex(pqSign(rotateKeyDigest(w.client.domain, s, newHash), w.keys.device.secretKey));
    // PoP signed by someone who does not hold device2
    const popSig = bytesToHex(pqSign(rotateKeyPopDigest(w.client.domain, s, newHash), stranger.secretKey));
    const tx = await w.client.send("rotateKey", [
      id,
      bytesToHex(w.keys.device2.publicKey),
      popSig,
      { nonce: 0n, expiry: s.expiry, sig: authSig, pubkey: bytesToHex(w.keys.device.publicKey) },
    ]);
    expect(tx.revert?.name).toBe("PQSignatureInvalid");
  });

  it("ACCOUNT vaults cannot rotate", async () => {
    const id = await accountVault(w, 1);
    const tx = await w.client.rotateKey(id, w.keys.owner, w.keys.device2);
    expect(tx.revert?.name).toBe("WrongKeyMode");
  });
});

describe("signature hygiene", () => {
  it("wrong nonce, expired, wrong key all revert and change nothing", async () => {
    const id = await accountVault(w, 1);
    expect((await w.client.checkIn(id, w.keys.owner, { nonce: 5n })).revert?.name).toBe("BadNonce");
    expect((await w.client.checkIn(id, w.keys.owner, { expiry: w.sim.now - 1n })).revert?.name).toBe("SignatureExpired");
    expect((await w.client.checkIn(id, w.keys.heir1)).revert?.name).toBe("PQSignatureInvalid");
    expect((await w.client.getVault(id)).nonce).toBe(0n);
  });

  it("a signature for vault A cannot be used on vault B", async () => {
    const a = await accountVault(w, 1);
    const b = await accountVault(w, 2);
    const { checkInDigest } = await import("../lib/encoding.ts");
    const auth = await w.client.buildAuth(a, w.keys.owner, (s) => checkInDigest(w.client.domain, s));
    const tx = await w.client.send("checkIn", [b, auth]);
    expect(tx.revert?.name).toBe("PQSignatureInvalid");
  });
});

describe("fail closed when the precompiles are inactive", () => {
  it("every signed path reverts PrecompileUnavailable; funds can only leave via trigger/settle", async () => {
    const id = await accountVault(w, 1, 3n * ETH, { interval: 600n, grace: 0, bounty: 0n });
    const signedAttempt = await w.client.buildAuth(id, w.keys.owner, () => ("0x" + "11".repeat(32)) as `0x${string}`);
    w.sim.setPqcActive(false);
    // real signatures, but nothing can verify them
    for (const tx of [
      await w.client.checkIn(id, w.keys.owner),
      await w.client.withdraw(id, w.keys.owner, NATIVE, 1n, A.payee),
      await w.client.close(id, w.keys.owner, A.payee),
      await w.client.setHeirs(id, w.keys.owner, heirs3()),
    ]) {
      expect(tx.ok).toBe(false);
      expect(tx.revert?.name).toBe("PrecompileUnavailable");
    }
    void signedAttempt;
    const c = await w.client.createVault(params(w, 99), { sender: A.owner, value: ETH });
    expect(c.tx.revert?.name).toBe("PrecompileUnavailable");
    // the heirs are still protected: overdue -> trigger -> settle works with no precompile
    w.sim.advanceTime(700);
    expectOk(await w.client.trigger(id, A.keeper));
    expectOk(await w.client.settle(id, A.keeper));
    expect(await w.sim.balanceOf(w.vault)).toBe(0n);
  });
});
