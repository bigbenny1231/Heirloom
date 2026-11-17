import { describe, expect, it } from "vitest";
import { hexToBytes } from "viem";
import { EMPTY_ARGS_HASH, PQC_VERIFY_ADDRESS, checkInDigest, pqVerify } from "@sim/index";
import { createDemoAdapter } from "./demo";
import { addressFromHash } from "./testnet";
import { fmtAmount, parseAmount } from "../ui/format";

const E18 = 10n ** 18n;

describe("demo adapter", () => {
  it("creates the sample vault, checks in, rejects an unsigned withdraw, pays an agent, runs the drill and pays heirs", async () => {
    const a = await createDemoAdapter(() => {});
    let v = (await a.snapshot())!;
    expect(v.state).toBe("ALIVE");
    expect(v.balances[0].amount).toBe(500n * E18);
    expect(v.balances[1].amount).toBe(1200n * E18);
    expect(v.heirs.map((h) => h.bps)).toEqual([6000, 4000]);
    expect(v.agent?.perTx).toBe(5n * E18);

    const n0 = v.nonce;
    const ci = await a.checkIn();
    expect(ci.ok).toBe(true);
    expect(ci.sigBytes).toBe(4627);
    expect((await a.snapshot())!.nonce).toBe(n0 + 1);

    const bad = await a.withdraw({ token: "0x0000000000000000000000000000000000000000", amount: 25n * E18, to: a.parties.you.address, pq: false });
    expect(bad.ok).toBe(false);
    expect(bad.errorName).toBeTruthy();
    const good = await a.withdraw({ token: "0x0000000000000000000000000000000000000000", amount: 25n * E18, to: a.parties.you.address, pq: true });
    expect(good.ok).toBe(true);

    const okPay = await a.agentPay(a.parties.payee.address, 3n * E18);
    expect(okPay.ok).toBe(true);
    const denied = await a.agentPay(a.parties.stranger.address, 50n * E18);
    expect(denied.denied).toBe("PAYEE_NOT_ALLOWED");

    const rows: string[] = [];
    const rep = await a.drill((r) => rows.push(r.name));
    expect(rep.tried).toBeGreaterThan(20);
    expect(rep.blocked).toBe(rep.tried);
    expect(rep.valueKeptPct).toBe(100);
    expect(rows.length).toBe(rep.tried);

    const po = await a.heirSetPayout(0, a.parties.stranger.address);
    expect(po.ok).toBe(true);

    await a.advance(86400 * 40);
    v = (await a.snapshot())!;
    expect(v.state).toBe("OVERDUE");
    expect((await a.trigger()).ok).toBe(true);
    expect((await a.settle()).ok).toBe(true);
    v = (await a.snapshot())!;
    expect(v.state).toBe("SETTLED");
    expect(v.balances.every((b) => b.amount === 0n)).toBe(true);

    await expect(a.drill(() => {})).rejects.toThrow(/empty or no longer active/);
    const key = a.exportKey();
    expect(key.startsWith("qdmv1:")).toBe(true);
    await a.reset();
    expect((await a.snapshot())!.state).toBe("ALIVE");
  });

  it("rotates the device key", async () => {
    const a = await createDemoAdapter(() => {});
    const before = a.deviceKey().pubkeyHash;
    expect((await a.rotateKey()).ok).toBe(true);
    expect(a.deviceKey().pubkeyHash).not.toBe(before);
    expect((await a.checkIn()).ok).toBe(true);
  });
});

describe("helpers", () => {
  it("reads only plain hex addresses from the hash", () => {
    expect(addressFromHash("#addr=0x1111111111111111111111111111111111111111")).toBe("0x1111111111111111111111111111111111111111");
    expect(addressFromHash("#addr=0x11<script>")).toBeNull();
    expect(addressFromHash("#key=0xabc")).toBeNull();
  });
  it("formats amounts", () => {
    expect(fmtAmount(500n * E18)).toBe("500");
    expect(fmtAmount(1234n * E18 + E18 / 2n)).toBe("1,234.5");
    expect(parseAmount("1.5")).toBe(E18 + E18 / 2n);
    expect(parseAmount("abc")).toBeNull();
  });
});

