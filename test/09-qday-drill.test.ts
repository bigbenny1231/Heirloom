/**
 * Q-Day drill replay. The bot holds ONLY the owner account's classical (ECDSA) key. It can send any transaction
 * from that account but cannot produce an ML-DSA-87 signature of the owner. It tries every drain path it can think
 * of against a funded vault. Value in the vault must not move, ever.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, keccak256, parseEther, zeroAddress, type Address, type Hex } from "viem";
import {
  Action, KeyMode, NATIVE, ZERO_HASH, checkInDigest, closeDigest, setAgentDigest, setHeirsDigest, setTimingDigest,
  withdrawDigest, setPayoutDigest,
} from "../lib/encoding.js";
import {
  E18, accept, act, balance, deployToken, deployWorld, depositTokenTo, makeAccountVaultFor, networkHelpers, now,
  publicClient, pqKey, registerAccount, revertInfo, registerHeirs, signAuth, signDigest, testClient, viem, type World,
} from "../testkit/harness.js";

const A = (a: { account: { address: Address } }) => a.account.address;
const DAY = 86400n;

async function drillWorld() {
  const w = await deployWorld();
  const t1 = await deployToken(w, "fUSD");
  const t2 = await deployToken(w, "fXYZ");
  await registerHeirs(w);
  // setup rule 2: interval >= 7 days, bounty 0, no agent; created by a relayer so the owner account sent no tx
  const s = await makeAccountVaultFor(
    w,
    { interval: 8n * DAY, grace: 1, bounty: 0n, tokens: [t1.address, t2.address] },
    parseEther("100"),
  );
  await depositTokenTo(w, s, t1, w.deployer, 5_000n * E18);
  await depositTokenTo(w, s, t2, w.deployer, 123_456n);
  // the drill account is left with fee dust only (setup rule 5)
  return { w, s, t1, t2 };
}

const garbage = (n: number, seed = 1): Hex => {
  let x = seed;
  let out = "0x";
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out += (x & 0xff).toString(16).padStart(2, "0");
  }
  return out as Hex;
};

describe("Q-Day drill: bot with the owner's ECDSA key only", () => {
  it("every drain path fails; the vault's value does not move", async () => {
    const { w, s, t1, t2 } = await networkHelpers.loadFixture(drillWorld);
    const bot = w.owner; // the drill account's classical key
    const botPQ = pqKey("bot-own-pq"); // the bot may have its own ML-DSA key; it is not the owner's
    const botAddr = A(bot);
    // The bot may register its own ML-DSA key for a DIFFERENT account it controls. It cannot touch the drill
    // account's registry entry: that needs the hybrid signature (see the trust-boundary test below).
    await registerAccount(w, A(w.attacker), botPQ);

    const holdings = async () => ({
      native: await balance(w.vault.address),
      t1: await t1.read.balanceOf([w.vault.address]),
      t2: await t2.read.balanceOf([w.vault.address]),
      vNative: await w.vault.read.balanceOf([s.vaultId, zeroAddress]),
      vT1: await w.vault.read.balanceOf([s.vaultId, t1.address]),
      vT2: await w.vault.read.balanceOf([s.vaultId, t2.address]),
      vault: await w.vault.read.getVault([s.vaultId]),
      heirs: await w.vault.read.getHeirs([s.vaultId]),
      agent: (await w.vault.read.getAgent([s.vaultId])).agent,
    });
    const start = await holdings();
    const botTokensStart = [await t1.read.balanceOf([botAddr]), await t2.read.balanceOf([botAddr])];
    const t = await now();
    const exp = t + 600n;

    const log: { name: string; ok: boolean; err?: string }[] = [];
    const attempt = async (name: string, f: () => Promise<unknown>, mayLand = false) => {
      let ok = false;
      let err: string | undefined;
      try {
        await f();
        ok = true;
      } catch (e) {
        err = revertInfo(e).name;
      }
      log.push({ name, ok, err });
      if (!mayLand) assert.equal(ok, false, `${name} must not succeed`);
      const now_ = await holdings();
      assert.deepEqual(now_, start, `${name}: vault value/state changed`);
    };

    const sigs: Record<string, Hex> = {
      empty: "0x",
      ecdsa65: garbage(65, 3),
      random4627: garbage(4627, 5),
      zeros4627: ("0x" + "00".repeat(4627)) as Hex,
    };
    // a real ML-DSA-87 signature by the bot's OWN key over the correct digest, registered as valid for ITS key
    const botSignedFor = async (digest: Hex) => {
      const sig = signDigest(botPQ, digest);
      await accept(w, botPQ, digest, sig);
      return sig;
    };
    const mkAuth = (sig: Hex) => ({ nonce: 0n, expiry: exp, sig, pubkey: "0x" as Hex });
    const D = w.domain;
    const sv = { vaultId: s.vaultId, nonce: 0n, expiry: exp };

    const calls: [string, (sig: Hex) => Promise<unknown>, Hex][] = [
      ["withdraw native to bot", (sig) => w.vault.write.withdraw([s.vaultId, NATIVE, parseEther("100"), botAddr, mkAuth(sig)], { account: bot.account }), withdrawDigest(D, sv, NATIVE, parseEther("100"), botAddr)],
      ["withdraw token1 to bot", (sig) => w.vault.write.withdraw([s.vaultId, t1.address, 5000n * E18, botAddr, mkAuth(sig)], { account: bot.account }), withdrawDigest(D, sv, t1.address, 5000n * E18, botAddr)],
      ["withdraw token2 to bot", (sig) => w.vault.write.withdraw([s.vaultId, t2.address, 123456n, botAddr, mkAuth(sig)], { account: bot.account }), withdrawDigest(D, sv, t2.address, 123456n, botAddr)],
      ["close to bot", (sig) => w.vault.write.close([s.vaultId, botAddr, mkAuth(sig)], { account: bot.account }), closeDigest(D, sv, botAddr)],
      ["setHeirs to bot", (sig) => w.vault.write.setHeirs([s.vaultId, [{ account: botAddr, payoutTo: botAddr, bps: 10000 }], mkAuth(sig)], { account: bot.account }), setHeirsDigest(D, sv, [{ account: botAddr, payoutTo: botAddr, bps: 10000 }])],
      ["setTiming to trigger early", (sig) => w.vault.write.setTiming([s.vaultId, 60n, 0, parseEther("100"), mkAuth(sig)], { account: bot.account }), setTimingDigest(D, sv, 60n, 0, parseEther("100"))],
      ["setAgent bot-controlled", (sig) => w.vault.write.setAgent([s.vaultId, A(w.attacker), NATIVE, parseEther("100"), parseEther("100"), t + 9999n, [botAddr], mkAuth(sig)], { account: bot.account }), setAgentDigest(D, sv, A(w.attacker), NATIVE, parseEther("100"), parseEther("100"), t + 9999n, [botAddr])],
      ["checkIn (starve heirs by faking life)", (sig) => w.vault.write.checkIn([s.vaultId, mkAuth(sig)], { account: bot.account }), checkInDigest(D, sv)],
    ];
    for (const [name, call, digest] of calls) {
      for (const [sigName, sig] of Object.entries(sigs)) await attempt(`${name} [${sigName}]`, () => call(sig));
      await attempt(`${name} [bot's own PQ key]`, async () => call(await botSignedFor(digest)));
    }

    // rotation is for DEVICE vaults only; this one is ACCOUNT
    await attempt("rotateKey to bot key", async () =>
      w.vault.write.rotateKey([s.vaultId, botPQ.pubHex, await botSignedFor(keccak256("0x01")), mkAuth(garbage(4627, 9))], { account: bot.account }),
    );
    // a DEVICE-style attempt: supply the bot's own pubkey in an ACCOUNT vault
    await attempt("checkIn with bot pubkey in ACCOUNT mode", async () =>
      w.vault.write.checkIn([s.vaultId, { nonce: 0n, expiry: exp, sig: await botSignedFor(checkInDigest(D, sv)), pubkey: botPQ.pubHex }], { account: bot.account }),
    );

    // agent / heir / lifecycle entry points
    await attempt("agentPay as owner account", () => w.vault.write.agentPay([s.vaultId, botAddr, 1n], { account: bot.account }));
    await attempt("agentPay of 1 wei", () => w.vault.write.agentPay([s.vaultId, botAddr, 1n], { account: bot.account }));
    await attempt("trigger during the drill", () => w.vault.write.trigger([s.vaultId], { account: bot.account }));
    await attempt("settle", () => w.vault.write.settle([s.vaultId], { account: bot.account }));
    for (const tok of [NATIVE, t1.address, t2.address]) {
      await attempt(`claim ${tok.slice(0, 6)}`, () => w.vault.write.claim([s.vaultId, 0n, tok], { account: bot.account }));
    }
    for (const idx of [0n, 1n, 2n]) {
      const heir = w.vault.read.getHeirs([s.vaultId]).then((h) => h[Number(idx)].account);
      await attempt(`setPayout heir ${idx} (bot's own PQ key)`, async () => {
        const h = await heir;
        const d = setPayoutDigest(D, { vaultId: s.vaultId, nonce: 0n, expiry: exp }, idx, h, botAddr);
        return w.vault.write.setPayout([s.vaultId, idx, botAddr, 0n, exp, await botSignedFor(d)], { account: bot.account });
      });
      await attempt(`setPayout heir ${idx} (garbage sig)`, async () =>
        w.vault.write.setPayout([s.vaultId, idx, botAddr, 0n, exp, garbage(4627, 11)], { account: bot.account }),
      );
    }

    // plain transfers, unknown selectors, empty and malformed calldata
    await attempt("plain native transfer to the vault", () => bot.sendTransaction({ to: w.vault.address, value: 1n }));
    await attempt("unknown selector", () => bot.sendTransaction({ to: w.vault.address, data: "0xa9059cbb" + "00".repeat(64) as Hex }));
    await attempt("empty calldata", () => bot.sendTransaction({ to: w.vault.address, data: "0x" }));
    await attempt("selfdestruct-like pull: call vault with owner's address as token", () =>
      w.vault.write.depositToken([s.vaultId, botAddr, 1n], { account: bot.account }),
    );

    // token approvals and pulls: the vault never calls approve and only pulls from msg.sender
    await attempt("bot approves the vault for its own tokens (harmless)", () => t1.write.approve([w.vault.address, 2n ** 255n], { account: bot.account }), true);
    await t1.write.approve([w.vault.address, 1000n], { account: w.deployer.account }); // a victim approves, bot cannot pull it
    const victim = await t1.read.balanceOf([A(w.deployer)]);
    await attempt("bot depositToken hoping to pull the victim's allowance", () => w.vault.write.depositToken([s.vaultId, t1.address, 1000n], { account: bot.account }));
    assert.equal(await t1.read.balanceOf([A(w.deployer)]), victim);

    // forced native balance does not become spendable: accounting is internal only
    await testClient.setBalance({ address: w.vault.address, value: start.native + parseEther("5") });
    assert.equal(await w.vault.read.balanceOf([s.vaultId, zeroAddress]), start.vNative);
    await testClient.setBalance({ address: w.vault.address, value: start.native });

    // creating a vault from the drill account makes a different, empty id; it cannot touch ours
    await attempt("createVault from the drill account (new empty vault)", async () => {
      const p = { ...s.params, salt: keccak256("0xd00d") };
      return w.vault.write.createVault([p], { account: bot.account });
    }, true);
    await attempt("createVault with the SAME salt (VaultExists)", () => w.vault.write.createVault([s.params], { account: bot.account }));

    // replay of a captured, already-used owner signature
    const legit = act.checkIn();
    const au = await signAuth(w, s.vaultId, s.key, s.mode, legit.digest);
    await legit.send(w, s.vaultId, au); // relayer submits the owner's real check-in
    start.vault = await w.vault.read.getVault([s.vaultId]); // nonce/lastCheckin legitimately moved
    await attempt("replay of the used check-in", () => legit.send(w, s.vaultId, au, bot));
    // a captured-but-unused withdraw with the recipient swapped for the bot
    const wd = act.withdraw(NATIVE, parseEther("1"), A(w.payee1));
    const wdAuth = await signAuth(w, s.vaultId, s.key, s.mode, wd.digest);
    await attempt("captured withdraw with recipient swapped to the bot", () =>
      w.vault.write.withdraw([s.vaultId, NATIVE, parseEther("1"), botAddr, wdAuth], { account: bot.account }),
    );

    // every refusal is one of the contract's own custom errors from THREAT_MODEL's table (or an empty-data revert for
    // plain sends / unknown selectors): never an accidental failure of the harness
    const expectedErrors = new Set([
      "PQSignatureInvalid", "BadSignatureLength", "BadPubkeyLength", "UnexpectedPubkey", "WrongKeyMode", "NotAgent",
      "NotOverdue", "WrongStatus", "VaultExists", "BadNonce", "TokenNotAllowed", "ERC20InsufficientBalance", "ERC20InsufficientAllowance",
    ]);
    for (const l of log.filter((x) => !x.ok)) {
      if (l.err === undefined) assert.match(l.name, /plain native transfer|unknown selector|empty calldata/, `${l.name}: empty-data revert only expected for plain sends`);
      else assert.ok(expectedErrors.has(l.err), `${l.name}: unexpected revert ${l.err}`);
    }
    const seen = new Set(log.filter((x) => x.err).map((x) => x.err));
    for (const must of ["PQSignatureInvalid", "BadSignatureLength", "NotAgent", "NotOverdue", "WrongStatus", "VaultExists", "BadNonce", "WrongKeyMode", "UnexpectedPubkey"]) {
      assert.ok(seen.has(must), `drill never produced ${must}`);
    }
    const landed = log.filter((l) => l.ok).map((l) => l.name);
    console.log(`  Q-Day drill: ${log.length} attacks, ${log.length - landed.length} refused, ${landed.length} landed (harmless: ${landed.join("; ")})`);
    assert.equal(landed.length, 2); // the bot's own approve and its own empty vault, nothing else
    assert.deepEqual(await holdings(), start);
    assert.deepEqual([await t1.read.balanceOf([botAddr]), await t2.read.balanceOf([botAddr])], botTokensStart);

    // proof transaction after the drill: the real owner's PQ signature still controls everything
    const proof = act.withdraw(NATIVE, parseEther("1"), A(w.payee1));
    const before = await balance(A(w.payee1));
    await proof.send(w, s.vaultId, wdAuth);
    assert.equal((await balance(A(w.payee1))) - before, parseEther("1"));
    void Action; void KeyMode; void ZERO_HASH; void encodeAbiParameters; void viem; void publicClient;
  });

  it("with an open EVM window the bot's best case is an empty look-alike vault", async () => {
    const { w, s } = await networkHelpers.loadFixture(drillWorld);
    // the bot creates its own vault under the owner's address with its own heirs
    const bot = w.owner;
    const p = { ...s.params, salt: keccak256("0xbeef"), tokens: [], heirs: [{ account: A(w.attacker), payoutTo: A(w.attacker), bps: 10000 }] };
    await w.vault.write.createVault([p], { account: bot.account });
    const id = await w.vault.read.computeVaultId([A(bot), KeyMode.ACCOUNT, ZERO_HASH, p]);
    assert.notEqual(id, s.vaultId);
    assert.equal(await w.vault.read.balanceOf([id, zeroAddress]), 0n);
    assert.equal(await w.vault.read.balanceOf([s.vaultId, zeroAddress]), parseEther("100"));
    // and the real owner's PQ key controls that look-alike too (it can close it)
    const a = act.close(A(w.payee1));
    const au = await signAuth(w, id, s.key, s.mode, a.digest);
    await a.send(w, id, au);
    assert.equal(Number(await w.vault.read.stateOf([id])), 6);
  });
});

describe("negative control", () => {
  it("if the verify precompile wrongly said 'valid' for everything, the same drain paths WOULD land", async () => {
    const { w, s, t1 } = await networkHelpers.loadFixture(drillWorld);
    const bot = w.owner;
    const before = await balance(w.vault.address);
    await w.a01.write.setRawVerifyReturn(["0x" + "00".repeat(31) + "01" as Hex]);
    const au = { nonce: 0n, expiry: (await now()) + 600n, sig: garbage(4627, 21), pubkey: "0x" as Hex };
    await w.vault.write.withdraw([s.vaultId, NATIVE, parseEther("100"), A(bot), au], { account: bot.account });
    assert.equal(await w.vault.read.balanceOf([s.vaultId, zeroAddress]), 0n);
    assert.equal((await balance(w.vault.address)), before - parseEther("100"));
    const au2 = { ...au, nonce: 1n };
    await w.vault.write.withdraw([s.vaultId, t1.address, 5000n * E18, A(bot), au2], { account: bot.account });
    assert.equal(await t1.read.balanceOf([A(bot)]), 5000n * E18);
    await w.a01.write.setRawVerifyReturn(["0x"]);
  });
});

describe("trust boundary: the chain's key registry", () => {
  it("ACCOUNT vaults follow the registry live (so the chain must refuse ECDSA-only re-registration); DEVICE vaults do not", async () => {
    const w = await networkHelpers.loadFixture(deployWorld);
    const acc = await makeAccountVaultFor(w, { interval: 8n * DAY, grace: 1 }, parseEther("10"));
    const { makeDeviceVault } = await import("../testkit/harness.js");
    const dev = await makeDeviceVault(w, { interval: 8n * DAY, grace: 1, salt: keccak256("0xdd") }, parseEther("10"));
    // Hypothetical: the registry entry of the owner account is replaced by the thief's key. We only model it
    // here to document the assumption. On QoreChain re-registration is part of the hybrid-authorised surface.
    const thief = pqKey("thief");
    await registerAccount(w, A(w.owner), thief);
    const a = act.withdraw(NATIVE, parseEther("10"), A(w.attacker));
    const aAuth = await signAuth(w, acc.vaultId, thief, acc.mode, a.digest);
    await a.send(w, acc.vaultId, aAuth); // ACCOUNT mode: follows the registry, so the thief wins
    const dAuth = await signAuth(w, dev.vaultId, thief, dev.mode, a.digest);
    const { expectError } = await import("../testkit/harness.js");
    await expectError(a.send(w, dev.vaultId, dAuth), "PubkeyMismatch"); // DEVICE mode: pinned hash, immune
    assert.equal(await w.vault.read.balanceOf([dev.vaultId, NATIVE]), parseEther("10"));
  });
});
