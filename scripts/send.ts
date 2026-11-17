/**
 * send.ts - send test QOR from the deployer to one qor1 address on QoreChain testnet (native bank send,
 * hybrid-signed: secp256k1 + ML-DSA-87). For funding the owner's own QoreX wallet.
 *
 * Env: DEPLOYER_MNEMONIC, SEND_TO (qor1...), SEND_AMOUNT_QOR (decimal, at most 5).
 * Keeps at least 10 QOR in the deployer for drill check-ins and the proof-tx top-up.
 */
import { fromBech32 } from "@cosmjs/encoding";
import { bankSend, nativeBalanceUqor, sleep } from "./lib/chain.js";
import { NET, explorerLinks, loadDeployer, requireEnv } from "./lib/net.js";
import { formatDecimal, parseDecimal } from "./lib/pure.js";

const MAX_SEND = 5_000_000n; // 5 QOR in uqor
const RESERVE = 10_000_000n; // 10 QOR stays with the deployer

async function main(): Promise<void> {
  const to = requireEnv(process.env, "SEND_TO").trim();
  let decoded;
  try {
    decoded = fromBech32(to, 90);
  } catch {
    throw new Error("SEND_TO is not a valid qor1 address. Copy it from QoreX again.");
  }
  if (decoded.prefix !== "qor" || decoded.data.length !== 20) throw new Error("SEND_TO must be a qor1 account address.");
  const amount = parseDecimal(requireEnv(process.env, "SEND_AMOUNT_QOR"), 6);
  if (amount <= 0n || amount > MAX_SEND) throw new Error("Amount must be more than 0 and at most 5 QOR.");

  const from = await loadDeployer();
  if (from.cosmos === to) throw new Error("That is the deployer's own address.");
  const have = await nativeBalanceUqor(from.cosmos);
  console.log(`deployer ${from.cosmos} has ${formatDecimal(have, 6)} QOR`);
  if (have - amount < RESERVE) throw new Error(`Not sent: the deployer must keep at least ${formatDecimal(RESERVE, 6)} QOR for the drill.`);

  const before = await nativeBalanceUqor(to).catch(() => 0n);
  const hash = await bankSend(from, to, amount);
  console.log(`sent ${formatDecimal(amount, 6)} QOR to ${to}`);
  console.log(`tx: ${hash}`);
  for (const l of explorerLinks("tx", hash)) console.log(l);

  for (let i = 0; i < 10; i++) {
    const now = await nativeBalanceUqor(to).catch(() => before);
    if (now > before) {
      console.log(`recipient balance: ${formatDecimal(now, 6)} QOR on ${NET.chainId}`);
      return;
    }
    await sleep(3_000);
  }
  console.log("recipient balance not updated yet; check QoreX in a minute");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
