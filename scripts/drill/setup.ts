/**
 * drill/setup.ts - prepare the Q-Day drill account and its vault.
 *
 * The drill account never opens an EVM window and never sends an EVM transaction. The deployer acts as relayer:
 *   1. fund the drill account with EXACTLY the native registration fee, so it ends with ~0 QOR;
 *   2. register the drill account's ML-DSA-87 key (classical-signed registration, with proof of possession);
 *   3. relay createVaultFor twice (DRILL_KEY_MODE=account|device|both, default both): an ACCOUNT-mode vault (key read
 *      from the chain registry) and a DEVICE-mode vault (drill key pinned), each authorised by the drill account's
 *      ML-DSA-87 signature, interval 7 days, bounty 0, no agent, heirs from HEIR_ADDRESSES;
 *   4. deposit test tokens and QOR into the vault from the relayer.
 * Idempotent: rerunning tops up what is missing. It prints the drill account's addresses only. The classical
 * private key is NEVER printed: export it from the wallet app that holds the same 12 words (see README).
 *
 * Env: DEPLOYER_MNEMONIC, DRILL_MNEMONIC, HEIR_ADDRESSES (comma separated, 1-10), QDMV_ADDRESS, TEST_TOKEN_ADDRESS.
 * Optional: DRILL_QOR (default 5), DRILL_TOKENS (default 1000), DRILL_KEY_MODE, DRILL_SALT,
 * DRILL_ACCOUNT_SHARE_BPS (default 1000: 10% of QOR and tokens in the ACCOUNT vault, 90% in the DEVICE vault).
 */
import { parseUnits, type Abi, type Address, type Hex } from "viem";
import { QORE_TESTNET_CHAIN_ID, createDigest } from "../../lib/encoding.js";
import { pqSign } from "../../lib/pq.js";
import {
  accountInfo,
  bankSend,
  closeWindow,
  closeWindowQuietly,
  ensureRegistered,
  ensureWindow,
  getWindow,
  loadArtifact,
  nativeBalanceUqor,
  pqcState,
  publicClient,
  verifyOnchainKey,
  walletFor,
  writeContract,
} from "../lib/chain.js";
import { DRILL_FILE, resolveAddresses, writeJson } from "../lib/deployments.js";
import { NATIVE_FEE, NET, loadDeployer, loadDrill } from "../lib/net.js";
import { diffVault, equalHeirs, formatDecimal, parseAddressList, parseBoundedInt, parseDecimal, splitDrillAmount } from "../lib/pure.js";
import { DRILL_GRACE, DRILL_INTERVAL, drillKeyArgs, drillModes, drillParams, drillVaultId, modeName, readVault } from "./common.js";

const GAS_CREATE = 3_000_000n;
const GAS_TOKEN = 400_000n;
const REG_FEE = BigInt(NATIVE_FEE.amount[0].amount);

const toHex = (b: Uint8Array): Hex => `0x${Buffer.from(b).toString("hex")}`;

