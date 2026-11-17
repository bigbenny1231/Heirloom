import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { concat, keccak256, pad, stringToBytes, toHex, type Hex } from "viem";
import {
  Action, KeyMode, NATIVE, TAG, ZERO_HASH, argsHash, actionDigest, computeVaultId, createDigest, checkInDigest,
  closeDigest, revokeAgentDigest, rotateKeyDigest, rotateKeyPopDigest, setAgentDigest, setHeirsDigest,
  setPayoutDigest, setTimingDigest, withdrawDigest, EMPTY_ARGS_HASH, MAX_INTERVAL,
} from "../lib/encoding.js";
import { deployWorld, defaultHeirs, params, networkHelpers, pqKey } from "../testkit/harness.js";

describe("digest parity: contract vs lib/encoding.ts", () => {
  it("constants match", async () => {
    const w = await networkHelpers.loadFixture(deployWorld);
    assert.equal(await w.vault.read.TAG(), TAG);
    assert.equal(TAG, keccak256(stringToBytes("QDMV1")));
    assert.equal(await w.vault.read.MAX_HEIRS(), 10n);
    assert.equal(await w.vault.read.MAX_TOKENS(), 4n);
    assert.equal(await w.vault.read.MAX_PAYEES(), 8n);
    assert.equal(await w.vault.read.MIN_INTERVAL(), 60n);
    assert.equal(await w.vault.read.MAX_INTERVAL(), MAX_INTERVAL);
    assert.equal(await w.vault.read.MAX_GRACE(), 12);
    assert.equal(await w.vault.read.MAX_BOUNTY_BPS(), 1000n);
    assert.equal(await w.vault.read.NATIVE_PUSH_GAS(), 50_000n);
    assert.equal(await w.vault.read.TOKEN_PUSH_GAS(), 150_000n);
    assert.equal(EMPTY_ARGS_HASH, keccak256("0x"));
  });

  it("computeVaultId equals encoding.ts for both modes and commits to every parameter", async () => {
    const w = await networkHelpers.loadFixture(deployWorld);
    const owner = w.owner.account.address;
    const dev = pqKey("device").hash;
    const p = params(w, { salt: keccak256("0xabcd"), bounty: 5n });
    assert.equal(await w.vault.read.computeVaultId([owner, KeyMode.ACCOUNT, ZERO_HASH, p]), computeVaultId(owner, KeyMode.ACCOUNT, ZERO_HASH, p));
    assert.equal(await w.vault.read.computeVaultId([owner, KeyMode.DEVICE, dev, p]), computeVaultId(owner, KeyMode.DEVICE, dev, p));
    assert.notEqual(computeVaultId(owner, KeyMode.ACCOUNT, ZERO_HASH, p), computeVaultId(owner, KeyMode.DEVICE, dev, p));
    // any change to heirs, timing, bounty, grace, tokens or salt changes the id
    const base = computeVaultId(owner, KeyMode.ACCOUNT, ZERO_HASH, p);
    const variants = [
      { ...p, salt: keccak256("0x01") }, { ...p, interval: 61n }, { ...p, grace: 3 }, { ...p, bounty: 6n },
      { ...p, tokens: [w.payee1.account.address] },
      { ...p, heirs: [{ account: w.attacker.account.address, payoutTo: w.attacker.account.address, bps: 10000 }] },
    ];
    for (const v of variants) {
      assert.notEqual(computeVaultId(owner, KeyMode.ACCOUNT, ZERO_HASH, v), base);
      assert.equal(await w.vault.read.computeVaultId([owner, KeyMode.ACCOUNT, ZERO_HASH, v]), computeVaultId(owner, KeyMode.ACCOUNT, ZERO_HASH, v));
    }
  });

  it("actionDigest equals encoding.ts for every action id", async () => {
    const w = await networkHelpers.loadFixture(deployWorld);
    const id = 123456789n;
    const args = keccak256("0x1234") as Hex;
    for (let a = 0; a <= 11; a++) {
      const onChain = await w.vault.read.actionDigest([id, a, args, 7n, 1_900_000_000n]);
      assert.equal(onChain, actionDigest(w.domain, id, a as Action, args, 7n, 1_900_000_000n), `action ${a}`);
    }
  });

  it("per-action args hashes and digests: the contract-side digest of the exact args equals the TS digest", async () => {
    const w = await networkHelpers.loadFixture(deployWorld);
    const id = 42n;
    const s = { vaultId: id, nonce: 3n, expiry: 2_000_000_000n };
    const heirs = defaultHeirs(w);
    const payees = [w.payee1.account.address, w.payee2.account.address];
    const newHash = pqKey("new").hash;
    const p = params(w, { tokens: [w.payee3.account.address], bounty: 5n });
    const owner = w.owner.account.address;

    const check = async (action: Action, args: Hex, tsDigest: Hex, nonce = s.nonce) => {
      assert.equal(await w.vault.read.actionDigest([id, action, args, nonce, s.expiry]), tsDigest, `digest ${Action[action]}`);
    };

    const c = createDigest(w.domain, owner, KeyMode.DEVICE, newHash, p, s.expiry);
    assert.equal(
      await w.vault.read.actionDigest([c.vaultId, Action.CREATE, argsHash.create(owner, KeyMode.DEVICE, newHash, p), 0n, s.expiry]),
      c.digest,
    );

    await check(Action.CHECKIN, argsHash.checkIn(), checkInDigest(w.domain, s));
    await check(Action.WITHDRAW, argsHash.withdraw(NATIVE, 10n, owner), withdrawDigest(w.domain, s, NATIVE, 10n, owner));
    await check(Action.SET_HEIRS, argsHash.setHeirs(heirs), setHeirsDigest(w.domain, s, heirs));
    await check(Action.SET_TIMING, argsHash.setTiming(3600n, 2, 9n), setTimingDigest(w.domain, s, 3600n, 2, 9n));
    await check(
      Action.SET_AGENT,
      argsHash.setAgent(w.agent.account.address, NATIVE, 1n, 2n, 99n, payees),
      setAgentDigest(w.domain, s, w.agent.account.address, NATIVE, 1n, 2n, 99n, payees),
    );
    await check(Action.REVOKE_AGENT, argsHash.revokeAgent(), revokeAgentDigest(w.domain, s));
    await check(Action.ROTATE_KEY, argsHash.rotateKey(newHash), rotateKeyDigest(w.domain, s, newHash));
    await check(Action.ROTATE_KEY_POP, argsHash.rotateKey(newHash), rotateKeyPopDigest(w.domain, s, newHash));
    await check(Action.CLOSE, argsHash.close(owner), closeDigest(w.domain, s, owner));
    await check(
      Action.SET_PAYOUT,
      argsHash.setPayout(1n, w.heir2.account.address, w.payee1.account.address),
      setPayoutDigest(w.domain, s, 1n, w.heir2.account.address, w.payee1.account.address),
    );
  });

  it("hard-coded vectors (chainId 9800, fixed vault address), also derived by hand from raw 32-byte words", () => {
    const d = { chainId: 9800n, vault: "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const };
    const s = { vaultId: 12345n, nonce: 7n, expiry: 1_900_000_000n };
    const a1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
    const a2 = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
    const a3 = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as const;
    const word = (v: bigint | number | Hex) => pad(typeof v === "string" ? v : toHex(v), { size: 32 });
    // all outer fields are static, so the digest is keccak of eight concatenated words; independent of viem's ABI encoder
    const outer = (action: number, args: Hex) =>
      keccak256(concat([TAG, word(9800n), word(d.vault), word(s.vaultId), word(action), args, word(s.nonce), word(s.expiry)]));

    assert.equal(checkInDigest(d, s), "0x85093c02ae191a92be39610f5c997fe84876fcc10428c71d7e1810d870a81792");
    assert.equal(checkInDigest(d, s), outer(2, keccak256("0x")));

    const wd = withdrawDigest(d, s, NATIVE, 10n ** 18n, a1);
    assert.equal(wd, "0x285e44d8e7581ad2648c573136aaf64470a92dacb87c59b272fc3c2f0c246f19");
    assert.equal(wd, outer(3, keccak256(concat([word(NATIVE), word(10n ** 18n), word(a1)]))));

    const sa = setAgentDigest(d, s, a1, NATIVE, 10n ** 17n, 10n ** 18n, 1_950_000_000n, [a2, a3]);
    assert.equal(sa, "0xf6cd1b0e63a63d582b6d08e4d03f5c2c790755e255b84567dc28b9cb0d55fb4e");
    // abi.encode(address,address,uint256,uint256,uint64,address[]): 6 head words (array offset 0xc0), then length + elements
    const args = keccak256(concat([word(a1), word(NATIVE), word(10n ** 17n), word(10n ** 18n), word(1_950_000_000n), word(0xc0), word(2), word(a2), word(a3)]));
    assert.equal(sa, outer(6, args));

    const p = { salt: ("0x" + "11".repeat(32)) as Hex, interval: 3600n, grace: 2, bounty: 5n, tokens: [] as const, heirs: [{ account: a2, payoutTo: a3, bps: 10000 }] };
    assert.equal(computeVaultId(a1, KeyMode.ACCOUNT, ZERO_HASH, p), 113182453080474202952667475882818431925619832307647836811121127042801422352680n);
    assert.equal(createDigest(d, a1, KeyMode.ACCOUNT, ZERO_HASH, p, 1_900_000_000n).digest, "0xdf3bba948e242d60fe8b86157d64055da50e439514d5b2650e3fe38d405c9f77");
  });
});
