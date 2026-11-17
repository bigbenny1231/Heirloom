import { describe, expect, it } from "vitest";
import { accountFromEnv, DEPLOYER_SPEC, DRILL_SPEC, NET, requireEnv } from "./net.js";

// Well-known public test mnemonic: derivation is offline and deterministic.
const MNEMONIC = "test test test test test test test test test test test junk";

describe("account loading", () => {
  it("derives a unified account offline from DEPLOYER_MNEMONIC", async () => {
    const acc = await accountFromEnv({ DEPLOYER_MNEMONIC: MNEMONIC }, DEPLOYER_SPEC);
    expect(acc.evm).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"); // BIP-44 m/44'/60'/0'/0/0
    expect(acc.cosmos.startsWith("qor1")).toBe(true);
    expect(acc.pqc.publicKey).toHaveLength(2592);
    expect(acc.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    // a phone paste (capitals, numbering, line breaks, commas) derives the same account
    const pasted = "1. Test\n2. test,  3) TEST test test\ttest test test test test test Junk\n";
    expect((await accountFromEnv({ DEPLOYER_MNEMONIC: pasted }, DEPLOYER_SPEC)).evm).toBe(acc.evm);
    // a wrong word fails with a clear message that does not echo the words
    const bad = accountFromEnv({ DEPLOYER_MNEMONIC: MNEMONIC.replace("junk", "jank") }, DEPLOYER_SPEC);
    await expect(bad).rejects.toThrow(/DEPLOYER_MNEMONIC is not a valid recovery phrase \(found 12 words/);
    await expect(accountFromEnv({ DEPLOYER_MNEMONIC: MNEMONIC.replace("junk", "jank") }, DEPLOYER_SPEC)).rejects.not.toThrow(/jank|test test/);
  });
  it("is deterministic and prefers DEPLOYER_MNEMONIC over the fallback", async () => {
    const a = await accountFromEnv({ DEPLOYER_MNEMONIC: MNEMONIC, QORE_MNEMONIC: "x" }, DEPLOYER_SPEC);
    const b = await accountFromEnv({ QORE_MNEMONIC: MNEMONIC }, DEPLOYER_SPEC);
    expect(a.evm).toBe(b.evm);
    expect(Buffer.from(a.pqc.publicKey).equals(Buffer.from(b.pqc.publicKey))).toBe(true);
  });
  it("the drill account only comes from DRILL_MNEMONIC", async () => {
    await expect(accountFromEnv({ DEPLOYER_MNEMONIC: MNEMONIC }, DRILL_SPEC)).rejects.toThrow(/DRILL_MNEMONIC/);
  });
  it("rejects a malformed private key and a missing recovery code", async () => {
    await expect(accountFromEnv({ PRIVATE_KEY: "0x12" }, DEPLOYER_SPEC)).rejects.toThrow(/64 hex/);
    await expect(accountFromEnv({ PRIVATE_KEY: `0x${"11".repeat(32)}` }, DEPLOYER_SPEC)).rejects.toThrow(/RECOVERY_CODE/);
  });
  it("requireEnv explains where to set a missing value", () => {
    expect(() => requireEnv({}, "FOO")).toThrow(/FOO/);
    expect(requireEnv({ FOO: " x " }, "FOO")).toBe("x");
  });
  it("network constants match the docs", () => {
    expect(NET.evmChainId).toBe(9800);
    expect(NET.chainId).toBe("qorechain-diana");
    expect(NET.evmRpc).toBe("https://evm-testnet.qore.host");
  });
});
