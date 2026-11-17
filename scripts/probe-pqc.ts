/**
 * probe-pqc.ts - read-only check of QoreChain's PQC precompiles. No funds, no keys, no secrets.
 *
 * Settles how QDMVault must hash: it generates a fresh ML-DSA-87 key, signs a 32-byte digest, and asks the
 * pqcVerify precompile (0x...0A01) over eth_call whether it verifies, together with negative controls and
 * alternative conventions (pre-hashed message, non-empty context). Prints a JSON verdict and exits non-zero
 * unless case (a) - the convention QDMVault uses - returns true.
 *
 *   tsx scripts/probe-pqc.ts [--out probe-result.json] [--address 0x..]
 *
 * --address also reports pqcKeyStatus for that account (e.g. the deployer, to see the return shape of a real key).
 * Exits 1 with "PRECOMPILE UNSAFE" if a tampered signature, wrong key or wrong message verifies as true.
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { isAddress, keccak256, sha256, type Address } from "viem";
import { bytesToHex, encodeFunctionData, hexToBytes, stringToBytes, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { PQC_KEY_STATUS_ADDRESS, PQC_VERIFY_ADDRESS } from "../lib/encoding.js";
import { publicClient } from "./lib/chain.js";
import { NET } from "./lib/net.js";
import {
  PQC_KEY_STATUS_ABI,
  PQC_VERIFY_ABI,
  classifyVerifyReturn,
  decodeKeyStatus,
  tamper,
  type PrecompileOutcome,
} from "./lib/pure.js";

const pub = publicClient();

async function rawCall(to: Hex, data: Hex): Promise<{ data?: Hex; reverted: boolean; error?: string }> {
  try {
    const r = await pub.call({ to, data, gas: 10_000_000n });
    return { data: r.data, reverted: false };
  } catch (e) {
    return { reverted: true, error: (e as Error).message.split("\n")[0] };
  }
}

async function verify(pk: Uint8Array, sig: Uint8Array, msg: Uint8Array): Promise<PrecompileOutcome> {
  const data = encodeFunctionData({
    abi: PQC_VERIFY_ABI,
    functionName: "pqcVerify",
    args: [bytesToHex(pk), bytesToHex(sig), bytesToHex(msg)],
  });
  const r = await rawCall(PQC_VERIFY_ADDRESS, data);
  return classifyVerifyReturn(r.data, r.reverted);
}

interface Case {
  id: string;
  description: string;
  expect: "true" | "not-true";
  outcome: PrecompileOutcome;
  ok: boolean;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: "string" }, address: { type: "string" } } });

  const probeAddr = values.address?.trim() || process.env.PROBE_ADDRESS?.trim();
  if (probeAddr && !isAddress(probeAddr)) throw new Error(`--address is not a valid 0x address: ${probeAddr}`);
  const chainId = await pub.getChainId();
  if (chainId !== NET.evmChainId) throw new Error(`RPC reports chain id ${chainId}, expected ${NET.evmChainId}`);
  const block = await pub.getBlockNumber();

  const kp = ml_dsa87.keygen();
  const other = ml_dsa87.keygen();
  // A realistic QDMV-style digest (32 bytes), but any 32 bytes would do.
  const digest = hexToBytes(keccak256(stringToBytes(`qdmv-probe-${Date.now()}`)));
  const sig = ml_dsa87.sign(digest, kp.secretKey); // empty context, raw message

  const cases: Case[] = [];
  const add = async (id: string, description: string, expect: Case["expect"], run: () => Promise<PrecompileOutcome>) => {
    const outcome = await run();
    cases.push({ id, description, expect, outcome, ok: expect === "true" ? outcome === "true" : outcome !== "true" });
  };

  await add("a", "valid signature over the raw 32-byte digest, empty context (QDMVault convention)", "true", () =>
    verify(kp.publicKey, sig, digest),
  );
  await add("b", "tampered signature", "not-true", () => verify(kp.publicKey, tamper(sig), digest));
  await add("c", "valid signature checked against a different public key", "not-true", () =>
    verify(other.publicKey, sig, digest),
  );
  await add("d", "valid signature but a different message", "not-true", () => verify(kp.publicKey, sig, tamper(digest)));

  // Informational alternatives: only meaningful when (a) fails, but cheap, so always recorded.
  const alternatives: Array<{ id: string; description: string; outcome: PrecompileOutcome }> = [];
  const alt = async (id: string, description: string, run: () => Promise<PrecompileOutcome>) =>
    alternatives.push({ id, description, outcome: await run() });

  const short = stringToBytes("qdmv probe message");
  await alt("e", "short raw ASCII message, empty context", () =>
    verify(kp.publicKey, ml_dsa87.sign(short, kp.secretKey), short),
  );
  const kdigest = hexToBytes(keccak256(digest));
  await alt("f", "signature over keccak256(digest), message passed as the digest (precompile hashing the input?)", () =>
    verify(kp.publicKey, ml_dsa87.sign(kdigest, kp.secretKey), digest),
  );
  const sdigest = hexToBytes(sha256(digest));
  await alt("g", "signature over sha256(digest), message passed as the digest", () =>
    verify(kp.publicKey, ml_dsa87.sign(sdigest, kp.secretKey), digest),
  );
  for (const ctx of ["QDMV1", "qorechain", "QoreChain", "pqc", "ML-DSA-87"]) {
    await alt(`ctx:${ctx}`, `signature over the digest with context "${ctx}"`, () =>
      verify(kp.publicKey, ml_dsa87.sign(digest, kp.secretKey, { context: stringToBytes(ctx) }), digest),
    );
  }
  await alt("internal", "ML-DSA internal sign (no FIPS 204 M' prefix) over the digest", () =>
    verify(kp.publicKey, ml_dsa87.internal.sign(digest, kp.secretKey), digest),
  );
  await alt("hashml-dsa-sha512", "HashML-DSA (SHA-512 prehash) signature over the digest", () =>
    verify(kp.publicKey, ml_dsa87.prehash(sha512).sign(digest, kp.secretKey), digest),
  );

  const restJson = async (path: string): Promise<unknown> => {
    try {
      const r = await fetch(`${NET.rest}${path}`);
      return r.ok ? await r.json() : { error: `HTTP ${r.status}` };
    } catch (e) {
      return { error: (e as Error).message };
    }
  };
  const evmLimits = await restJson("/qorechain/pqc/v1/evm_limits");
  const vmParams = await restJson("/cosmos/evm/vm/v1/params");

  // pqcKeyStatus for an address with no history.
  const fresh = privateKeyToAddress(generatePrivateKey());
  const ksData = encodeFunctionData({ abi: PQC_KEY_STATUS_ABI, functionName: "pqcKeyStatus", args: [fresh] });
  const ks = await rawCall(PQC_KEY_STATUS_ADDRESS, ksData);
  const keyStatus = ks.reverted ? { error: ks.error ?? "reverted" } : decodeKeyStatus(ks.data);

  let probedAccount: unknown;
  if (probeAddr) {
    const r = await rawCall(PQC_KEY_STATUS_ADDRESS, encodeFunctionData({ abi: PQC_KEY_STATUS_ABI, functionName: "pqcKeyStatus", args: [probeAddr as Address] }));
    probedAccount = { address: probeAddr, status: r.reverted ? { error: r.error } : decodeKeyStatus(r.data) };
  }

  const a = cases.find((c) => c.id === "a")!;
  const workingAlternative = alternatives.find((x) => x.outcome === "true");
  const verdict = {
    network: { chainId, expectedChainId: NET.evmChainId, block: block.toString(), rpc: NET.evmRpc },
    sizes: { publicKey: kp.publicKey.length, signature: sig.length, message: digest.length },
    cases,
    alternatives,
    pqcKeyStatusZeroHistory: keyStatus,
    ...(probedAccount ? { probedAccount } : {}),
    evmLimits,
    vmParams,
    precompileInactive: cases.every((c) => c.outcome === "empty"),
    conventionConfirmed: a.ok,
    recommendation: a.ok
      ? "QDMVault's convention is confirmed: sign the raw 32-byte digest with ML-DSA-87 (empty context) and pass the same 32 bytes as `message`."
      : workingAlternative
        ? `Case (a) failed but alternative ${workingAlternative.id} (${workingAlternative.description}) verified. The contract/signers must follow that convention; see docs/SPEC_CHANGES.md.`
        : "No convention verified. If every outcome is 'empty' the precompile is inactive on this endpoint; otherwise inspect outcomes and the RPC error output.",
    note: "empty return data from an inactive precompile is SUCCESS on mainnet; QDMVault must fail closed on it.",
  };

  // Negative controls must never verify: if they do, the precompile accepts forgeries.
  const unsafe = cases.filter((c) => c.expect === "not-true" && c.outcome === "true");

  const json = JSON.stringify(verdict, null, 2);
  console.log(json);
  if (values.out) writeFileSync(values.out, json + "\n");
  if (unsafe.length > 0) {
    console.error(`PRECOMPILE UNSAFE: negative control(s) ${unsafe.map((c) => c.id).join(", ")} verified as true. Do NOT deploy.`);
    process.exitCode = 1;
  } else if (!a.ok) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 2;
});
