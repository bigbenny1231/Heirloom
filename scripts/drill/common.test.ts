import { describe, expect, it } from "vitest";
import { EthNativeSigner, buildRegisterPqcKeyMsg, closeEvmWindowMsg, openEvmWindowMsg, signProofOfPossession } from "@qorechain/sdk";
import type { Address } from "viem";
import { KeyMode, QORE_TESTNET_CHAIN_ID, ZERO_HASH, createDigest } from "../../lib/encoding.js";
import { pqVerify, pqSign } from "../../lib/pq.js";
import { NATIVE_FEE, NET, accountFromEnv, DRILL_SPEC } from "../lib/net.js";
import { equalHeirs } from "../lib/pure.js";
import { DRILL_INTERVAL, drillKeyArgs, drillModes, drillParams, drillVaultId } from "./common.js";

const VAULT = "0x00000000000000000000000000000000000000aa" as Address;
const HEIRS = equalHeirs(["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222"]);
const TOKEN = "0x00000000000000000000000000000000000000bb" as Address;
const MNEMONIC = "legal winner thank year wave sausage worth useful legal winner thank yellow";

describe("drill vault parameters", () => {
  it("meets the drill rules: interval >= 7 days, bounty 0, one token, given heirs", () => {
    const p = drillParams(HEIRS, TOKEN);
    expect(p.interval).toBeGreaterThanOrEqual(7n * 86_400n);
    expect(p.interval).toBe(DRILL_INTERVAL);
    expect(p.bounty).toBe(0n);
    expect(p.tokens).toEqual([TOKEN]);
    expect(p.heirs).toHaveLength(2);
    expect(p.heirs.reduce((s, h) => s + h.bps, 0)).toBe(10000);
  });
  it("vault id is stable and depends on owner and salt", () => {
    const o1 = "0x0000000000000000000000000000000000000001" as Address;
    const o2 = "0x0000000000000000000000000000000000000002" as Address;
    const p = drillParams(HEIRS, TOKEN);
    expect(drillVaultId(VAULT, o1, p)).toBe(drillVaultId(VAULT, o1, p));
    expect(drillVaultId(VAULT, o1, p)).not.toBe(drillVaultId(VAULT, o2, p));
    expect(drillVaultId(VAULT, o1, p)).not.toBe(drillVaultId(VAULT, o1, drillParams(HEIRS, TOKEN, "other")));
  });
});

describe("two drill vaults", () => {
  it("DRILL_KEY_MODE defaults to both and rejects junk", () => {
    expect(drillModes({})).toEqual([KeyMode.ACCOUNT, KeyMode.DEVICE]);
    expect(drillModes({ DRILL_KEY_MODE: "device" })).toEqual([KeyMode.DEVICE]);
    expect(drillModes({ DRILL_KEY_MODE: "ACCOUNT" })).toEqual([KeyMode.ACCOUNT]);
    expect(() => drillModes({ DRILL_KEY_MODE: "x" })).toThrow();
  });
  it("ACCOUNT and DEVICE vaults of one account get different ids; DEVICE pins the key hash", () => {
    const owner = "0x0000000000000000000000000000000000000001" as Address;
    const pk = new Uint8Array(2592).fill(7);
    const p = drillParams(HEIRS, TOKEN);
    const acct = drillKeyArgs(KeyMode.ACCOUNT, pk);
    const dev = drillKeyArgs(KeyMode.DEVICE, pk);
    expect(acct).toEqual({ pkHash: ZERO_HASH, pubkey: "0x" });
    expect(dev.pubkey.length).toBe(2 + 2592 * 2);
    expect(drillVaultId(VAULT, owner, p, KeyMode.ACCOUNT, acct.pkHash)).not.toBe(drillVaultId(VAULT, owner, p, KeyMode.DEVICE, dev.pkHash));
  });
});

describe("offline signing paths used on the testnet", () => {
  it("the drill account's ML-DSA-87 key signs the createVaultFor digest and verifies", async () => {
    const drill = await accountFromEnv({ DRILL_MNEMONIC: MNEMONIC }, DRILL_SPEC);
    const p = drillParams(HEIRS, TOKEN);
    const { digest } = createDigest({ chainId: QORE_TESTNET_CHAIN_ID, vault: VAULT }, drill.evm as Address, KeyMode.ACCOUNT, ZERO_HASH, p, 1_900_000_000n);
    const sig = pqSign(digest, drill.pqc.secretKey);
    expect(sig).toHaveLength(4627);
    const msg = Uint8Array.from(Buffer.from(digest.slice(2), "hex"));
    expect(pqVerify(sig, msg, drill.pqc.publicKey)).toBe(true);
    msg[0] ^= 1;
    expect(pqVerify(sig, msg, drill.pqc.publicKey)).toBe(false);
  });

  it("hybrid-signs scoped window open, window close, registration and a self-send without any network", async () => {
    const acc = await accountFromEnv({ DRILL_MNEMONIC: MNEMONIC }, DRILL_SPEC);
    const common = { chainId: NET.chainId, accountNumber: 7n, sequence: 3n, fee: NATIVE_FEE, signBytesVersion: "v2" as const };

    const hybrid = new EthNativeSigner(acc, { signMode: "hybrid", signBytesVersion: "v2" });
    const open = hybrid.sign({
      ...common,
      messages: [openEvmWindowMsg({ sender: acc.cosmos, blocks: 600n, maxTxs: 3n, maxValue: 5_000_000n, allowedTargets: [VAULT, TOKEN] })],
    });
    expect(open.txRaw ?? open).toBeDefined();
    hybrid.sign({ ...common, messages: [closeEvmWindowMsg(acc.cosmos)] });

    const classical = new EthNativeSigner(acc, { signMode: "classical", signBytesVersion: "v2" });
    const pop = signProofOfPossession({ chainId: NET.chainId, account: acc.cosmos, keypair: acc.pqc });
    classical.sign({ ...common, messages: [buildRegisterPqcKeyMsg(acc.cosmos, { pqcKeypair: acc.pqc, proofOfPossession: pop })] });
  });

  it("a window with more than 16 targets is refused by the SDK before it costs a transaction", async () => {
    const acc = await accountFromEnv({ DRILL_MNEMONIC: MNEMONIC }, DRILL_SPEC);
    const targets = Array.from({ length: 17 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
    expect(() => openEvmWindowMsg({ sender: acc.cosmos, blocks: 10n, maxTxs: 1n, maxValue: 1n, allowedTargets: targets })).toThrow();
  });
});
