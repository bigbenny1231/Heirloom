/**
 * Chain I/O shared by the scripts: native-lane (hybrid) transactions, EVM authorisation windows,
 * viem clients and artifact loading. Mirrors the official template's scripts/window.ts.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { StargateClient } from "@cosmjs/stargate";
import { evmWindowStatus, type EvmWindow } from "@qorechain/evm";
import {
  EthNativeSigner,
  buildRegisterPqcKeyMsg,
  closeEvmWindowMsg,
  fetchPqcStatus,
  isRegisteredPqcKey,
  openEvmWindowMsg,
  signProofOfPossession,
  type UnifiedAccount,
} from "@qorechain/sdk";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MAX_FEE_PER_GAS, MAX_PRIORITY_FEE_PER_GAS, NATIVE_FEE, NET } from "./net.js";
import {
  PQC_KEY_STATUS_ABI,
  WEI_PER_UQOR,
  assertKeyStatus,
  decodeKeyStatus,
  isSequenceMismatch,
  pickGas,
  windowBudget,
  windowSatisfies,
  type KeyStatusView,
  type TxBudget,
  type WindowNeed,
} from "./pure.js";

type Messages = Parameters<EthNativeSigner["sign"]>[0]["messages"];

// ------------------------------------------------------------------ native lane

/** account_number and sequence over REST. */
export async function accountSequence(address: string): Promise<{ accountNumber: bigint; sequence: bigint }> {
  const res = await fetch(`${NET.rest}/cosmos/auth/v1beta1/accounts/${address}`);
  if (res.status === 404) throw new Error(`${address} does not exist on chain yet: send it some QOR first`);
  if (!res.ok) throw new Error(`account query failed: HTTP ${res.status}`);
  const body = (await res.json()) as { account?: Record<string, unknown> };
  const acc = (body.account?.base_account ?? body.account ?? {}) as Record<string, string>;
  return { accountNumber: BigInt(acc.account_number ?? "0"), sequence: BigInt(acc.sequence ?? "0") };
}

/** Native balance in uqor over REST (0 for an unknown account). */
export async function nativeBalanceUqor(address: string): Promise<bigint> {
  const res = await fetch(`${NET.rest}/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${NET.denom}`);
  if (res.status === 404) return 0n;
  if (!res.ok) throw new Error(`balance query failed: HTTP ${res.status}`);
  const body = (await res.json()) as { balance?: { amount?: string } };
  return BigInt(body.balance?.amount ?? "0");
}

/**
 * A native transaction refused for a stale sequence was never accepted, so it is safe to read the sequence again and
 * sign once more. This happens when the REST endpoint is a block behind the node that just included our previous tx.
 */
async function withSequenceRetry<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (e) {
    if (!isSequenceMismatch(e)) throw e;
    console.log("native tx refused for a stale sequence; reading the sequence again and retrying once");
    await sleep(4_000);
    return send();
  }
}

export async function broadcast(acc: UnifiedAccount, mode: "hybrid" | "classical", messages: Messages): Promise<string> {
  return withSequenceRetry(async () => {
    const { accountNumber, sequence } = await accountSequence(acc.cosmos);
    const signer = new EthNativeSigner(acc, { signMode: mode, rest: NET.rest });
    const transport = await StargateClient.connect(NET.rpc);
    try {
      const res = await signer.signAndBroadcast(transport, {
        chainId: NET.chainId,
        accountNumber,
        sequence,
        fee: NATIVE_FEE,
        messages,
      });
      if (res.code !== 0) throw new Error(`native tx ${res.transactionHash} failed (code ${res.code}): ${res.rawLog ?? ""}`);
      return res.transactionHash;
    } finally {
      transport.disconnect();
    }
  });
}

