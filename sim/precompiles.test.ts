import { describe, expect, it } from "vitest";
import { decodeFunctionResult, encodeFunctionData, type Hex } from "viem";
import { bytesToHex } from "viem";
import { pqKeygen, pqSign, exportDeviceKey, importDeviceKey, pqPubkeyHash } from "../lib/pq.ts";
import { pubkeyHash, PQ_PUBKEY_LENGTH, PQ_SIGNATURE_LENGTH } from "../lib/encoding.ts";
import { QoreSim } from "./chain.ts";
import { compileSource } from "./node.ts";
import { PROBE_SOURCE } from "./probe.sol.ts";

const me = "0x1111111111111111111111111111111111111111" as const;
const h = (b: Uint8Array) => bytesToHex(b);

async function probe() {
  const sim = await QoreSim.create();
  await sim.fund(me, 10n ** 18n);
  const art = compileSource(PROBE_SOURCE, "PqcProbe");
  const d = await sim.deploy(art, [], me);
  const call = async (fn: string, args: unknown[]) => {
    const r = await sim.call({ from: me, to: d.address, data: encodeFunctionData({ abi: art.abi, functionName: fn, args } as never) });
    expect(r.ok, r.revert?.reason).toBe(true);
    return decodeFunctionResult({ abi: art.abi, functionName: fn, data: r.returnData } as never) as never as readonly unknown[];
  };
  return { sim, art, addr: d.address, call };
}

describe("lib/pq", () => {
  it("keygen is deterministic from a seed and sizes match the chain", () => {
    const a = pqKeygen(new Uint8Array(32).fill(1));
    const b = pqKeygen(new Uint8Array(32).fill(1));
    expect(a.publicKey.length).toBe(PQ_PUBKEY_LENGTH);
    expect(h(a.publicKey)).toBe(h(b.publicKey));
    expect(pqKeygen().publicKey).not.toEqual(a.publicKey);
  });
  it("signing is deterministic and 4627 bytes", () => {
    const k = pqKeygen(new Uint8Array(32).fill(2));
    const d = ("0x" + "ab".repeat(32)) as Hex;
    expect(pqSign(d, k.secretKey).length).toBe(PQ_SIGNATURE_LENGTH);
    expect(h(pqSign(d, k.secretKey))).toBe(h(pqSign(d, k.secretKey)));
  });
  it("pubkey hash matches lib/encoding", () => {
    const k = pqKeygen(new Uint8Array(32).fill(3));
    expect(pqPubkeyHash(k.publicKey)).toBe(pubkeyHash(k.publicKey));
  });
  it("device key export/import round-trips and rejects tampering", () => {
    const k = pqKeygen();
    const txt = exportDeviceKey(k.seed);
    expect(h(importDeviceKey(txt).publicKey)).toBe(h(k.publicKey));
    const bad = txt.slice(0, 10) + (txt[10] === "0" ? "1" : "0") + txt.slice(11);
    expect(() => importDeviceKey(bad)).toThrow();
    expect(() => importDeviceKey("hello")).toThrow();
    expect(() => importDeviceKey(txt.slice(0, -1) + (txt.endsWith("0") ? "1" : "0"))).toThrow(/checksum/);
  });
});

