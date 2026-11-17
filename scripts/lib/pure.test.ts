import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeFunctionResult, zeroAddress, type Address } from "viem";
import { State } from "../../lib/encoding.js";
import {
  KEY_STATUS_BYTES_3,
  KEY_STATUS_BYTES_4,
  PQC_KEY_STATUS3_ABI,
  PQC_KEY_STATUS_ABI,
  assertFitsBlock,
  assertKeyStatus,
  diffVault,
  splitDrillAmount,
  inDrillWindow,
  keeperPaused,
  parseBoundedInt,
  pickGas,
  blockRanges,
  classifyVerifyReturn,
  decodeKeyStatus,
  equalHeirs,
  isSequenceMismatch,
  formatDecimal,
  keeperAction,
  parseAddressList,
  parseDecimal,
  splitList,
  tamper,
  tokenCtorArgs,
  weiToUqorCeil,
  windowBudget,
  windowSatisfies,
  type WindowView,
} from "./pure.js";

const A = "0x1111111111111111111111111111111111111111" as Address;
const B = "0x2222222222222222222222222222222222222222" as Address;
const C = "0x3333333333333333333333333333333333333333" as Address;

describe("decimals", () => {
  it("parses and formats", () => {
    expect(parseDecimal("1.5", 6)).toBe(1_500_000n);
    expect(parseDecimal("5", 18)).toBe(5n * 10n ** 18n);
    expect(formatDecimal(1_500_000n, 6)).toBe("1.5");
    expect(formatDecimal(0n, 18)).toBe("0");
    expect(formatDecimal(10n ** 18n, 18)).toBe("1");
  });
  it("rejects junk and over-precision", () => {
    expect(() => parseDecimal("1.1234567", 6)).toThrow();
    expect(() => parseDecimal("-1", 6)).toThrow();
    expect(() => parseDecimal("abc", 6)).toThrow();
  });
  it("rounds wei to uqor up", () => {
    expect(weiToUqorCeil(1n)).toBe(1n);
    expect(weiToUqorCeil(10n ** 12n)).toBe(1n);
    expect(weiToUqorCeil(10n ** 12n + 1n)).toBe(2n);
  });
});

describe("address lists", () => {
  it("splits on commas, spaces and newlines", () => {
    expect(splitList(`a, b\nc  d,,`)).toEqual(["a", "b", "c", "d"]);
    expect(splitList(undefined)).toEqual([]);
  });
  it("validates, checksums and rejects duplicates", () => {
    expect(parseAddressList(`${A},${B}`, "x", 5)).toHaveLength(2);
    expect(() => parseAddressList(`${A},${A.toUpperCase().replace("0X", "0x")}`, "x", 5)).toThrow(/duplicate/);
    expect(() => parseAddressList("0x123", "x", 5)).toThrow(/valid/);
    expect(() => parseAddressList(`${A},${B},${C}`, "x", 2)).toThrow(/at most/);
  });
});