/** Native self-send or transfer, hybrid-signed. */
export async function bankSend(acc: UnifiedAccount, to: string, uqor: bigint): Promise<string> {
  return withSequenceRetry(async () => {
    const { accountNumber, sequence } = await accountSequence(acc.cosmos);
    const signer = new EthNativeSigner(acc, { signMode: "hybrid", rest: NET.rest });
    const transport = await StargateClient.connect(NET.rpc);
    try {
      const res = await signer.bankSend(transport, to, [{ denom: NET.denom, amount: uqor.toString() }], {
        chainId: NET.chainId,
        accountNumber,
        sequence,
        fee: NATIVE_FEE,
      });
      if (res.code !== 0) throw new Error(`bank send ${res.transactionHash} failed (code ${res.code})`);
      return res.transactionHash;
    } finally {
      transport.disconnect();
    }
  });
}

// ------------------------------------------------------------------ PQC key

export type PqcState = "not-registered" | "registered-this-key" | "registered-other-key";

export async function pqcState(acc: UnifiedAccount): Promise<PqcState> {
  const status = await fetchPqcStatus({ rest: NET.rest, address: acc.cosmos });
  if (!status.registered) return "not-registered";
  return isRegisteredPqcKey(status, acc.pqc.publicKey) === false ? "registered-other-key" : "registered-this-key";
}

/** Register the account's ML-DSA-87 key (classical-signed, the one message the chain allows that way). Idempotent. */
export async function ensureRegistered(acc: UnifiedAccount): Promise<string | null> {
  const state = await pqcState(acc);
  if (state === "registered-other-key") {
    throw new Error(`${acc.evm} already has a DIFFERENT ML-DSA-87 key registered; refusing to continue`);
  }
  if (state === "registered-this-key") return null;
  const proofOfPossession = signProofOfPossession({ chainId: NET.chainId, account: acc.cosmos, keypair: acc.pqc });
  const msg = buildRegisterPqcKeyMsg(acc.cosmos, { pqcKeypair: acc.pqc, proofOfPossession });
  return broadcast(acc, "classical", [msg]);
}

// ------------------------------------------------------------------ windows

export const getWindowAt = (cosmos: string): Promise<EvmWindow> => evmWindowStatus({ rest: NET.rest, address: cosmos });
export const getWindow = (acc: UnifiedAccount): Promise<EvmWindow> => getWindowAt(acc.cosmos);

export interface OpenWindowOptions {
  blocks: bigint;
  maxTxs: bigint;
  /** uqor: value plus fees. */
  maxValue: bigint;
  /** Restrict to these contracts (<= 16). Omit for an unscoped window (required for contract creation). */
  allowedTargets?: readonly string[];
  nativeOnly?: boolean;
}

export async function openWindow(acc: UnifiedAccount, o: OpenWindowOptions): Promise<string> {
  const msg = openEvmWindowMsg({
    sender: acc.cosmos,
    blocks: o.blocks,
    maxTxs: o.maxTxs,
    maxValue: o.maxValue,
    ...(o.allowedTargets?.length ? { allowedTargets: o.allowedTargets } : {}),
    ...(o.nativeOnly ? { nativeOnly: true } : {}),
  });
  const hash = await broadcast(acc, "hybrid", [msg]);
  await waitWindowReady(acc);
  return hash;
}

/** After opening: the window must be live and the EVM pending nonce must equal the native sequence (30 s timeout). */
export async function waitWindowReady(acc: UnifiedAccount, timeoutMs = 30_000): Promise<void> {
  const pub = publicClient();
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const [w, seq, nonce] = await Promise.all([
      getWindow(acc),
      accountSequence(acc.cosmos),
      pub.getTransactionCount({ address: acc.evm as Address, blockTag: "pending" }),
    ]);
    last = `window live=${w.live}, native sequence ${seq.sequence}, EVM pending nonce ${nonce}`;
    if (w.live && BigInt(nonce) === seq.sequence) return;
    await sleep(2_000);
  }
  throw new Error(`window not ready after ${timeoutMs / 1000}s: ${last}`);
}

/** Best-effort close at the end of a script; never throws. */
export async function closeWindowQuietly(acc: UnifiedAccount): Promise<void> {
  try {
    const w = await getWindow(acc);
    if (!w.found || !w.live) return;
    console.log(`closed window: ${await closeWindow(acc)}`);
  } catch (e) {
    console.log(`could not close window (it expires by itself): ${explainError(e)}`);
  }
}

