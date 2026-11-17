/**
 * deploy.ts - deploy QDMVault (and the "Q-Day Test USD" TestToken for the drill) to QoreChain testnet.
 *
 * Needs DEPLOYER_MNEMONIC and funded QOR. Run `npm run build` first (reads the Hardhat artifacts).
 * Steps: register the deployer's ML-DSA-87 key if needed -> make sure an UNSCOPED EVM window exists
 * (contract creation is refused in a scoped window) -> deploy -> sanity-check -> write deployments/testnet.json.
 *
 * Refuses when QDMV_ADDRESS already has code (a deployment exists) unless --force.
 *
 *   tsx scripts/deploy.ts [--no-token] [--force]
 */
import { parseArgs } from "node:util";
import { evmToQor } from "@qorechain/sdk";
import { parseUnits, type Address } from "viem";
import {
  closeWindowQuietly,
  deployContract,
  ensureRegistered,
  ensureWindow,
  loadArtifact,
  nativeBalanceUqor,
  publicClient,
  verifyOnchainKey,
  walletFor,
} from "./lib/chain.js";
import { DEPLOYMENTS_FILE, writeJson, type Deployments } from "./lib/deployments.js";
import { NET, loadDeployer } from "./lib/net.js";
import { tokenCtorArgs } from "./lib/pure.js";
import { TAG } from "../lib/encoding.js";

const VAULT_GAS_CAP = 7_000_000n;
const TOKEN_GAS_CAP = 2_000_000n;
const TOKEN_NAME = "Q-Day Test USD";
const TOKEN_SYMBOL = "qUSD";
const TOKEN_SUPPLY = parseUnits("1000000", 18);

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { "no-token": { type: "boolean", default: false }, force: { type: "boolean", default: false } } });
  const acc = await loadDeployer();
  console.log(`deployer: ${acc.evm}  (${acc.cosmos})`);
  console.log(`balance:  ${await nativeBalanceUqor(acc.cosmos)} uqor`);

  const pub = publicClient();
  const existing = process.env.QDMV_ADDRESS?.trim();
  if (existing && !values.force) {
    const code = await pub.getCode({ address: existing as Address });
    if (code && code !== "0x") {
      throw new Error(`QDMV_ADDRESS ${existing} already has code: a vault is deployed. Pass --force to deploy a new one anyway.`);
    }
  }

  const vaultArt = loadArtifact("QDMVault");
  const tokenArt = values["no-token"] ? null : loadArtifact("TestToken");

  const reg = await ensureRegistered(acc);
  if (reg) console.log(`registered ML-DSA-87 key: ${reg}`);
  await verifyOnchainKey(acc, "deployer");

  const plan = [{ gas: VAULT_GAS_CAP }, ...(tokenArt ? [{ gas: TOKEN_GAS_CAP }] : [])];
  await ensureWindow(acc, { txs: plan, unscoped: true });

  const wallet = walletFor(acc);

  const vault = await deployContract(wallet, pub, {
    abi: vaultArt.abi,
    bytecode: vaultArt.bytecode,
    gasCap: VAULT_GAS_CAP,
    label: "QDMVault",
  });
  const tag = (await pub.readContract({ address: vault.address, abi: vaultArt.abi, functionName: "TAG" })) as string;
  if (tag.toLowerCase() !== TAG.toLowerCase()) throw new Error(`QDMVault.TAG() mismatch: ${tag} != ${TAG}`);

  const base = {
    network: NET.chainId,
    evmChainId: NET.evmChainId,
    deployer: acc.evm as `0x${string}`,
    deployedAt: new Date().toISOString(),
    vault: { address: vault.address, txHash: vault.hash, block: vault.block.toString() },
  } satisfies Deployments;
  writeJson(DEPLOYMENTS_FILE, base); // keep the vault address even if the token step fails
  console.log(`QDMVault deployed at ${vault.address}; wrote ${DEPLOYMENTS_FILE}`);

  let token: Deployments["testToken"];
  if (tokenArt) {
    const ctor = tokenArt.abi.find((x) => x.type === "constructor");
    const args = tokenCtorArgs(ctor && "inputs" in ctor ? ctor.inputs : [], {
      name: TOKEN_NAME,
      symbol: TOKEN_SYMBOL,
      supply: TOKEN_SUPPLY,
      owner: acc.evm as `0x${string}`,
    });
    const t = await deployContract(wallet, pub, {
      abi: tokenArt.abi,
      bytecode: tokenArt.bytecode,
      args,
      gasCap: TOKEN_GAS_CAP,
      label: TOKEN_NAME,
    });
    token = { address: t.address, txHash: t.hash, block: t.block.toString(), name: TOKEN_NAME, symbol: TOKEN_SYMBOL };
  }

  const out: Deployments = { ...base, ...(token ? { testToken: token } : {}) };
  writeJson(DEPLOYMENTS_FILE, out);
  await closeWindowQuietly(acc);

  console.log("\n==== DEPLOYED ====");
  console.log(`QDMVault:   ${vault.address}   (tx ${vault.hash}, block ${vault.block})`);
  if (token) console.log(`${TOKEN_NAME}: ${token.address}   (tx ${token.txHash}, block ${token.block})`);
  console.log(`\nSet these repository VARIABLES (Settings > Secrets and variables > Actions > Variables):`);
  console.log(`  QDMV_ADDRESS=${vault.address}`);
  if (token) console.log(`  TEST_TOKEN_ADDRESS=${token.address}`);
  console.log(`  QDMV_FROM_BLOCK=${vault.block}`);
  console.log(`\nSame contracts in qor1 form (the project form asks for a qor1 testnet address):`);
  console.log(`  QDMVault:   ${evmToQor(vault.address)}`);
  if (token) console.log(`  ${TOKEN_NAME}: ${evmToQor(token.address)}`);
  console.log(`\nwrote ${DEPLOYMENTS_FILE}`);
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