describe("pqcVerify precompile (real ML-DSA-87)", () => {
  it("accepts a valid signature, rejects wrong message / key / tampered sig", async () => {
    const { call } = await probe();
    const k = pqKeygen(new Uint8Array(32).fill(4));
    const other = pqKeygen(new Uint8Array(32).fill(5));
    const msg = new Uint8Array(32).fill(9);
    const sig = pqSign(msg, k.secretKey);
    expect((await call("verify", [h(k.publicKey), h(sig), h(msg)]))[0]).toBe(true);
    expect((await call("verify", [h(k.publicKey), h(sig), h(new Uint8Array(32).fill(8))]))[0]).toBe(false);
    expect((await call("verify", [h(other.publicKey), h(sig), h(msg)]))[0]).toBe(false);
    const bad = sig.slice();
    bad[100] ^= 1;
    expect((await call("verify", [h(k.publicKey), h(bad), h(msg)]))[0]).toBe(false);
  });
  it("returns false (not a revert) on malformed input", async () => {
    const { call } = await probe();
    const r = await call("verifyRaw", ["0x1234"]);
    expect(r[0]).toBe(true);
  });
  it("charges 25000 + 8 per input byte", async () => {
    const { call, sim } = await probe();
    const k = pqKeygen(new Uint8Array(32).fill(6));
    const msg = new Uint8Array(32).fill(1);
    const sig = pqSign(msg, k.secretKey);
    const used = (await call("gasOfVerify", [h(k.publicKey), h(sig), h(msg)])) as unknown as bigint;
    // input = selector(4) + 3 offsets + 3 lengths + padded payloads
    const pad = (n: number) => Math.ceil(n / 32) * 32;
    const inputLen = 4 + 6 * 32 + pad(2592) + pad(4627) + pad(32);
    const expected = 25_000n + 8n * BigInt(inputLen);
    console.log('verify gas used', used, 'expected floor', expected);
    expect(used >= expected && used < expected + 6_000n).toBe(true);
    expect(sim.pqc.verifyCalls).toBeGreaterThan(0);
  });
  it("inactive precompile returns success with EMPTY data (fail-closed demo)", async () => {
    const { call, sim } = await probe();
    sim.setPqcActive(false);
    const k = pqKeygen(new Uint8Array(32).fill(7));
    const msg = new Uint8Array(32).fill(2);
    const [ok, retLen] = await call("verify", [h(k.publicKey), h(pqSign(msg, k.secretKey)), h(msg)]);
    expect(ok).toBe(false);
    expect(retLen).toBe(0n);
  });
});

describe("pqcKeyStatus precompile", () => {
  it("reports registry entries and unregistered accounts", async () => {
    const { call, sim } = await probe();
    const k = pqKeygen(new Uint8Array(32).fill(8));
    sim.registerAccountKey(me, k.publicKey, { possessionProven: false });
    const [success, ret] = (await call("status", [me])) as [boolean, Hex];
    expect(success).toBe(true);
    // (bool registered, uint8 alg, bytes pubkey, bool proven): registered = 1, alg = 1, proven = 0
    expect(BigInt("0x" + ret.slice(2, 66))).toBe(1n);
    expect(BigInt("0x" + ret.slice(66, 130))).toBe(1n);
    expect(BigInt("0x" + ret.slice(2 + 3 * 64, 2 + 4 * 64))).toBe(0n); // possessionProven = false
    const [, ret2] = (await call("status", ["0x2222222222222222222222222222222222222222"])) as [boolean, Hex];
    expect(BigInt("0x" + ret2.slice(2, 66))).toBe(0n);
  });
  it("inactive returns empty data", async () => {
    const { call, sim } = await probe();
    sim.setPqcActive(false);
    const [success, ret] = (await call("status", [me])) as [boolean, Hex];
    expect(success).toBe(true);
    expect(ret).toBe("0x");
  });
});

describe("sim chain basics", () => {
  it("time travel moves block.timestamp; reverts and eth_call roll state back", async () => {
    const { sim, art, addr } = await probe();
    const t0 = sim.now;
    sim.advanceTime(1000);
    const tx = await sim.send({ from: me, to: addr, data: encodeFunctionData({ abi: art.abi, functionName: "store", args: [5n] }) });
    expect(tx.timestamp).toBe(t0 + 1000n);
    expect(sim.now).toBe(t0 + 1001n);
    const bad = await sim.send({ from: me, to: addr, value: 5n, data: "0xdeadbeef" });
    expect(bad.ok).toBe(false);
    await sim.call({ from: me, to: addr, data: encodeFunctionData({ abi: art.abi, functionName: "store", args: [77n] }) });
    const r = await sim.call({ from: me, to: addr, data: encodeFunctionData({ abi: art.abi, functionName: "_x" }) });
    expect(BigInt(r.returnData)).toBe(5n);
    expect(await sim.balanceOf(me)).toBe(10n ** 18n);
    expect(tx.from).toBe(me);
  });
  it("uses chain id 9800", async () => {
    const sim = await QoreSim.create();
    expect(sim.chainId).toBe(9800n);
  });
});