async function main(): Promise<void> {
  const env = process.env;
  const { vault, token } = resolveAddresses(env);
  if (!token) throw new Error("No test token: set the variable TEST_TOKEN_ADDRESS (printed by the deploy workflow).");
  const heirAddrs = parseAddressList(env.HEIR_ADDRESSES, "HEIR_ADDRESSES", 10);
  const heirs = equalHeirs(heirAddrs);
  const qorWei = parseDecimal(env.DRILL_QOR || "5", 18);
  const tokenAmount = parseUnits(env.DRILL_TOKENS || "1000", 18);
  const modes = drillModes(env);

  const relayer = await loadDeployer();
  const drill = await loadDrill();
  const drillAddr = drill.evm as Address;
  if (relayer.evm.toLowerCase() === drill.evm.toLowerCase()) {
    throw new Error("DRILL_MNEMONIC must be a fresh account, different from the deployer");
  }
  for (const h of heirAddrs) {
    if (h.toLowerCase() === drillAddr.toLowerCase() || h.toLowerCase() === relayer.evm.toLowerCase()) {
      throw new Error(`HEIR_ADDRESSES must not include the drill account or the deployer (${h})`);
    }
  }
  console.log(`relayer (deployer): ${relayer.evm}`);
  console.log(`drill account:      ${drill.evm}  (${drill.cosmos})`);
  console.log(`vault:              ${vault}   key modes: ${modes.map(modeName).join(" + ")}`);

  // Freshness: a drill account must be new on testnet (unless this very key registered it) and unseen on mainnet.
  const mainnet = await accountInfo(NET.mainnetRest, drill.cosmos);
  if (mainnet.exists) throw new Error("The drill account already exists on MAINNET. Use a brand-new wallet.");
  const state = await pqcState(drill);
  const info = await accountInfo(NET.rest, drill.cosmos);
  const balance = await nativeBalanceUqor(drill.cosmos).catch(() => 0n);
  if (info.exists && state !== "registered-this-key" && !(info.sequence === 0n && balance <= REG_FEE)) {
    throw new Error("The drill account already has testnet history. Use a brand-new wallet.");
  }

  // 1-2. relayer registered; drill funded with exactly the registration fee and registered
  const regRelayer = await ensureRegistered(relayer);
  if (regRelayer) console.log(`relayer key registered: ${regRelayer}`);
  await verifyOnchainKey(relayer, "relayer");
  if (state !== "registered-this-key" && balance < REG_FEE) {
    console.log(`funding drill account with exactly the registration fee (${REG_FEE - balance} uqor): ${await bankSend(relayer, drill.cosmos, REG_FEE - balance)}`);
  }
  const regDrill = await ensureRegistered(drill);
  if (regDrill) console.log(`drill key registered: ${regDrill}`);
  const keyStatus = await verifyOnchainKey(drill, "drill account");
  if (keyStatus.possessionProven !== true && keyStatus.shape === 4) throw new Error("drill key possession not proven");

  // The drill account must never hold an EVM window.
  const dw = await getWindow(drill);
  if (dw.found && dw.live) {
    try {
      console.log(`closed drill window: ${await closeWindow(drill)}`);
    } catch (e) {
      console.log(`could not close the drill window automatically: ${(e as Error).message}`);
    }
    throw new Error("The drill account had a LIVE EVM window. That must never happen; investigate before continuing.");
  }

  // 3-4. vaults (one per key mode, the QOR and tokens split between them): create if missing, then top up
  const art = loadArtifact("QDMVault");
  const tokenArt = loadArtifact("TestToken");
  const pub = publicClient();
  const wallet = walletFor(relayer);
  const params = drillParams(heirs, token);
  const shareBps = parseBoundedInt(env.DRILL_ACCOUNT_SHARE_BPS, 1000, 1, 9999, "DRILL_ACCOUNT_SHARE_BPS");
  const qorSplit = splitDrillAmount(qorWei, modes, shareBps);
  const tokenSplit = splitDrillAmount(tokenAmount, modes, shareBps);

  const vaults = [];
  for (const [i, mode] of modes.entries()) {
    const qorEach = qorSplit[i];
    const tokenEach = tokenSplit[i];
    const { pkHash, pubkey } = drillKeyArgs(mode, drill.pqc.publicKey);
    const vaultId = drillVaultId(vault, drillAddr, params, mode, pkHash);
    const before = await readVault(pub, art.abi, vault, vaultId, token);
    const exists = before.status !== 0;
    if (exists) {
      // An existing vault must be exactly the one we intend, BEFORE anything is deposited into it.
      const read = (functionName: string, args: readonly unknown[]) => pub.readContract({ address: vault, abi: art.abi, functionName, args } as never);
      const got = (await read("getVault", [vaultId])) as Record<string, unknown>;
      const gotHeirs = (await read("getHeirs", [vaultId])) as Array<{ account: string; payoutTo: string; bps: number }>;
      const gotTokens = (await read("getTokens", [vaultId])) as string[];
      const problems = diffVault(
        { owner: drillAddr, keyMode: mode, pubkeyHash: pkHash, interval: params.interval, grace: params.grace, bounty: params.bounty, heirs: params.heirs, tokens: params.tokens },
        {
          owner: String(got.owner),
          keyMode: Number(got.keyMode),
          pubkeyHash: String(got.pubkeyHash),
          interval: BigInt(got.interval as bigint),
          grace: Number(got.grace),
          bounty: BigInt(got.bounty as bigint),
          heirs: gotHeirs.map((h) => ({ account: h.account, payoutTo: h.payoutTo, bps: Number(h.bps) })),
          tokens: gotTokens,
        },
      );
      if (problems.length > 0) {
        throw new Error(`Existing ${modeName(mode)} vault ${vaultId} does not match the intended parameters; nothing was deposited:\n  ${problems.join("\n  ")}`);
      }
    }
    const tokenNeed = before.token !== undefined && before.token < tokenEach ? tokenEach - before.token : 0n;
    vaults.push({ mode, pkHash, pubkey, vaultId, exists, tokenNeed, qorEach });
  }

  const plan = vaults.flatMap((v) => [
    ...(v.exists ? [] : [{ gas: GAS_CREATE, value: v.qorEach }]),
    ...(v.tokenNeed > 0n ? [{ gas: GAS_TOKEN }, { gas: GAS_TOKEN }] : []),
  ]);
  if (plan.length > 0) {
    await ensureWindow(relayer, { txs: plan, targets: [vault, token] });
    for (const v of vaults) {
      if (!v.exists) {
        const block = await pub.getBlock();
        const expiry = block.timestamp + 900n;
        const { digest } = createDigest({ chainId: QORE_TESTNET_CHAIN_ID, vault }, drillAddr, v.mode, v.pkHash, params, expiry);
        const sig = pqSign(digest, drill.pqc.secretKey);
        await writeContract(wallet, pub, {
          address: vault,
          abi: art.abi,
          functionName: "createVaultFor",
          args: [drillAddr, v.mode, params, expiry, toHex(sig), v.pubkey],
          value: v.qorEach,
          gasCap: GAS_CREATE,
        });
      }
      if (v.tokenNeed > 0n) {
        await writeContract(wallet, pub, {
          address: token,
          abi: tokenArt.abi as Abi,
          functionName: "approve",
          args: [vault, v.tokenNeed],
          gasCap: GAS_TOKEN,
        });
        await writeContract(wallet, pub, {
          address: vault,
          abi: art.abi,
          functionName: "depositToken",
          args: [v.vaultId, token, v.tokenNeed],
          gasCap: GAS_TOKEN,
        });
      }
    }
    await closeWindowQuietly(relayer);
  } else {
    console.log("vaults already exist and are fully funded; nothing to relay");
  }

  // record and report
  const records = [];
  for (const v of vaults) {
    const after = await readVault(pub, art.abi, vault, v.vaultId, token);
    records.push({
      mode: v.mode,
      vaultId: v.vaultId.toString(),
      before: { native: after.native.toString(), token: (after.token ?? 0n).toString() },
      after,
    });
  }
  writeJson(DRILL_FILE, {
    vault,
    token,
    drill: { evm: drill.evm, cosmos: drill.cosmos },
    heirs,
    intervalSeconds: DRILL_INTERVAL.toString(),
    grace: DRILL_GRACE,
    vaults: records.map(({ after: _a, ...r }) => r),
    createdAt: new Date().toISOString(),
  });

  for (const r of records) {
    console.log(`\n==== VAULT (${modeName(r.mode)}) ====`);
    console.log(`vaultId:   ${r.vaultId}`);
    console.log(`state:     ${r.after.state} (1 = ALIVE)   status ${r.after.status}`);
    console.log(`native:    ${formatDecimal(r.after.native, 18)} QOR`);
    console.log(`token:     ${formatDecimal(r.after.token ?? 0n, 18)} qUSD`);
  }
  console.log(`drill account EVM window: none (good: the drill account never opens one)`);

  console.log("\n==== DRILL ACCOUNT (check the 0x address matches the wallet app) ====");
  console.log(`Drill account (0x):          ${drill.evm}`);
  console.log(`Drill account (qor1):        ${drill.cosmos}`);
  console.log(`Contract 1 (QDMVault):       ${vault}`);
  console.log(`Contract 2 (Q-Day Test USD): ${token}`);
  console.log(`\nSet the repository variable DRILL_ADDRESS=${drill.evm}`);
  console.log("The classical private key is not printed here. Export it from the wallet app (see scripts/README.md).");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
