/**
 * Every owner action x every way a signature can be wrong, in ACCOUNT and DEVICE key modes.
 * Nothing may change state when a case is rejected, and the proof-of-life clock must not move.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { zeroAddress, type Hex } from "viem";
import { Action, actionDigest } from "../lib/encoding.js";
import {
  KeyMode, accept, act, deployWorld, expectError, makeAccountVault, makeDeviceVault, networkHelpers, now, parseEther,
  pqKey, registerAccount, signAuth, signDigest, warpBy, type OwnerAct, type Scenario, type World, type Auth,
} from "../testkit/harness.js";

// One fixture per file: the precompile mock lives at fixed addresses and setCode does not clear its storage, so two
// different fixtures in one process would leak registered signatures into each other.
const both = async () => {
  const w = await deployWorld();
  const a = await makeAccountVault(w, {}, parseEther("10"));
  const d = await makeDeviceVault(w, {}, parseEther("10"));
  return { a, d };
};
const acc = async () => (await networkHelpers.loadFixture(both)).a;
const dev = async () => (await networkHelpers.loadFixture(both)).d;

function actionsFor(s: Scenario): OwnerAct[] {
  const w = s.w;
  const owner = w.owner.account.address;
  const list: OwnerAct[] = [
    act.checkIn(),
    act.withdraw(zeroAddress, 1n, w.payee1.account.address),
    act.setHeirs([
      { account: w.heir1.account.address, payoutTo: w.heir1.account.address, bps: 6000 },
      { account: w.heir2.account.address, payoutTo: w.heir2.account.address, bps: 4000 },
    ]),
    act.setTiming(7200n, 1, 0n),
    act.setAgent(w.agent.account.address, zeroAddress, 1n, 10n, 4_000_000_000n, [w.payee1.account.address]),
    act.revokeAgent(),
    act.close(owner),
  ];
  if (s.mode === KeyMode.DEVICE) list.push(act.rotate(pqKey("rotated")));
  return list;
}

async function snapshot(s: Scenario) {
  const v = await s.w.vault.read.getVault([s.vaultId]);
  return {
    nonce: v.nonce, last: v.lastCheckin, status: v.status, pk: v.pubkeyHash,
    bal: await s.w.vault.read.balanceOf([s.vaultId, zeroAddress]),
    chain: await s.w.vault.read.getHeirs([s.vaultId]),
  };
}

for (const [label, fixture] of [["ACCOUNT", acc], ["DEVICE", dev]] as const) {
  describe(`owner action authorisation, ${label} mode`, () => {
    const load = fixture;

    /** Run `mutate` to craft a bad auth for each action; assert the error and that nothing moved. */
    async function eachAction(
      s: Scenario,
      mk: (a: OwnerAct) => Promise<Auth>,
      errName: string,
      errArgs?: (auth: Auth, s: Scenario) => readonly unknown[] | undefined,
    ) {
      for (const a of actionsFor(s)) {
        const before = await snapshot(s);
        const auth = await mk(a);
        await expectError(a.send(s.w, s.vaultId, auth), errName, errArgs?.(auth, s)).catch((e) => {
          e.message = `[${a.name}] ${e.message}`;
          throw e;
        });
        assert.deepEqual(await snapshot(s), before, `${a.name}: state must not change on ${errName}`);
      }
    }

    it("happy path for every action: nonce +1, lastCheckin refreshed, CheckedIn emitted (relayer submits)", async () => {
      for (const idx of [0, 1, 2, 3, 4, 5, 6, 7]) {
        const s = await load();
        const a = actionsFor(s)[idx];
        if (!a) continue;
        const v0 = await s.w.vault.read.getVault([s.vaultId]);
        await warpBy(100);
        const auth = await signAuth(s.w, s.vaultId, s.key, s.mode, a.digest);
        await a.send(s.w, s.vaultId, auth);
        const v1 = await s.w.vault.read.getVault([s.vaultId]);
        assert.equal(v1.nonce, v0.nonce + 1n, a.name);
        assert.ok(v1.lastCheckin > v0.lastCheckin, `${a.name} refreshes lastCheckin`);
        const ev = await s.w.vault.getEvents.CheckedIn({ vaultId: s.vaultId }, { fromBlock: 0n });
        assert.equal(ev.at(-1)!.args.action, a.action);
        assert.equal(ev.at(-1)!.args.nonce, 0n);
      }
    });

    it("wrong nonce (too high or too low) is BadNonce(expected, got)", async () => {
      const s = await load();
      await eachAction(s, (a) => signAuth(s.w, s.vaultId, s.key, s.mode, a.digest, { nonce: 1n }), "BadNonce", () => [0n, 1n]);
      // advance the vault nonce, then a stale nonce 0 is rejected
      await s.w.vault.write.checkIn([s.vaultId, await signAuth(s.w, s.vaultId, s.key, s.mode, act.checkIn().digest)]);
      await eachAction(s, (a) => signAuth(s.w, s.vaultId, s.key, s.mode, a.digest, { nonce: 0n }), "BadNonce", () => [1n, 0n]);
    });

    it("expired signature is SignatureExpired", async () => {
      const s = await load();
      const t = await now();
      await eachAction(s, (a) => signAuth(s.w, s.vaultId, s.key, s.mode, a.digest, { expiry: t - 1n }), "SignatureExpired");
    });

    it("expiry is inclusive: block.timestamp == expiry passes", async () => {
      const s = await load();
      const t = (await now()) + 50n;
      const auth = await signAuth(s.w, s.vaultId, s.key, s.mode, act.checkIn().digest, { expiry: t });
      await networkHelpers.time.setNextBlockTimestamp(Number(t));
      await act.checkIn().send(s.w, s.vaultId, auth);
      assert.equal((await s.w.vault.read.getVault([s.vaultId])).lastCheckin, t);
    });

    it("a valid signature by the wrong key is PQSignatureInvalid", async () => {
      const s = await load();
      const wrong = pqKey("wrong");
      await eachAction(
        s,
        async (a) => {
          const au = await signAuth(s.w, s.vaultId, wrong, s.mode, a.digest);
          // keep the correct pubkey in DEVICE mode so only the signature is wrong
          return { ...au, pubkey: s.mode === KeyMode.DEVICE ? s.key.pubHex : "0x" };
        },
        "PQSignatureInvalid",
      );
    });

    it("a signature the precompile does not know (forged / unregistered) is PQSignatureInvalid", async () => {
      const s = await load();
      await eachAction(s, (a) => signAuth(s.w, s.vaultId, s.key, s.mode, a.digest, { register: false }), "PQSignatureInvalid");
    });

    it("ECDSA-only: empty signature is BadSignatureLength(0)", async () => {
      const s = await load();
      await eachAction(
        s,
        async (a) => ({ ...(await signAuth(s.w, s.vaultId, s.key, s.mode, a.digest)), sig: "0x" }),
        "BadSignatureLength",
        () => [0n],
      );
    });

    it("65-byte ECDSA-shaped signature, short (4626) and long (4628) signatures are BadSignatureLength", async () => {
      const s = await load();
      for (const len of [65, 4626, 4628, 4627 * 2]) {
        await eachAction(
          s,
          async (a) => ({ ...(await signAuth(s.w, s.vaultId, s.key, s.mode, a.digest)), sig: ("0x" + "11".repeat(len)) as Hex }),
          "BadSignatureLength",
          () => [BigInt(len)],
        );
      }
    });

    it("right-length garbage signature is PQSignatureInvalid", async () => {
      const s = await load();
      await eachAction(
        s,
        async (a) => ({ ...(await signAuth(s.w, s.vaultId, s.key, s.mode, a.digest)), sig: ("0x" + "ab".repeat(4627)) as Hex }),
        "PQSignatureInvalid",
      );
    });

    it("signature made for another vault (same owner) cannot be replayed here", async () => {
      const s = await load();
      const other = s.mode === KeyMode.ACCOUNT
        ? await makeAccountVault(s.w, { salt: "0x" + "09".repeat(32) as Hex }, 1n)
        : await makeDeviceVault(s.w, { salt: ("0x" + "09".repeat(32)) as Hex }, 1n);
      await eachAction(
        s,
        (a) => signAuth(s.w, s.vaultId, s.key, s.mode, a.digest, { digestVaultId: other.vaultId }),
        "PQSignatureInvalid",
      );
      // and the real owner-signed action for `other` works only on `other`
      const au = await signAuth(s.w, other.vaultId, s.key, s.mode, act.checkIn().digest);
      await expectError(s.w.vault.write.checkIn([s.vaultId, au]), "PQSignatureInvalid");
      await s.w.vault.write.checkIn([other.vaultId, au]);
    });

    it("signature bound to another contract address is rejected", async () => {
      const s = await load();
      const wrong = { ...s.w.domain, vault: s.w.attacker.account.address };
      await eachAction(s, (a) => signAuth(s.w, s.vaultId, s.key, s.mode, a.digest, { domain: wrong }), "PQSignatureInvalid");
    });

    it("signature bound to another chain id is rejected", async () => {
      const s = await load();
      const wrong = { ...s.w.domain, chainId: 9800n };
      await eachAction(s, (a) => signAuth(s.w, s.vaultId, s.key, s.mode, a.digest, { domain: wrong }), "PQSignatureInvalid");
    });

    it("a signature for a different action id cannot be used for this action", async () => {
      const s = await load();
      for (const a of actionsFor(s)) {
        // sign CHECKIN's digest (or REVOKE_AGENT's for checkIn itself, same args hash different action id)
        const other = a.action === Action.CHECKIN ? act.revokeAgent() : act.checkIn();
        const before = await snapshot(s);
        const auth = await signAuth(s.w, s.vaultId, s.key, s.mode, other.digest);
        await expectError(a.send(s.w, s.vaultId, auth), "PQSignatureInvalid");
        assert.deepEqual(await snapshot(s), before);
      }
    });

    it("CHECKIN and REVOKE_AGENT share an args hash but their signatures are not interchangeable", async () => {
      const s = await load();
      const au = await signAuth(s.w, s.vaultId, s.key, s.mode, act.checkIn().digest);
      await expectError(s.w.vault.write.revokeAgent([s.vaultId, au]), "PQSignatureInvalid");
      const au2 = await signAuth(s.w, s.vaultId, s.key, s.mode, act.revokeAgent().digest);
      await expectError(s.w.vault.write.checkIn([s.vaultId, au2]), "PQSignatureInvalid");
    });

    it("replay: a used signature fails with BadNonce", async () => {
      const s = await load();
      for (const idx of [0, 1, 2, 3, 4, 5]) {
        const a = actionsFor(s)[idx];
        const au = await signAuth(s.w, s.vaultId, s.key, s.mode, a.digest);
        await a.send(s.w, s.vaultId, au);
        await expectError(a.send(s.w, s.vaultId, au), "BadNonce");
      }
    });

    it("tampering with an argument after signing fails (relayer cannot redirect funds)", async () => {
      const s = await load();
      const w = s.w;
      const au = await signAuth(w, s.vaultId, s.key, s.mode, act.withdraw(zeroAddress, 5n, w.payee1.account.address).digest);
      await expectError(w.vault.write.withdraw([s.vaultId, zeroAddress, 5n, w.attacker.account.address, au]), "PQSignatureInvalid");
      await expectError(w.vault.write.withdraw([s.vaultId, zeroAddress, 6n, w.payee1.account.address, au]), "PQSignatureInvalid");
      await w.vault.write.withdraw([s.vaultId, zeroAddress, 5n, w.payee1.account.address, au]);
    });

    it("unknown vault is VaultNotFound; a closed vault is WrongStatus", async () => {
      const s = await load();
      const au = await signAuth(s.w, s.vaultId, s.key, s.mode, act.checkIn().digest);
      await expectError(s.w.vault.write.checkIn([999n, au]), "VaultNotFound", [999n]);
      const closeAuth = await signAuth(s.w, s.vaultId, s.key, s.mode, act.close(s.w.owner.account.address).digest);
      await s.w.vault.write.close([s.vaultId, s.w.owner.account.address, closeAuth]);
      const next = await signAuth(s.w, s.vaultId, s.key, s.mode, act.checkIn().digest, { nonce: 1n });
      await expectError(s.w.vault.write.checkIn([s.vaultId, next]), "WrongStatus", [4]);
    });

    it("precompile inactive (empty returndata): every signed action is PrecompileUnavailable", async () => {
      const s = await load();
      const auths = new Map<string, Auth>();
      for (const a of actionsFor(s)) auths.set(a.name, await signAuth(s.w, s.vaultId, s.key, s.mode, a.digest));
      await s.w.a01.write.setInactive([true]);
      if (s.mode === KeyMode.ACCOUNT) await s.w.a02.write.setInactive([true]);
      for (const a of actionsFor(s)) {
        const before = await snapshot(s);
        await expectError(a.send(s.w, s.vaultId, auths.get(a.name)!), "PrecompileUnavailable");
        assert.deepEqual(await snapshot(s), before);
      }
    });

    it("verify precompile answering with empty data fails closed even if key status works", async () => {
      const s = await load();
      const au = await signAuth(s.w, s.vaultId, s.key, s.mode, act.checkIn().digest);
      await s.w.a01.write.setInactive([true]);
      await expectError(s.w.vault.write.checkIn([s.vaultId, au]), "PrecompileUnavailable", ["0x0000000000000000000000000000000000000a01"]);
    });

    it("malformed verify answers: short, long, word != 1", async () => {
      const s = await load();
      const au = await signAuth(s.w, s.vaultId, s.key, s.mode, act.checkIn().digest);
      const word = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as Hex;
      await s.w.a01.write.setRawVerifyReturn(["0x01"]);
      await expectError(s.w.vault.write.checkIn([s.vaultId, au]), "PrecompileUnavailable");
      await s.w.a01.write.setRawVerifyReturn([(word(1) + "00".repeat(32)) as Hex]);
      await expectError(s.w.vault.write.checkIn([s.vaultId, au]), "PrecompileUnavailable");
      await s.w.a01.write.setRawVerifyReturn([word(2)]);
      await expectError(s.w.vault.write.checkIn([s.vaultId, au]), "PQSignatureInvalid");
      await s.w.a01.write.setRawVerifyReturn([word(0)]);
      await expectError(s.w.vault.write.checkIn([s.vaultId, au]), "PQSignatureInvalid");
      // the dirty-bool case: nonzero high bits must not pass either
      await s.w.a01.write.setRawVerifyReturn([("0x01" + "00".repeat(31)) as Hex]);
      await expectError(s.w.vault.write.checkIn([s.vaultId, au]), "PQSignatureInvalid");
      // word == 1 even without any registration is what the mock would never say; the library trusts only that exact word
      await s.w.a01.write.setRawVerifyReturn([word(1)]);
      await s.w.vault.write.checkIn([s.vaultId, au]);
      await s.w.a01.write.setRawVerifyReturn(["0x"]); // back to normal verification
      await expectError(s.w.vault.write.checkIn([s.vaultId, { ...au, nonce: 1n }]), "PQSignatureInvalid");
    });
  });
}

