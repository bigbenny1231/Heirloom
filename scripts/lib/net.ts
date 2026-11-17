/**
 * QoreChain testnet constants and account loading. Accounts are unified: one secp256k1 key gives the
 * 0x and qor1 addresses, and a deterministic ML-DSA-87 key (from the mnemonic, or from a recovery code
 * when only a private key is available) is the second half of every hybrid signature.
 */
import {
  deriveUnifiedAccount,
  isValidRecoveryCode,
  unifiedAccountFromSeed,
  type UnifiedAccount,
} from "@qorechain/sdk";

export const NET = {
  /** Cosmos chain id. */
  chainId: "qorechain-diana",
  /** EIP-155 chain id. */
  evmChainId: 9800,
  evmRpc: "https://evm-testnet.qore.host",
  rest: "https://api-testnet.qore.host",
  /** Mainnet REST: only used to prove the drill account has no mainnet history. */
  mainnetRest: "https://api.qore.host",
  rpc: "https://rpc-testnet.qore.host",
  denom: "uqor",
} as const;

/** EVM fee cap used for every script transaction; window budgets are sized from it. */
export const MAX_FEE_PER_GAS = 250_000_000_000n;
export const MAX_PRIORITY_FEE_PER_GAS = 1_000_000_000n;
/** A native-lane fee: hybrid transactions are large, so the gas limit is generous (as in the official template). */
export const NATIVE_FEE = { amount: [{ denom: NET.denom, amount: "100000" }], gas: "800000" };

export function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`Missing ${name}. Add it as a GitHub Actions secret or variable (see scripts/README.md).`);
  return v;
}

export interface AccountSpec {
  /** Env var holding the BIP-39 mnemonic (BIP-44 m/44'/60'/0'/0/0). */
  mnemonicVar: string;
  /** Optional fallbacks, same shape as the official template. */
  fallbackMnemonicVar?: string;
  privateKeyVar?: string;
  recoveryCodeVar?: string;
}

export const DEPLOYER_SPEC: AccountSpec = {
  mnemonicVar: "DEPLOYER_MNEMONIC",
  fallbackMnemonicVar: "QORE_MNEMONIC",
  privateKeyVar: "PRIVATE_KEY",
  recoveryCodeVar: "QORE_PQC_RECOVERY_CODE",
};

export const DRILL_SPEC: AccountSpec = { mnemonicVar: "DRILL_MNEMONIC" };

/**
 * Recovery phrases pasted on a phone often arrive with capitals, line breaks, double spaces, commas or "1." numbering.
 * Normalise to lowercase words separated by single spaces. Never logs the words.
 */
export function normalizeMnemonic(raw: string): string {
  return raw
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[,;|"'`]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^\d+[.):-]?/, ""))
    .filter((w) => w.length > 0)
    .join(" ");
}

export async function accountFromEnv(env: NodeJS.ProcessEnv, spec: AccountSpec): Promise<UnifiedAccount> {
  const varName = env[spec.mnemonicVar]?.trim() ? spec.mnemonicVar : spec.fallbackMnemonicVar;
  const raw = env[spec.mnemonicVar]?.trim() || (spec.fallbackMnemonicVar ? env[spec.fallbackMnemonicVar]?.trim() : "");
  if (raw) {
    const mnemonic = normalizeMnemonic(raw);
    const n = mnemonic.split(" ").length;
    try {
      return await deriveUnifiedAccount(mnemonic, 0);
    } catch {
      throw new Error(
        `${varName} is not a valid recovery phrase (found ${n} words; expected 12 or 24). ` +
          "Re-enter the secret with the words exactly as MetaMask shows them, separated by spaces. Check each word's spelling.",
      );
    }
  }

  const key = spec.privateKeyVar ? env[spec.privateKeyVar]?.trim() : undefined;
  if (key) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${spec.privateKeyVar} must be 0x followed by 64 hex characters`);
    const code = spec.recoveryCodeVar ? env[spec.recoveryCodeVar]?.trim() : undefined;
    if (!code) throw new Error(`${spec.recoveryCodeVar} is required together with ${spec.privateKeyVar}`);
    if (!isValidRecoveryCode(code)) throw new Error(`${spec.recoveryCodeVar} is not a valid QRC1 recovery code`);
    return unifiedAccountFromSeed(Uint8Array.from(Buffer.from(key.slice(2), "hex")), { recoveryCode: code });
  }
  throw new Error(`Set ${spec.mnemonicVar} (a secret) to load this account. See scripts/README.md.`);
}

export const loadDeployer = () => accountFromEnv(process.env, DEPLOYER_SPEC);
export const loadDrill = () => accountFromEnv(process.env, DRILL_SPEC);

export function explorerLinks(kind: "tx" | "address", id: string): string[] {
  const out: string[] = [];
  const base = process.env.EXPLORER_URL?.trim().replace(/\/$/, "");
  if (base) out.push(`${base}/${kind === "tx" ? "tx" : "address"}/${id}`);
  return out;
}
