/**
 * drill/proof-tx.ts - one normal transaction from the drill account for the "proof tx" requirement:
 * a native self-send of 1 uqor, hybrid-signed (secp256k1 + ML-DSA-87) via @qorechain/sdk. It is a native-lane
 * message, so it needs no EVM window. Prints its hash.
 *
 * The drill account is kept at ~0 QOR on purpose. Right before the self-send the relayer (deployer) sends it
 * exactly fee + 1 uqor; if the self-send fails it tops up once more and retries once.
 *
 * Must run DURING the drill (2026-11-18T00:00Z to 2026-11-19T00:00Z) unless --force.
 * Env: DRILL_MNEMONIC and DEPLOYER_MNEMONIC.   tsx scripts/drill/proof-tx.ts [--force]
 */
import { parseArgs } from "node:util";
import { bankSend, nativeBalanceUqor } from "../lib/chain.js";
import { NATIVE_FEE, explorerLinks, loadDeployer, loadDrill } from "../lib/net.js";
import { inDrillWindow } from "../lib/pure.js";

const NEEDED = BigInt(NATIVE_FEE.amount[0].amount) + 1n; // 100001

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { force: { type: "boolean", default: false } } });
  if (!values.force && !inDrillWindow(Date.now())) {
    throw new Error(
      "Outside the drill window (Wed 2026-11-18 00:00 to 23:59 UTC; Tue Nov 17 7:00 PM to Wed Nov 18 6:59 PM EST). " +
        "The proof transaction must be made during the drill. Use --force only to rehearse.",
    );
  }
  const drill = await loadDrill();
  const relayer = await loadDeployer();

  const topUp = async () => {
    const bal = await nativeBalanceUqor(drill.cosmos).catch(() => 0n);
    if (bal < NEEDED) {
      console.log(`top-up ${NEEDED - bal} uqor from the relayer: ${await bankSend(relayer, drill.cosmos, NEEDED - bal)}`);
    }
  };

  await topUp();
  let hash: string;
  try {
    hash = await bankSend(drill, drill.cosmos, 1n);
  } catch (e) {
    console.log(`self-send failed (${(e as Error).message}); topping up once and retrying`);
    await topUp();
    hash = await bankSend(drill, drill.cosmos, 1n);
  }
  console.log(`drill account: ${drill.cosmos}`);
  console.log(`PROOF TX HASH: ${hash}`);
  for (const l of explorerLinks("tx", hash)) console.log(l);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