describe("ACCOUNT mode: key registry checks on owner actions", () => {
  const load = acc;

  it("pubkey supplied in ACCOUNT mode is UnexpectedPubkey", async () => {
    const s = await load();
    const au = await signAuth(s.w, s.vaultId, s.key, s.mode, act.checkIn().digest);
    await expectError(s.w.vault.write.checkIn([s.vaultId, { ...au, pubkey: s.key.pubHex }]), "UnexpectedPubkey");
  });

  it("unregistered / wrong algorithm / possession not proven all fail closed", async () => {
    const s = await load();
    const owner = s.w.owner.account.address;
    const au = await signAuth(s.w, s.vaultId, s.key, s.mode, act.checkIn().digest);
    const send = () => s.w.vault.write.checkIn([s.vaultId, au]);
    await registerAccount(s.w, owner, s.key, { registered: false });
    await expectError(send(), "PQKeyNotRegistered", [owner]);
    await registerAccount(s.w, owner, s.key, { alg: 2 });
    await expectError(send(), "PQKeyWrongAlgorithm", [2]);
    await registerAccount(s.w, owner, s.key, { alg: 0 });
    await expectError(send(), "PQKeyWrongAlgorithm", [0]);
    await registerAccount(s.w, owner, s.key, { proven: false });
    await expectError(send(), "PQKeyPossessionNotProven", [owner]);
    await registerAccount(s.w, owner, s.key);
    await send();
  });

  it("registered pubkey of the wrong length is BadPubkeyLength", async () => {
    const s = await load();
    const owner = s.w.owner.account.address;
    const au = await signAuth(s.w, s.vaultId, s.key, s.mode, act.checkIn().digest);
    await s.w.a02.write.setKeyStatus([owner, true, 1, "0x1234", true]);
    await expectError(s.w.vault.write.checkIn([s.vaultId, au]), "BadPubkeyLength", [2n]);
  });

  it("key status precompile: empty, short and malformed answers fail closed", async () => {
    const s = await load();
    const au = await signAuth(s.w, s.vaultId, s.key, s.mode, act.checkIn().digest);
    const send = () => s.w.vault.write.checkIn([s.vaultId, au]);
    await s.w.a02.write.setInactive([true]);
    await expectError(send(), "PrecompileUnavailable", ["0x0000000000000000000000000000000000000a02"]);
    await s.w.a02.write.setInactive([false]);
    await s.w.a02.write.setRawStatusReturn(["0x" + "00".repeat(159) as Hex]);
    await expectError(send(), "PrecompileUnavailable");
    // 200 bytes of nonsense: bool word is not 0/1 -> fail closed
    await s.w.a02.write.setRawStatusReturn(["0x" + "ff".repeat(200) as Hex]);
    await expectError(send(), "PrecompileUnavailable");
  });

  it("the owner key follows the registry live: re-registering a new key moves control", async () => {
    const s = await load();
    const newKey = pqKey("registry-new");
    await registerAccount(s.w, s.w.owner.account.address, newKey);
    const oldAuth = await signAuth(s.w, s.vaultId, s.key, s.mode, act.checkIn().digest);
    await expectError(s.w.vault.write.checkIn([s.vaultId, oldAuth]), "PQSignatureInvalid");
    const newAuth = await signAuth(s.w, s.vaultId, newKey, s.mode, act.checkIn().digest);
    await s.w.vault.write.checkIn([s.vaultId, newAuth]);
  });
});

