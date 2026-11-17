import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isAddress, type Address } from "viem";

export interface Deployments {
  network: "qorechain-diana";
  evmChainId: number;
  deployer: Address;
  deployedAt: string;
  vault: { address: Address; txHash: string; block: string };
  testToken?: { address: Address; txHash: string; block: string; name: string; symbol: string };
}

export const DEPLOYMENTS_FILE = "deployments/testnet.json";
export const DRILL_FILE = "deployments/drill.json";

export function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

export function readJson<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
}

function addr(v: string | undefined, label: string): Address | undefined {
  const t = v?.trim();
  if (!t) return undefined;
  if (!isAddress(t)) throw new Error(`${label} is not a valid 0x address: ${t}`);
  return t;
}

/** Vault and token addresses: env (QDMV_ADDRESS, TEST_TOKEN_ADDRESS) win over deployments/testnet.json. */
export function resolveAddresses(env: NodeJS.ProcessEnv): { vault: Address; token?: Address; fromBlock?: bigint } {
  const file = readJson<Deployments>(DEPLOYMENTS_FILE);
  const vault = addr(env.QDMV_ADDRESS, "QDMV_ADDRESS") ?? file?.vault.address;
  if (!vault) {
    throw new Error("No vault address: set the repository variable QDMV_ADDRESS (printed by the deploy workflow).");
  }
  const token = addr(env.TEST_TOKEN_ADDRESS, "TEST_TOKEN_ADDRESS") ?? file?.testToken?.address;
  const fb = env.QDMV_FROM_BLOCK?.trim();
  const fromBlock = fb ? BigInt(fb) : file ? BigInt(file.vault.block) : undefined;
  return { vault, token, fromBlock };
}
