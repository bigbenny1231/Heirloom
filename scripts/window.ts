/**
 * window.ts - status | register | open | close for the EVM authorisation window.
 *
 *   tsx scripts/window.ts status   [--account deployer|drill]
 *   tsx scripts/window.ts register [--account ...]
 *   tsx scripts/window.ts open     [--targets 0x..,0x..] [--blocks N] [--txs N] [--value uqor] [--native-only]
 *   tsx scripts/window.ts close
 *
 * With --targets the window is scoped (allowed_targets, at most 16): only those contracts can be called and
 * contract creation is refused. Without it the window is unscoped, which deploys need.
 */
import { parseArgs } from "node:util";
import { evmWindowCost, MAX_EVM_WINDOW_BLOCKS, MAX_EVM_WINDOW_TARGETS, MAX_EVM_WINDOW_TXS } from "@qorechain/evm";
import type { UnifiedAccount } from "@qorechain/sdk";
import {
  closeWindow,
  ensureRegistered,
  getWindow,
  nativeBalanceUqor,
  openWindow,
  pqcState,
} from "./lib/chain.js";
import { MAX_FEE_PER_GAS, loadDeployer, loadDrill } from "./lib/net.js";
import { parseAddressList } from "./lib/pure.js";

async function status(acc: UnifiedAccount): Promise<void> {
  console.log(`account:  ${acc.evm}  (${acc.cosmos})`);
  console.log(`balance:  ${await nativeBalanceUqor(acc.cosmos).catch(() => 0n)} uqor`);
  const pqc = await pqcState(acc);
  console.log(`PQC key:  ${pqc}`);
  const w = await getWindow(acc);
  if (!w.found) console.log("window:   none");
  else {
    console.log(
      `window:   ${w.live ? "live" : "not usable"}; ${w.remainingBlocks} blocks, ${w.remainingTxs} txs, ${w.remainingValue} uqor left`,
    );
    console.log(`scope:    ${w.allowedTargets.length ? w.allowedTargets.join(", ") : "unscoped"}${w.nativeOnly ? " (native only)" : ""}`);
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      account: { type: "string", default: "deployer" },
      targets: { type: "string" },
      blocks: { type: "string" },
      txs: { type: "string" },
      value: { type: "string" },
      "native-only": { type: "boolean", default: false },
    },
  });
  const cmd = positionals[0] ?? "status";
  const acc = values.account === "drill" ? await loadDrill() : values.account === "deployer" ? await loadDeployer() : null;
  if (!acc) throw new Error(`--account must be deployer or drill, got "${values.account}"`);

  switch (cmd) {
    case "status":
      return status(acc);
    case "register": {
      const hash = await ensureRegistered(acc);
      console.log(hash ? `registered: ${hash}` : "The account already has this PQC key; nothing to do.");
      return;
    }
    case "open": {
      if (values.account === "drill") {
        throw new Error("Refusing to open an EVM window on the drill account: it must never hold one.");
      }
      const targets = parseAddressList(values.targets, "--targets", MAX_EVM_WINDOW_TARGETS);
      const blocks = BigInt(values.blocks ?? "600");
      const maxTxs = BigInt(values.txs ?? "5");
      if (blocks < 1n || blocks > MAX_EVM_WINDOW_BLOCKS) throw new Error(`--blocks must be 1..${MAX_EVM_WINDOW_BLOCKS}`);
      if (maxTxs < 1n || maxTxs > MAX_EVM_WINDOW_TXS) throw new Error(`--txs must be 1..${MAX_EVM_WINDOW_TXS}`);
      const perTx = evmWindowCost({ gas: 3_000_000n, maxFeePerGas: MAX_FEE_PER_GAS });
      const maxValue = values.value ? BigInt(values.value) : perTx * maxTxs;
      const hash = await openWindow(acc, {
        blocks,
        maxTxs,
        maxValue,
        allowedTargets: targets,
        nativeOnly: values["native-only"],
      });
      console.log(`opened: ${hash}`);
      console.log(`window: ${blocks} blocks, ${maxTxs} txs, ${maxValue} uqor (value plus fees), ${targets.length ? `scoped to ${targets.join(", ")}` : "unscoped"}`);
      console.log("Opening advanced the account's nonce; send EVM transactions now.");
      return;
    }
    case "close":
      console.log(`closed: ${await closeWindow(acc)}`);
      return;
    default:
      throw new Error(`Unknown command "${cmd}". Use: status | register | open | close`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