export const closeWindow = (acc: UnifiedAccount): Promise<string> => broadcast(acc, "hybrid", [closeEvmWindowMsg(acc.cosmos)]);

export interface EnsureWindowOptions {
  txs: readonly TxBudget[];
  /** Contracts that will be called. Omit together with `unscoped` never; see below. */
  targets?: readonly Address[];
  /** Contract creation in the plan: the window must be unscoped. */
  unscoped?: boolean;
  blocks?: bigint;
}

/** Reuse a live window that fits the plan, otherwise open one sized for it. Returns the opening tx hash or null. */
export async function ensureWindow(acc: UnifiedAccount, o: EnsureWindowOptions): Promise<string | null> {
  const gasPrice = await publicClient().getGasPrice();
  if (gasPrice > MAX_FEE_PER_GAS) {
    throw new Error(`network gas price ${gasPrice} exceeds the script fee cap ${MAX_FEE_PER_GAS}; transactions would not be admitted`);
  }
  const value = windowBudget(o.txs, MAX_FEE_PER_GAS);
  const need: WindowNeed = {
    txs: BigInt(o.txs.length),
    value,
    unscoped: o.unscoped,
    targets: o.targets,
  };
  const current = await getWindow(acc);
  if (windowSatisfies(current, need)) {
    console.log(`window: reusing live window (${current.remainingTxs} txs, ${current.remainingValue} uqor left)`);
    return null;
  }
  const hash = await openWindow(acc, {
    blocks: o.blocks ?? 600n,
    maxTxs: BigInt(o.txs.length) + 1n, // one spare for a retry
    maxValue: value + windowBudget([{ gas: o.txs[0]?.gas ?? 1_000_000n }], MAX_FEE_PER_GAS),
    allowedTargets: o.unscoped ? undefined : o.targets,
  });
  console.log(`window opened (${o.unscoped ? "unscoped" : `scoped to ${o.targets?.length ?? 0} contract(s)`}): ${hash}`);
  return hash;
}

// ------------------------------------------------------------------ EVM lane

export const qoreChain = defineChain({
  id: NET.evmChainId,
  name: "QoreChain Testnet",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [NET.evmRpc] } },
});

export const publicClient = (): PublicClient =>
  createPublicClient({ chain: qoreChain, transport: http(NET.evmRpc), pollingInterval: 2_000 });

export const walletFor = (acc: UnifiedAccount): WalletClient =>
  createWalletClient({ account: privateKeyToAccount(acc.privateKey as Hex), chain: qoreChain, transport: http(NET.evmRpc) });

export async function evmBalanceUqor(addr: Address): Promise<bigint> {
  return (await publicClient().getBalance({ address: addr })) / WEI_PER_UQOR;
}

const feeFields = { maxFeePerGas: MAX_FEE_PER_GAS, maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS } as const;

export interface TxResult {
  hash: Hex;
  block: bigint;
  gasUsed: bigint;
  contractAddress?: Address | null;
}

async function waitOk(pub: PublicClient, hash: Hex, what: string): Promise<TxResult> {
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`${what} reverted on chain: ${hash}`);
  console.log(`${what}: ${hash} (block ${r.blockNumber}, gas ${r.gasUsed})`);
  return { hash, block: r.blockNumber, gasUsed: r.gasUsed, contractAddress: r.contractAddress };
}

/** Custom error name (or short message) from a viem failure, so reverts read as "VaultExists" not hex. */
export function explainError(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) {
      const name = r.data?.errorName;
      if (name) return `${name}(${(r.data?.args ?? []).map(String).join(", ")})`;
      return r.reason ?? r.shortMessage;
    }
    return e.shortMessage;
  }
  return (e as Error)?.message?.split("\n")[0] ?? String(e);
}

export interface WriteArgs {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
  gasCap: bigint;
}

