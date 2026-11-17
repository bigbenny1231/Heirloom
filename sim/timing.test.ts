import { describe, expect, it } from "vitest";
import { pqKeygen, pqSign, pqVerify } from "../lib/pq.ts";
import { NATIVE, checkInDigest, withdrawDigest } from "../lib/encoding.ts";
import { expectOk } from "./client.ts";
import { ACCOUNTS as A, ETH, accountVault, newWorld } from "./testkit.ts";

const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

describe("ML-DSA-87 cost (browser feasibility)", () => {
  it("measures keygen / sign / verify and on-chain gas", async () => {
    const seeds = Array.from({ length: 5 }, (_, i) => new Uint8Array(32).fill(i + 1));
    const kg: number[] = [], sg: number[] = [], vf: number[] = [];
    const digest = ("0x" + "42".repeat(32)) as `0x${string}`;
    for (const seed of seeds) {
      let t = performance.now();
      const k = pqKeygen(seed);
      kg.push(performance.now() - t);
      t = performance.now();
      const sig = pqSign(digest, k.secretKey);
      sg.push(performance.now() - t);
      t = performance.now();
      expect(pqVerify(sig, new Uint8Array(32).fill(0x42), k.publicKey)).toBe(true);
      vf.push(performance.now() - t);
    }
    const w = await newWorld();
    const id = await accountVault(w, 1, 5n * ETH);
    const ci = expectOk(await w.client.checkIn(id, w.keys.owner));
    const wd = expectOk(await w.client.withdraw(id, w.keys.owner, NATIVE, ETH, A.payee));
    // eslint-disable-next-line no-console
    console.log(
      `TIMINGS node ${process.version}: keygen median ${median(kg).toFixed(1)} ms, sign median ${median(sg).toFixed(1)} ms, ` +
        `verify median ${median(vf).toFixed(1)} ms; gas checkIn=${ci.gasUsed} withdraw=${wd.gasUsed}`,
    );
    void checkInDigest; void withdrawDigest;
    // generous ceilings: the point is "tens of ms", not seconds
    expect(median(sg)).toBeLessThan(2000);
    expect(median(vf)).toBeLessThan(2000);
    expect(ci.gasUsed).toBe(ci.executionGas + ci.intrinsicGas);
    expect(ci.intrinsicGas).toBeGreaterThan(21_000n);
    expect(ci.executionGas).toBeGreaterThan(90_000n);
    expect(ci.gasUsed).toBeGreaterThan(100_000n); // dominated by the 25k + 8/byte pqcVerify charge
  });
});
