/**
 * Node-only helpers (fs, solc). Keep out of the browser bundle: sim/index.ts must never import this file.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Abi, Hex } from "viem";
import type { ContractArtifact } from "./chain.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Load a Hardhat artifact: artifacts/contracts/<file>.sol/<name>.json. */
export function loadArtifact(file: string, name = file): ContractArtifact {
  const p = resolve(ROOT, "artifacts", "contracts", `${file}.sol`, `${name}.json`);
  if (!existsSync(p)) throw new Error(`artifact not found: ${p} (run: npx hardhat build)`);
  const j = JSON.parse(readFileSync(p, "utf8")) as { abi: Abi; bytecode: Hex };
  return { abi: j.abi, bytecode: j.bytecode };
}

export const loadVaultArtifact = () => loadArtifact("QDMVault");
/** TestToken lives in contracts/mocks/ in the spec layout; fall back to the flat path. */
export function loadTokenArtifact(): ContractArtifact {
  for (const [file, name] of [
    ["mocks/TestToken", "TestToken"],
    ["TestToken", "TestToken"],
  ] as const) {
    try {
      return loadArtifact(file, name);
    } catch {
      /* try next */
    }
  }
  throw new Error("TestToken artifact not found");
}

/** Compile a single-file Solidity 0.8.28 source with the npm soljson (offline). */
export function compileSource(source: string, contractName: string): ContractArtifact {
  const require = createRequire(import.meta.url);
  const solc = require("solc");
  const input = {
    language: "Solidity",
    sources: { "Probe.sol": { content: source } },
    settings: { evmVersion: "cancun", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errs.length) throw new Error(errs.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n"));
  const c = out.contracts["Probe.sol"][contractName];
  return { abi: c.abi as Abi, bytecode: `0x${c.evm.bytecode.object}` as Hex };
}