describe("DEVICE mode: pinned key checks on owner actions", () => {
  const load = dev;

  it("pubkey whose hash is not the pinned hash is PubkeyMismatch", async () => {
    const s = await load();
    const other = pqKey("device-other");
    const au = await signAuth(s.w, s.vaultId, other, s.mode, act.checkIn().digest);
    await expectError(s.w.vault.write.checkIn([s.vaultId, au]), "PubkeyMismatch");
  });

  it("missing or wrong-length pubkey is BadPubkeyLength", async () => {
    const s = await load();
    const au = await signAuth(s.w, s.vaultId, s.key, s.mode, act.checkIn().digest);
    await expectError(s.w.vault.write.checkIn([s.vaultId, { ...au, pubkey: "0x" }]), "BadPubkeyLength", [0n]);
    await expectError(s.w.vault.write.checkIn([s.vaultId, { ...au, pubkey: ("0x" + "00".repeat(2591)) as Hex }]), "BadPubkeyLength", [2591n]);
    await expectError(s.w.vault.write.checkIn([s.vaultId, { ...au, pubkey: ("0x" + "00".repeat(2593)) as Hex }]), "BadPubkeyLength", [2593n]);
  });

  it("the owner address label grants nothing: its registry key does not matter", async () => {
    const s = await load();
    await registerAccount(s.w, s.w.owner.account.address, pqKey("registry-other"));
    const au = await signAuth(s.w, s.vaultId, s.key, s.mode, act.checkIn().digest);
    await s.w.vault.write.checkIn([s.vaultId, au]);
  });
});

void accept; void signDigest; void actionDigest;