export async function writeContract(wallet: WalletClient, pub: PublicClient, w: WriteArgs): Promise<TxResult> {
  const account = wallet.account!;
  let est: bigint;
  try {
    est = await pub.estimateContractGas({
      address: w.address,
      abi: w.abi,
      functionName: w.functionName,
      args: w.args,
      value: w.value,
      account,
    } as never);
  } catch (e) {
    // A revert here is a real bug in the call: surface it instead of burning a window slot.
    throw new Error(`${w.functionName} would revert: ${explainError(e)}`);
  }
  const hash = await wallet.writeContract({
    address: w.address,
    abi: w.abi,
    functionName: w.functionName,
    args: w.args,
    value: w.value,
    gas: pickGas(est, w.gasCap, w.functionName),
    ...feeFields,
    account,
    chain: qoreChain,
  } as never);
  return waitOk(pub, hash, w.functionName);
}

export async function deployContract(
  wallet: WalletClient,
  pub: PublicClient,
  a: { abi: Abi; bytecode: Hex; args?: readonly unknown[]; gasCap: bigint; label: string },
): Promise<TxResult & { address: Address }> {
  const hash = await wallet.deployContract({
    abi: a.abi,
    bytecode: a.bytecode,
    args: a.args,
    gas: a.gasCap,
    ...feeFields,
    account: wallet.account!,
    chain: qoreChain,
  } as never);
  const r = await waitOk(pub, hash, `deploy ${a.label}`);
  if (!r.contractAddress) throw new Error(`deploy ${a.label}: receipt has no contract address (${hash})`);
  const code = await pub.getCode({ address: r.contractAddress });
  if (!code || code === "0x") throw new Error(`deploy ${a.label}: no code at ${r.contractAddress}`);
  return { ...r, address: r.contractAddress };
}

// ------------------------------------------------------------------ artifacts

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

function findFile(dir: string, file: string): string | null {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      const hit = findFile(p, file);
      if (hit) return hit;
    } else if (entry === file) return p;
  }
  return null;
}

/** Load a Hardhat artifact by contract name from artifacts/contracts/**. Run `npm run build` first. */
export function loadArtifact(name: string, root = process.cwd()): Artifact {
  const base = join(root, "artifacts", "contracts");
  let path: string | null = null;
  try {
    path = findFile(base, `${name}.json`);
  } catch {
    /* handled below */
  }
  if (!path) throw new Error(`Artifact for ${name} not found under artifacts/contracts. Run "npm run build" first.`);
  const j = JSON.parse(readFileSync(path, "utf8")) as { abi: Abi; bytecode: string };
  if (!j.bytecode || j.bytecode === "0x") throw new Error(`${name} artifact has no bytecode (abstract or interface?)`);
  if (j.bytecode.includes("__$")) throw new Error(`${name} bytecode has unlinked library placeholders`);
  return { abi: j.abi, bytecode: j.bytecode as Hex };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ on-chain key check

/** eth_call pqcKeyStatus(addr) and require the account's own ML-DSA-87 key (strict decode, both return shapes). */
export async function verifyOnchainKey(acc: UnifiedAccount, who: string): Promise<KeyStatusView> {
  const data = encodeFunctionData({ abi: PQC_KEY_STATUS_ABI, functionName: "pqcKeyStatus", args: [acc.evm as Address] });
  const r = await publicClient().call({ to: "0x0000000000000000000000000000000000000a02", data });
  const status = assertKeyStatus(decodeKeyStatus(r.data), acc.pqc.publicKey, who);
  console.log(`${who}: pqcKeyStatus returns ${status.shape} values (${status.shape === 4 ? `possessionProven=${status.possessionProven}` : "no possessionProven"})`);
  return status;
}

/** REST view of an account: whether it exists on a network and its sequence (for freshness checks). */
export async function accountInfo(restBase: string, address: string): Promise<{ exists: boolean; sequence: bigint }> {
  const res = await fetch(`${restBase}/cosmos/auth/v1beta1/accounts/${address}`);
  if (res.status === 404) return { exists: false, sequence: 0n };
  if (!res.ok) throw new Error(`cannot check ${address} at ${restBase}: HTTP ${res.status}`);
  const body = (await res.json()) as { account?: Record<string, unknown> };
  const acc = (body.account?.base_account ?? body.account ?? {}) as Record<string, string>;
  return { exists: true, sequence: BigInt(acc.sequence ?? "0") };
}
