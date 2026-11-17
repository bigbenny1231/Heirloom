/**
 * drill/verify.ts - read-only: compare the drill vault's balances now with what setup recorded
 * (deployments/drill.json, or DRILL_QOR / DRILL_TOKENS defaults when the file is absent).
 * Exits 1 if the vault lost value, left the ALIVE state, or the drill account holds a live EVM window.
 *
 * Env: DRILL_ADDRESS (variable; or DRILL_MNEMONIC to derive it), QDMV_ADDRESS, TEST_TOKEN_ADDRESS, HEIR_ADDRESSES.
 */
import { evmToQor } from "@qorechain/sdk";
import { getAddress, isAddress, parseUnits, type Address } from "viem";
import { evmBalanceUqor, getWindowAt, loadArtifact, nativeBalanceUqor, publicClient } from "../lib/chain.js";
import { DRILL_FILE, readJson, resolveAddresses } from "../lib/deployments.js";
import { loadDrill } from "../lib/net.js";
import { equalHeirs, formatDecimal, parseAddressList, parseBoundedInt, parseDecimal, splitDrillAmount } from "../lib/pure.js";
import { drillKeyArgs, drillModes, drillParams, drillVaultId, modeName, readVault } from "./common.js";

interface DrillRecord {
  vaults: Array<{ mode: number; vaultId: string; before: { native: string; token: string } }>;
}

async function main(): Promise<void> {
  const env = process.env;
  const { vault, token } = resolveAddresses(env);
  const given = env.DRILL_ADDRESS?.trim();
  if (given && !isAddress(given)) throw new Error("DRILL_ADDRESS is not a valid 0x address");
  // Load the drill account whenever its phrase is available (needed to recompute the DEVICE vault id);
  // DRILL_ADDRESS alone is enough for ACCOUNT mode or when drill.json is present.
  const drill = env.DRILL_MNEMONIC?.trim() || !given ? await loadDrill() : null;
  if (drill && given && getAddress(given) !== getAddress(drill.evm)) {
    throw new Error(`DRILL_ADDRESS ${given} does not match the account from DRILL_MNEMONIC (${drill.evm})`);
  }
  const drillAddr = (drill ? drill.evm : getAddress(given!)) as Address;
  const drillCosmos = drill ? drill.cosmos : evmToQor(drillAddr);
  const rec = readJson<DrillRecord>(DRILL_FILE);

  const modes = drillModes(env);
  const targets: Array<{ mode: number; vaultId: bigint; native: bigint; token: bigint }> = [];
  if (rec) {
    for (const r of rec.vaults) targets.push({ mode: r.mode, vaultId: BigInt(r.vaultId), native: BigInt(r.before.native), token: BigInt(r.before.token) });
  } else {
    if (!drill && modes.some((m) => m !== 0)) throw new Error("DEVICE-mode verification without drill.json needs DRILL_MNEMONIC");
    const heirs = equalHeirs(parseAddressList(env.HEIR_ADDRESSES, "HEIR_ADDRESSES", 10));
    const bps = parseBoundedInt(env.DRILL_ACCOUNT_SHARE_BPS, 1000, 1, 9999, "DRILL_ACCOUNT_SHARE_BPS");
    const qorSplit = splitDrillAmount(parseDecimal(env.DRILL_QOR || "5", 18), modes, bps);
    const tokSplit = splitDrillAmount(parseUnits(env.DRILL_TOKENS || "1000", 18), modes, bps);
    for (const [i, mode] of modes.entries()) {
      const { pkHash } = drillKeyArgs(mode, drill ? drill.pqc.publicKey : new Uint8Array(2592));
      targets.push({
        mode,
        vaultId: drillVaultId(vault, drillAddr, drillParams(heirs, token), mode, pkHash),
        native: qorSplit[i],
        token: tokSplit[i],
      });
    }
  }

  const art = loadArtifact("QDMVault");
  let kept = true;
  for (const t of targets) {
    const snap = await readVault(publicClient(), art.abi, vault, t.vaultId, token);
    const row = (label: string, was: bigint, now: bigint) =>
      console.log(`${label.padEnd(8)} before ${formatDecimal(was, 18).padStart(12)}   now ${formatDecimal(now, 18).padStart(12)}   ${now >= was ? "KEPT" : "LOST"}`);
    console.log(`\n${modeName(t.mode)} vault ${t.vaultId}  status ${snap.status}  state ${snap.state} (1 = ALIVE)`);
    row("QOR", t.native, snap.native);
    row("qUSD", t.token, snap.token ?? 0n);
    if (!(snap.native >= t.native && (snap.token ?? 0n) >= t.token && snap.state === 1)) kept = false;
  }

  const win = await getWindowAt(drillCosmos);
  console.log(
    `drill account: native ${await nativeBalanceUqor(drillCosmos).catch(() => 0n)} uqor, EVM view ${await evmBalanceUqor(drillAddr)} uqor, window ${win.found ? (win.live ? "LIVE" : "closed/expired") : "never opened"}`,
  );
  if (win.found && win.live) console.log("WARNING: the drill account has a LIVE EVM window. It must never open one.");

  if (win.found && win.live) kept = false;
  console.log(kept ? "\nRESULT: all vault value kept." : "\nRESULT: vault value changed, a vault is no longer ALIVE, or a drill window is live - investigate.");
  if (!kept) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