describe("demo adapter: v2 additions", () => {
  it("exposes the real key bytes and a signature for the boot-time owner action", async () => {
    const a = await createDemoAdapter(() => {});
    expect(a.keyBytes!().length).toBe(2592);
    expect(a.lastSignature!()?.action).toBe("setAgent");
  });

  it("lastSignature has 8 fields, a 4,627-byte sig and a digest that matches lib/encoding.ts", async () => {
    const a = await createDemoAdapter(() => {});
    expect((await a.checkIn()).ok).toBe(true);
    const s = a.lastSignature!()!;
    expect(s.action).toBe("checkIn");
    expect(s.fields.map((f) => f.label)).toEqual(["Tag", "Chain id", "Contract", "Vault id", "Action", "Args hash", "Nonce", "Expiry"]);
    expect(s.fields.length).toBe(8);
    expect(s.sig.length).toBe(4627);
    expect(s.sigBytes).toBe(4627);
    expect(s.pubkeyBytes).toBe(2592);
    expect(s.pubkeyHash).toBe(a.deviceKey().pubkeyHash);
    expect(s.precompile).toBe(PQC_VERIFY_ADDRESS);
    const f = Object.fromEntries(s.fields.map((x) => [x.label, x.value]));
    expect(f["Tag"]).toBe("QDMV1");
    const digest = checkInDigest(
      { chainId: BigInt(f["Chain id"]), vault: f["Contract"] as `0x${string}` },
      { vaultId: BigInt(f["Vault id"]), nonce: BigInt(f["Nonce"]), expiry: BigInt(f["Expiry"]) },
    );
    expect(s.digest).toBe(digest);
    expect(f["Args hash"]).toBe(EMPTY_ARGS_HASH);
    expect(f["Action"]).toBe("2 CHECKIN");
    // The signature really verifies against the pinned key.
    expect(pqVerify(s.sig, hexToBytes(s.digest), hexToBytes(a.deviceKey().pubkeyHex))).toBe(true);
  });

  it("labAttempt: valid is accepted, every other variant is refused with the contract's error name", async () => {
    const a = await createDemoAdapter(() => {});
    const n0 = (await a.snapshot())!.nonce;
    const ok = await a.labAttempt!("valid");
    expect(ok.ok).toBe(true);
    expect(ok.variant).toBe("valid");
    expect(ok.sigBytes).toBe(4627);
    expect(ok.gasUsed).toBeGreaterThan(0n);
    expect(ok.inspect?.sig.length).toBe(4627);
    expect(a.lastSignature!()?.digest).toBe(ok.inspect!.digest);
    expect((await a.snapshot())!.nonce).toBe(n0 + 1);

    const names: Record<string, string> = {};
    for (const v of ["flip-bit", "wrong-key", "replay", "expired"] as const) {
      const r = await a.labAttempt!(v);
      expect(r.ok, v).toBe(false);
      expect(r.variant).toBe(v);
      expect(r.errorName, v).toBeTruthy();
      expect(r.gasUsed, v).toBeGreaterThan(0n);
      expect(r.sigBytes, v).toBe(4627);
      expect(r.inspect?.fields.length, v).toBe(8);
      expect(r.inspect?.sig.length, v).toBe(4627);
      names[v] = r.errorName!;
    }
    console.log("lab error names", JSON.stringify(names));
    expect(names["flip-bit"]).toMatch(/Signature|Invalid/i);
    expect(names["wrong-key"]).toMatch(/Signature|Invalid/i);
    expect(names["replay"]).toMatch(/Nonce|Replay|Expired|Invalid/i);
    expect(names["expired"]).toMatch(/Expir/i);
    // Refusals changed nothing.
    expect((await a.snapshot())!.nonce).toBe(n0 + 1);
    expect((await a.checkIn()).ok).toBe(true);
  });

  it("createVault applies labels, interval, grace, funds and key mode", async () => {
    const a = await createDemoAdapter(() => {});
    const msgs: string[] = [];
    const r = await a.createVault!(
      { heirs: [{ label: "Maya", bps: 6000 }, { label: "Leo", bps: 4000 }], intervalDays: 30, grace: 3, fundQor: 120, keyMode: "DEVICE" },
      (m) => msgs.push(m),
    );
    expect(r.ok).toBe(true);
    expect(r.sigBytes).toBe(4627);
    expect(r.gasUsed).toBeGreaterThan(0n);
    expect(msgs.length).toBeGreaterThan(0);
    const v = (await a.snapshot())!;
    expect(v.state).toBe("ALIVE");
    expect(v.heirs.map((h) => h.label)).toEqual(["Maya", "Leo"]);
    expect(v.heirs.map((h) => h.bps)).toEqual([6000, 4000]);
    expect(v.interval).toBe(30 * 86400);
    expect(v.grace).toBe(3);
    expect(v.balances[0].amount).toBe(120n * E18);
    expect(v.keyMode).toBe("DEVICE");
    expect((await a.checkIn()).ok).toBe(true);
    // Settling pays real amounts to the named heirs.
    await a.advance(86400 * 200);
    expect((await a.trigger()).ok).toBe(true);
    expect((await a.settle()).ok).toBe(true);
    const after = (await a.snapshot())!;
    expect(after.heirs[0].label).toBe("Maya");
  });

  it("createVault supports three heirs and rejects bad configs", async () => {
    const a = await createDemoAdapter(() => {});
    const r = await a.createVault!({ heirs: [{ label: "A", bps: 5000 }, { label: "B", bps: 3000 }, { label: "C", bps: 2000 }], intervalDays: 7, grace: 1, fundQor: 10, keyMode: "ACCOUNT" });
    expect(r.ok).toBe(true);
    const v = (await a.snapshot())!;
    expect(v.heirs.map((h) => h.label)).toEqual(["A", "B", "C"]);
    expect(v.keyMode).toBe("ACCOUNT");
    expect((await a.checkIn()).ok).toBe(true);
    const bad = await a.createVault!({ heirs: [{ label: "A", bps: 5000 }, { label: "B", bps: 4000 }], intervalDays: 7, grace: 2, fundQor: 10, keyMode: "DEVICE" });
    expect(bad.ok).toBe(false);
    expect((await a.snapshot())!.heirs.length).toBe(3);
  });

  it("createVault resets observed actions so the drill replays only the new vault", async () => {
    const a = await createDemoAdapter(() => {});
    await a.checkIn();
    await a.createVault!({ heirs: [{ label: "Maya", bps: 6000 }, { label: "Leo", bps: 4000 }], intervalDays: 7, grace: 2, fundQor: 50, keyMode: "DEVICE" });
    const rep = await a.drill(() => {});
    expect(rep.blocked).toBe(rep.tried);
    expect(rep.valueKeptPct).toBe(100);
  });

  it("flip-bit sends one fresh signature with exactly one flipped byte (flippedAt)", async () => {
    const a = await createDemoAdapter(() => {});
    await a.checkIn();
    const before = a.lastSignature!()!;
    const r = await a.labAttempt!("flip-bit");
    expect(r.ok).toBe(false);
    expect(typeof r.flippedAt).toBe("number");
    const sent = r.inspect!.sig;
    expect(sent.length).toBe(4627);
    // The sent bytes are a new signature, not the previous one.
    expect(sent.some((b, i) => b !== before.sig[i])).toBe(true);
    // Flipping the bit back gives the byte the signer produced: exactly one differing bit at flippedAt.
    const fixed = new Uint8Array(sent);
    fixed[r.flippedAt!] ^= 1;
    expect(fixed[r.flippedAt!]).not.toBe(sent[r.flippedAt!]);
    const ok = await a.labAttempt!("valid");
    expect(ok.flippedAt).toBeUndefined();
    expect(ok.ok).toBe(true);
  });

  it("prepareKey makes the key createVault pins, and trigger explains the keeper bounty", async () => {
    const a = await createDemoAdapter(() => {});
    const pk = a.prepareKey!();
    expect(pk.length).toBe(2592);
    expect(a.keyBytes!()).toBe(pk);
    const msgs: string[] = [];
    const r = await a.createVault!({ heirs: [{ label: "Maya", bps: 6000 }, { label: "Leo", bps: 4000 }], intervalDays: 7, grace: 2, fundQor: 1000, keyMode: "DEVICE" }, (m) => msgs.push(m));
    expect(r.ok).toBe(true);
    expect(msgs.some((m) => m.includes("Generating"))).toBe(false);
    expect(msgs).toContain("Creating your vault");
    expect(a.deviceKey().pubkeyHex).toBe("0x" + Array.from(pk, (b) => b.toString(16).padStart(2, "0")).join(""));
    await a.advance(86400 * 200);
    const t = await a.trigger();
    expect(t.detail).toBe("The caller earned the 1 QOR keeper bounty. 999 QOR is left for the heirs.");
  });

  it("funds above 10,000 QOR work, and bad numbers fail cleanly", async () => {
    const a = await createDemoAdapter(() => {});
    const big = await a.createVault!({ heirs: [{ label: "A", bps: 5000 }, { label: "B", bps: 5000 }], intervalDays: 30, grace: 2, fundQor: 25000, keyMode: "DEVICE" });
    expect(big.ok).toBe(true);
    expect((await a.snapshot())!.balances[0].amount).toBe(25000n * E18);
    for (const intervalDays of [0, 1.5, 366]) {
      const r = await a.createVault!({ heirs: [{ label: "A", bps: 5000 }, { label: "B", bps: 5000 }], intervalDays, grace: 2, fundQor: 10, keyMode: "DEVICE" });
      expect(r.ok, String(intervalDays)).toBe(false);
    }
  });
});
