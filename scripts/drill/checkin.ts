/**
 * drill/checkin.ts - extra evidence on drill day: the relayer submits a checkIn that is authorised by the
 * DRILL account's ML-DSA-87 signature. The drill account itself sends nothing and never opens an EVM window.
 *
 * Env: DEPLOYER_MNEMONIC (relayer), DRILL_MNEMONIC (signs), QDMV_ADDRESS, TEST_TOKEN_ADDRESS, HEIR_ADDRESSES.
 */
import type { Address } from "viem";
import { KeyMode, QORE_TESTNET_CHAIN_ID, checkInDigest } from "../../lib/encoding.js";
import { pqSign } from "../../lib/pq.js";
import { closeWindowQuietly, ensureRegistered, ensureWindow, getWindow, loadArtifact, publicClient, walletFor, writeContract } from "../lib/chain.js";
import { resolveAddresses } from "../lib/deployments.js";
import { loadDeployer, loadDrill } from "../lib/net.js";
import { equalHeirs, parseAddressList } from "../lib/pure.js";
import { drillKeyArgs, drillModes, drillParams, drillVaultId, modeName } from "./common.js";

const GAS = 1_000_000n;

async function main(): Promise<void> {
  const env = process.env;
  const { vault, token } = resolveAddresses(env);
  const relayer = await loadDeployer();
  const drill = await loadDrill();
  const drillAddr = drill.evm as Address;
  const heirs = equalHeirs(parseAddressList(env.HEIR_ADDRESSES, "HEIR_ADDRESSES", 10));

  const dw = await getWindow(drill);
  if (dw.found && dw.live) throw new Error("The drill account has a LIVE EVM window; refusing to continue");

  const art = loadArtifact("QDMVault");
  const pub = publicClient();
  const reg = await ensureRegistered(relayer);
  if (reg) console.log(`relayer key registered: ${reg}`);
  const modes = drillModes(env);
  await ensureWindow(relayer, { txs: modes.map(() => ({ gas: GAS })), targets: [vault] });
  for (const mode of modes) {
    const { pkHash, pubkey } = drillKeyArgs(mode, drill.pqc.publicKey);
    const vaultId = drillVaultId(vault, drillAddr, drillParams(heirs, token), mode, pkHash);
    const v = (await pub.readContract({ address: vault, abi: art.abi, functionName: "getVault", args: [vaultId] } as never)) as { nonce: bigint | number };
    const nonce = BigInt(v.nonce);
    const expiry = (await pub.getBlock()).timestamp + 600n;
    const digest = checkInDigest({ chainId: QORE_TESTNET_CHAIN_ID, vault }, { vaultId, nonce, expiry });
    const sig = pqSign(digest, drill.pqc.secretKey);
    const auth = { nonce, expiry, sig: `0x${Buffer.from(sig).toString("hex")}`, pubkey: mode === KeyMode.ACCOUNT ? "0x" : pubkey };
    await writeContract(walletFor(relayer), pub, { address: vault, abi: art.abi, functionName: "checkIn", args: [vaultId, auth], gasCap: GAS });
    console.log(`checked in ${modeName(mode)} vault ${vaultId} with nonce ${nonce}, signed by the drill account's post-quantum key`);
  }
  await closeWindowQuietly(relayer);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