describe("equalHeirs", () => {
  it("sums to 10000 with the remainder on the last heir", () => {
    const h = equalHeirs([A, B, C]);
    expect(h.map((x) => x.bps)).toEqual([3333, 3333, 3334]);
    expect(h.reduce((s, x) => s + x.bps, 0)).toBe(10000);
    expect(h[0].payoutTo).toBe(A);
  });
  it("single heir gets everything; 0 or 11 is refused", () => {
    expect(equalHeirs([A])[0].bps).toBe(10000);
    expect(() => equalHeirs([])).toThrow();
    const eleven = Array.from({ length: 11 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address);
    expect(() => equalHeirs(eleven)).toThrow();
  });
});

describe("windows", () => {
  const base: WindowView = {
    found: true,
    live: true,
    remainingBlocks: 500n,
    remainingTxs: 5n,
    remainingValue: 10n ** 9n,
    nativeOnly: false,
    allowedTargets: [],
  };
  it("budget is value plus gas*fee per tx", () => {
    // 3,000,000 gas * 250 gwei = 7.5e17 wei = 750000 uqor
    expect(windowBudget([{ gas: 3_000_000n }], 250_000_000_000n)).toBe(750_000n);
    expect(windowBudget([{ gas: 3_000_000n }, { gas: 3_000_000n, value: 10n ** 18n }], 250_000_000_000n)).toBe(
      750_000n + 750_000n + 1_000_000n,
    );
  });
  it("accepts a fitting window", () => {
    expect(windowSatisfies(base, { txs: 2n, value: 1000n })).toBe(true);
  });
  it("rejects dead, too small, native-only and short windows", () => {
    expect(windowSatisfies({ ...base, live: false }, { txs: 1n, value: 1n })).toBe(false);
    expect(windowSatisfies({ ...base, found: false }, { txs: 1n, value: 1n })).toBe(false);
    expect(windowSatisfies(base, { txs: 6n, value: 1n })).toBe(false);
    expect(windowSatisfies(base, { txs: 1n, value: 10n ** 10n })).toBe(false);
    expect(windowSatisfies({ ...base, nativeOnly: true }, { txs: 1n, value: 1n })).toBe(false);
    expect(windowSatisfies({ ...base, remainingBlocks: 5n }, { txs: 1n, value: 1n })).toBe(false);
  });
  it("contract creation needs an unscoped window", () => {
    expect(windowSatisfies(base, { txs: 1n, value: 1n, unscoped: true })).toBe(true);
    expect(windowSatisfies({ ...base, allowedTargets: [A] }, { txs: 1n, value: 1n, unscoped: true })).toBe(false);
  });
  it("scoped need: scoped window must cover every target (case-insensitive)", () => {
    const scoped = { ...base, allowedTargets: [A.toUpperCase().replace("0X", "0x"), B] };
    expect(windowSatisfies(scoped, { txs: 1n, value: 1n, targets: [A, B] })).toBe(true);
    expect(windowSatisfies(scoped, { txs: 1n, value: 1n, targets: [A, C] })).toBe(false);
    expect(windowSatisfies(base, { txs: 1n, value: 1n, targets: [A, C] })).toBe(true);
  });
});

describe("tokenCtorArgs", () => {
  const p = { name: "Q-Day Test USD", symbol: "qUSD", supply: 10n ** 24n, owner: A };
  it("maps the real TestToken constructor (name_, symbol_, recipient, supply)", () => {
    const args = tokenCtorArgs(
      [
        { name: "name_", type: "string" },
        { name: "symbol_", type: "string" },
        { name: "recipient", type: "address" },
        { name: "supply", type: "uint256" },
      ],
      p,
    );
    expect(args).toEqual(["Q-Day Test USD", "qUSD", A, 10n ** 24n]);
  });
  it("fails loudly on shapes it does not understand", () => {
    expect(() => tokenCtorArgs([{ name: "x", type: "bytes32" }], p)).toThrow(/not understood/);
    expect(() => tokenCtorArgs([{ name: "foo", type: "uint256" }], p)).toThrow(/not understood/);
  });
});

describe("keeper helpers", () => {
  it("only acts on overdue and triggered vaults", () => {
    expect(keeperAction(State.OVERDUE)).toBe("trigger");
    expect(keeperAction(State.TRIGGERED)).toBe("settle");
    for (const s of [State.NONE, State.ALIVE, State.WARNING, State.SETTLED, State.CLOSED]) {
      expect(keeperAction(s)).toBeNull();
    }
  });
  it("covers a block span with inclusive ranges", () => {
    expect(blockRanges(0n, 9n, 5n)).toEqual([[0n, 4n], [5n, 9n]]);
    expect(blockRanges(3n, 3n, 5n)).toEqual([[3n, 3n]]);
    expect(blockRanges(0n, 10n, 5n)).toEqual([[0n, 4n], [5n, 9n], [10n, 10n]]);
    expect(blockRanges(5n, 4n, 5n)).toEqual([]);
  });
});

describe("probe decoding", () => {
  it("classifies pqcVerify return data", () => {
    const t = `0x${"0".repeat(63)}1` as const;
    const f = `0x${"0".repeat(64)}` as const;
    expect(classifyVerifyReturn(t, false)).toBe("true");
    expect(classifyVerifyReturn(f, false)).toBe("false");
    expect(classifyVerifyReturn("0x", false)).toBe("empty");
    expect(classifyVerifyReturn(undefined, false)).toBe("empty");
    expect(classifyVerifyReturn(undefined, true)).toBe("reverted");
    expect(classifyVerifyReturn("0x01", false)).toBe("malformed");
    expect(classifyVerifyReturn(`0x${"0".repeat(62)}02` as const, false)).toBe("malformed");
  });
  it("decodes key status and flags empty / garbage", () => {
    const data = encodeFunctionResult({
      abi: PQC_KEY_STATUS_ABI,
      functionName: "pqcKeyStatus",
      result: [true, 1, `0x${"ab".repeat(2592)}`, true],
    });
    expect(decodeKeyStatus(data)).toMatchObject({ shape: 4, registered: true, algorithmId: 1, pubkeyLength: 2592, possessionProven: true });
    expect((data.length - 2) / 2).toBe(KEY_STATUS_BYTES_4);
    const data3 = encodeFunctionResult({
      abi: PQC_KEY_STATUS3_ABI,
      functionName: "pqcKeyStatus",
      result: [true, 1, `0x${"ab".repeat(2592)}`],
    });
    expect((data3.length - 2) / 2).toBe(KEY_STATUS_BYTES_3);
    expect(decodeKeyStatus(data3)).toMatchObject({ shape: 3, registered: true, pubkeyLength: 2592 });
    expect(decodeKeyStatus(data3)).not.toHaveProperty("possessionProven");
    expect(decodeKeyStatus("0x")).toBe("empty");
    expect(decodeKeyStatus(encodeAbiParameters([{ type: "address" }], [zeroAddress]))).toBe("malformed");
  });
  it("decodeKeyStatus reads an account with no key (the documented `false, 0, 0x, false` answer) in both shapes", () => {
    const none4 = encodeFunctionResult({ abi: PQC_KEY_STATUS_ABI, functionName: "pqcKeyStatus", result: [false, 0, "0x", false] });
    expect((none4.length - 2) / 2).toBe(160);
    expect(decodeKeyStatus(none4)).toMatchObject({ shape: 4, registered: false, algorithmId: 0, pubkeyLength: 0, possessionProven: false });
    const none3 = encodeFunctionResult({ abi: PQC_KEY_STATUS3_ABI, functionName: "pqcKeyStatus", result: [false, 0, "0x"] });
    expect((none3.length - 2) / 2).toBe(128);
    expect(decodeKeyStatus(none3)).toMatchObject({ shape: 3, registered: false, pubkeyLength: 0 });
  });
  it("decodeKeyStatus stays strict: trailing bytes, a short tail, an odd offset or an oversized length are malformed", () => {
    const good = encodeFunctionResult({ abi: PQC_KEY_STATUS_ABI, functionName: "pqcKeyStatus", result: [true, 1, `0x${"ab".repeat(2592)}`, true] });
    expect(decodeKeyStatus(`${good}${"00".repeat(32)}` as `0x${string}`)).toBe("malformed");
    expect(decodeKeyStatus(good.slice(0, good.length - 64) as `0x${string}`)).toBe("malformed");
    expect(decodeKeyStatus(`${good}00` as `0x${string}`)).toBe("malformed");
    const badOffset = `0x${good.slice(2, 2 + 128)}${"00".repeat(31)}a0${good.slice(2 + 192)}` as `0x${string}`;
    expect(decodeKeyStatus(badOffset)).toBe("malformed");
    const hugeLen = `0x${good.slice(2, 2 + 256)}${"ff".repeat(32)}${good.slice(2 + 320)}` as `0x${string}`;
    expect(decodeKeyStatus(hugeLen)).toBe("malformed");
  });
  it("tamper changes exactly one bit and copies", () => {
    const src = new Uint8Array(10);
    const t = tamper(src);
    expect(src[5]).toBe(0);
    expect(t[5]).toBe(1);
    expect(t.filter((b) => b !== 0)).toHaveLength(1);
  });
});

describe("key status assertions", () => {
  const pk = new Uint8Array(2592).fill(0xab);
  const mk = (over: object) => ({ shape: 4 as const, registered: true, algorithmId: 1, pubkey: `0x${"ab".repeat(2592)}` as const, pubkeyLength: 2592, possessionProven: true, ...over });
  it("accepts the right key in both shapes", () => {
    expect(assertKeyStatus(mk({}), pk, "t").shape).toBe(4);
    expect(assertKeyStatus(mk({ shape: 3, possessionProven: undefined }), pk, "t").shape).toBe(3);
  });
  it("rejects every deviation", () => {
    expect(() => assertKeyStatus("empty", pk, "t")).toThrow();
    expect(() => assertKeyStatus(mk({ registered: false }), pk, "t")).toThrow(/no ML-DSA/);
    expect(() => assertKeyStatus(mk({ algorithmId: 2 }), pk, "t")).toThrow(/algorithm/);
    expect(() => assertKeyStatus(mk({ pubkey: `0x${"cd".repeat(2592)}` }), pk, "t")).toThrow(/not the one/);
    expect(() => assertKeyStatus(mk({ possessionProven: false }), pk, "t")).toThrow(/possession/);
  });
});

describe("gas, clock and bounds helpers", () => {
  it("pickGas pads by 30% and refuses past the cap", () => {
    expect(pickGas(1000n, 2000n, "x")).toBe(1300n);
    expect(() => pickGas(2000n, 2000n, "x")).toThrow(/exceeds/);
  });
  it("drill window is Nov 18 UTC only", () => {
    expect(inDrillWindow(Date.parse("2026-11-17T23:59:59Z"))).toBe(false);
    expect(inDrillWindow(Date.parse("2026-11-18T00:00:00Z"))).toBe(true);
    expect(inDrillWindow(Date.parse("2026-11-18T23:59:59Z"))).toBe(true);
    expect(inDrillWindow(Date.parse("2026-11-19T00:00:00Z"))).toBe(false);
  });
  it("keeper pauses Nov 16 through Nov 18 UTC", () => {
    expect(keeperPaused(Date.parse("2026-11-15T23:59:00Z"))).toBe(false);
    expect(keeperPaused(Date.parse("2026-11-16T00:00:00Z"))).toBe(true);
    expect(keeperPaused(Date.parse("2026-11-18T12:00:00Z"))).toBe(true);
    expect(keeperPaused(Date.parse("2026-11-19T00:00:00Z"))).toBe(false);
  });
  it("parseBoundedInt validates", () => {
    expect(parseBoundedInt(undefined, 20, 1, 200, "k")).toBe(20);
    expect(parseBoundedInt("5", 20, 1, 200, "k")).toBe(5);
    expect(() => parseBoundedInt("0", 20, 1, 200, "k")).toThrow();
    expect(() => parseBoundedInt("x", 20, 1, 200, "k")).toThrow();
    expect(() => parseBoundedInt("1000", 20, 1, 200, "k")).toThrow();
  });
});

describe("vault checks and splits", () => {
  const facts = { owner: A, keyMode: 0, pubkeyHash: "0x00", interval: 604800n, grace: 2, bounty: 0n, heirs: [{ account: B, payoutTo: B, bps: 10000 }], tokens: [C] };
  it("diffVault is empty for identical vaults and names every mismatch", () => {
    expect(diffVault(facts, { ...facts, owner: A.toUpperCase().replace("0X", "0x") })).toEqual([]);
    const d = diffVault(facts, { ...facts, interval: 60n, bounty: 5n, heirs: [{ account: C, payoutTo: C, bps: 10000 }], tokens: [] });
    expect(d.map((x) => x.split(":")[0]).sort()).toEqual(["bounty", "heirs", "interval", "tokens"]);
  });
  it("splitDrillAmount puts 10% in ACCOUNT and the rest in DEVICE, losing nothing", () => {
    expect(splitDrillAmount(1000n, [0, 1], 1000)).toEqual([100n, 900n]);
    expect(splitDrillAmount(1001n, [0, 1], 1000)).toEqual([100n, 901n]);
    expect(splitDrillAmount(1000n, [1], 1000)).toEqual([1000n]);
    expect(splitDrillAmount(777n, [0, 1], 3333).reduce((a, b) => a + b)).toBe(777n);
  });
  it("assertFitsBlock", () => {
    expect(() => assertFitsBlock(9_000_000n, 30_000_000n, "x")).not.toThrow();
    expect(() => assertFitsBlock(9_000_000n, 8_000_000n, "settle")).toThrow(/block gas limit/);
  });
});

describe("isSequenceMismatch", () => {
  it("recognises the stale-sequence refusal in a message, a raw log or a nested cause", () => {
    expect(isSequenceMismatch(new Error("Broadcasting transaction failed with code 32 (codespace: sdk). Log: account sequence mismatch, expected 7, got 6: incorrect account sequence"))).toBe(true);
    expect(isSequenceMismatch(Object.assign(new Error("tx failed"), { rawLog: "account sequence mismatch, expected 2, got 1" }))).toBe(true);
    expect(isSequenceMismatch(new Error("outer", { cause: { log: "incorrect account sequence" } }))).toBe(true);
  });
  it("does not retry anything else", () => {
    expect(isSequenceMismatch(new Error("insufficient funds"))).toBe(false);
    expect(isSequenceMismatch(new Error("native tx ABC failed (code 5): out of gas"))).toBe(false);
    expect(isSequenceMismatch(undefined)).toBe(false);
    expect(isSequenceMismatch("account sequence mismatch")).toBe(false);
  });
});
