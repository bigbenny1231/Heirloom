/** pqcKeyStatus may answer with 4 values (docs, SPEC) or 3 values (@qorechain/evm 0.14.0 ABI). Both must work; junk must not. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { createDigest, KeyMode, ZERO_HASH } from "../lib/encoding.js";
import {
  accept, act, deployWorld, expectError, makeAccountVault, networkHelpers, now, params, pqKey, signAuth, signDigest, type Scenario,
} from "../testkit/harness.js";

const key = pqKey("owner");
const enc4 = (reg: boolean, alg: number, pk: Hex, proven: boolean) =>
  encodeAbiParameters([{ type: "bool" }, { type: "uint8" }, { type: "bytes" }, { type: "bool" }], [reg, alg, pk, proven]);
const enc3 = (reg: boolean, alg: number, pk: Hex) =>
  encodeAbiParameters([{ type: "bool" }, { type: "uint8" }, { type: "bytes" }], [reg, alg, pk]);
const word = (n: number | bigint) => BigInt(n).toString(16).padStart(64, "0");

const fixture = async () => {
  const w = await deployWorld();
  const s = await makeAccountVault(w, {}, 1n);
  return s;
};
const load = (): Promise<Scenario> => networkHelpers.loadFixture(fixture);

async function checkIn(s: Scenario) {
  const au = await signAuth(s.w, s.vaultId, s.key, s.mode, act.checkIn().digest);
  return s.w.vault.write.checkIn([s.vaultId, au]);
}
const setRaw = (s: Scenario, raw: Hex) => s.w.a02.write.setRawStatusReturn([raw]);

describe("pqcKeyStatus answer shapes", () => {
  it("4-value, proven: accepted", async () => {
    const s = await load();
    await setRaw(s, enc4(true, 1, key.pubHex, true));
    await checkIn(s);
  });

  it("4-value, possession not proven: rejected", async () => {
    const s = await load();
    await setRaw(s, enc4(true, 1, key.pubHex, false));
    await expectError(checkIn(s), "PQKeyPossessionNotProven");
  });

  it("3-value: accepted for owner actions", async () => {
    const s = await load();
    await setRaw(s, enc3(true, 1, key.pubHex));
    await checkIn(s);
  });

  it("3-value: unregistered and wrong algorithm still rejected", async () => {
    const s = await load();
    await setRaw(s, enc3(false, 1, "0x"));
    await expectError(checkIn(s), "PQKeyNotRegistered");
    await setRaw(s, enc3(true, 2, key.pubHex));
    await expectError(checkIn(s), "PQKeyWrongAlgorithm", [2]);
  });

  it("3-value: createVault (no signature, possession unknowable) is refused; createVaultFor (signature = PoP) works", async () => {
    const s = await load();
    const w = s.w;
    await setRaw(s, enc3(true, 1, key.pubHex));
    const p = params(w, { salt: keccak256("0x5151") });
    await expectError(w.vault.write.createVault([p], { account: w.owner.account }), "PQKeyPossessionNotProven");
    const owner = w.owner.account.address;
    const expiry = (await now()) + 600n;
    const { digest } = createDigest(w.domain, owner, KeyMode.ACCOUNT, ZERO_HASH, p, expiry);
    const sig = signDigest(key, digest);
    await accept(w, key, digest, sig);
    await w.vault.write.createVaultFor([owner, KeyMode.ACCOUNT, p, expiry, sig, "0x"], { account: w.relayer.account });
  });

  it("4-value proven: createVault works", async () => {
    const s = await load();
    await setRaw(s, enc4(true, 1, key.pubHex, true));
    await s.w.vault.write.createVault([params(s.w, { salt: keccak256("0x5252") })], { account: s.w.owner.account });
  });

  it("wrong pubkey length in either shape is BadPubkeyLength", async () => {
    const s = await load();
    await setRaw(s, enc4(true, 1, "0x1234", true));
    await expectError(checkIn(s), "BadPubkeyLength", [2n]);
    await setRaw(s, enc3(true, 1, ("0x" + "00".repeat(2593)) as Hex));
    await expectError(checkIn(s), "BadPubkeyLength", [2593n]);
  });

  it("malformed answers fail closed with PrecompileUnavailable", async () => {
    const s = await load();
    const good4 = enc4(true, 1, key.pubHex, true);
    const body = (o: number) => `0x${word(1)}${word(1)}${word(o)}${word(1)}${word(2592)}${"00".repeat(2592)}` as Hex;
    const cases: [string, Hex][] = [
      ["95 bytes", ("0x" + "00".repeat(95)) as Hex],
      ["offset 0x40", body(0x40)],
      ["offset 0xa0", body(0xa0)],
      ["offset 0", body(0)],
      ["offset huge", body(2 ** 30)],
      ["registered word = 2", ("0x" + word(2) + good4.slice(66)) as Hex],
      ["algorithm word = 256", ("0x" + good4.slice(2, 66) + word(256) + good4.slice(130)) as Hex],
      ["proven word = 2", ("0x" + good4.slice(2, 194) + word(2) + good4.slice(258)) as Hex],
      ["truncated bytes", good4.slice(0, good4.length - 64) as Hex],
      ["bytes length beyond data", ("0x" + word(1) + word(1) + word(0x80) + word(1) + word(2 ** 40)) as Hex],
      ["3-value truncated", enc3(true, 1, key.pubHex).slice(0, 400) as Hex],
    ];
    for (const [name, raw] of cases) {
      await setRaw(s, raw);
      await expectError(checkIn(s), "PrecompileUnavailable", undefined).catch((e) => {
        e.message = `[${name}] ${e.message}`;
        throw e;
      });
    }
  });

  it("inactive (empty returndata) is rejected", async () => {
    const s = await load();
    await s.w.a02.write.setInactive([true]);
    await expectError(checkIn(s), "PrecompileUnavailable");
  });
});
