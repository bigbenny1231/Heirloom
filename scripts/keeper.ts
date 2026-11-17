/**
 * keeper.ts - trigger overdue vaults and settle triggered ones. Safe to run on a cron and to run twice.
 *
 * Scans VaultCreated events, derives each vault's state, and for OVERDUE vaults calls trigger(), for TRIGGERED
 * vaults settle(). Both are open to anyone, so the keeper key has no special power; it only pays gas.
 * Every call is simulated first (eth_call) and skipped if it would revert, e.g. because another keeper won the race.
 *
 * Env: DEPLOYER_MNEMONIC (relayer), QDMV_ADDRESS (or deployments/testnet.json); optional QDMV_FROM_BLOCK,
 * KEEPER_MAX_ACTIONS (default 20, 1..200). Without QDMV_ADDRESS it exits 0 immediately (the cron workflow relies on that).
 * Without QDMV_FROM_BLOCK it scans only the last 50,000 blocks. It pauses from Nov 16 to Nov 19 UTC (drill runs use the
 * same relayer account) unless KEEPER_ALWAYS_ON=1.
 *
 *   tsx scripts/keeper.ts [--dry-run]
 */
import { parseArgs } from "node:util";
import { parseAbiItem, type Address } from "viem";
import { State } from "../lib/encoding.js";
import { closeWindowQuietly, ensureRegistered, ensureWindow, explainError, loadArtifact, publicClient, walletFor, writeContract } from "./lib/chain.js";
import { resolveAddresses } from "./lib/deployments.js";
import { loadDeployer } from "./lib/net.js";
import { assertFitsBlock, blockRanges, keeperAction, keeperPaused, parseBoundedInt, type KeeperAction } from "./lib/pure.js";

const LOG_RANGE = 5_000n;
const GAS_TRIGGER = 600_000n;
const GAS_SETTLE = 9_000_000n; // worst case settle (10 heirs x 5 assets) is ~7.5M

const vaultCreated = parseAbiItem(
  "event VaultCreated(uint256 indexed vaultId, address indexed owner, uint8 keyMode, bytes32 pubkeyHash, uint64 interval, uint8 grace, uint256 bounty, address[] tokens)",
);

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } } });
  if (!process.env.QDMV_ADDRESS?.trim()) {
    try {
      resolveAddresses(process.env);
    } catch {
      console.log("QDMV_ADDRESS is not set: nothing to keep. Exiting.");
      return;
    }
  }
  if (keeperPaused(Date.now()) && process.env.KEEPER_ALWAYS_ON !== "1") {
    console.log("Keeper is paused until Nov 19 UTC so it cannot race the drill runs. Set KEEPER_ALWAYS_ON=1 to override.");
    return;
  }
  const { vault, fromBlock } = resolveAddresses(process.env);
  const maxActions = parseBoundedInt(process.env.KEEPER_MAX_ACTIONS, 20, 1, 200, "KEEPER_MAX_ACTIONS");

  const pub = publicClient();
  const art = loadArtifact("QDMVault");
  const head = await pub.getBlockNumber();
  const start = fromBlock ?? (head > 50_000n ? head - 50_000n : 0n);
  if (fromBlock === undefined) console.log("QDMV_FROM_BLOCK not set: scanning only the last 50,000 blocks");

  const ids = new Set<bigint>();
  for (const [from, to] of blockRanges(start, head, LOG_RANGE)) {
    const logs = await pub.getLogs({ address: vault, event: vaultCreated, fromBlock: from, toBlock: to });
    for (const l of logs) if (l.args.vaultId !== undefined) ids.add(l.args.vaultId);
  }
  console.log(`vault ${vault}: ${ids.size} vault(s) found in blocks ${start}..${head}`);

  const todo: Array<{ id: bigint; action: KeeperAction }> = [];
  for (const id of ids) {
    const state = Number(
      await pub.readContract({ address: vault, abi: art.abi, functionName: "stateOf", args: [id] } as never),
    ) as State;
    const action = keeperAction(state);
    console.log(`  ${id}: state ${State[state]}${action ? ` -> ${action}` : ""}`);
    if (action) todo.push({ id, action });
  }
  if (todo.length === 0) return void console.log("nothing to do");

  // Simulate first; keep only calls that would succeed right now.
  const acc = await loadDeployer();
  const runnable: typeof todo = [];
  for (const t of todo.slice(0, maxActions)) {
    try {
      await pub.simulateContract({ address: vault, abi: art.abi, functionName: t.action, args: [t.id], account: acc.evm as Address } as never);
      runnable.push(t);
    } catch (e) {
      console.log(`  skip ${t.action}(${t.id}): ${explainError(e)}`);
    }
  }
  if (runnable.length === 0) return void console.log("nothing runnable");
  if (values["dry-run"]) {
    for (const t of runnable) console.log(`dry-run: would ${t.action}(${t.id})`);
    return;
  }

  const blockGasLimit = (await pub.getBlock({ blockTag: "latest" })).gasLimit;
  for (const t of runnable) assertFitsBlock(t.action === "settle" ? GAS_SETTLE : GAS_TRIGGER, blockGasLimit, t.action);

  const reg = await ensureRegistered(acc);
  if (reg) console.log(`keeper key registered: ${reg}`);
  await ensureWindow(acc, {
    txs: runnable.map((t) => ({ gas: t.action === "settle" ? GAS_SETTLE : GAS_TRIGGER })),
    targets: [vault],
  });

  const wallet = walletFor(acc);
  let failures = 0;
  for (const t of runnable) {
    try {
      await writeContract(wallet, pub, {
        address: vault,
        abi: art.abi,
        functionName: t.action,
        args: [t.id],
        gasCap: t.action === "settle" ? GAS_SETTLE : GAS_TRIGGER,
      });
    } catch (e) {
      failures++;
      console.error(`${t.action}(${t.id}) failed: ${explainError(e)}`);
    }
  }
  await closeWindowQuietly(acc);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
