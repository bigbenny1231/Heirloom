/**
 * In-memory QoreChain-like EVM chain (chain id 9800, Cancun) built on @ethereumjs/evm, running REAL
 * compiled bytecode with the REAL ML-DSA-87 precompiles from ./precompiles.ts.
 *
 * Sender model: this is a sim, so a transaction's `from` is simply asserted by the caller (impersonation).
 * There is no ECDSA. The sender is always explicit in the API and reported on every result.
 *
 * Browser-safe: no fs, no Buffer.
 */
import { createBlock } from "@ethereumjs/block";
import { Common, Hardfork, Mainnet, createCustomCommon } from "@ethereumjs/common";
import { EVM, createEVM } from "@ethereumjs/evm";
import { Account, Address, hexToBytes as ejsHexToBytes, bytesToHex as ejsBytesToHex } from "@ethereumjs/util";
import {
  bytesToHex,
  concatHex,
  decodeErrorResult,
  encodeDeployData,
  hexToBytes,
  parseEventLogs,
  type Abi,
  type Address as ViemAddress,
  type Hex,
} from "viem";
import { PQ_ALGORITHM_ID, QORE_TESTNET_CHAIN_ID } from "../lib/encoding.ts";
import { createPqcState, pqcPrecompiles, type PqcState } from "./precompiles.ts";

export interface ContractArtifact {
  abi: Abi;
  bytecode: Hex;
}

export interface SimLog {
  address: ViemAddress;
  topics: Hex[];
  data: Hex;
}

export interface DecodedEvent {
  address: ViemAddress;
  eventName: string;
  args: Record<string, unknown>;
}

export interface RevertInfo {
  /** Raw returndata. */
  data: Hex;
  /** Custom error name if it decoded against a known ABI, else Error(string) / Panic / "unknown". */
  name: string;
  args?: readonly unknown[];
  /** Human line, e.g. "BadNonce(1, 0)" or "revert: out of gas". */
  reason: string;
}

export interface TxResult {
  ok: boolean;
  /** Asserted sender, echoed back so UIs can show who "signed" the tx. */
  from: ViemAddress;
  to: ViemAddress | null;
  /** Total gas: intrinsic (21000 + calldata, +32000 and initcode words on creation) plus execution. */
  gasUsed: bigint;
  /** Execution gas only (what the EVM charged inside the call). */
  executionGas: bigint;
  /** Intrinsic gas charged before execution. */
  intrinsicGas: bigint;
  returnData: Hex;
  revert?: RevertInfo;
  logs: SimLog[];
  /** Logs decoded against the ABIs registered with the sim (and those passed to the call). */
  events: DecodedEvent[];
  blockNumber: bigint;
  timestamp: bigint;
  createdAddress?: ViemAddress;
}

export interface TxRequest {
  from: ViemAddress;
  to: ViemAddress;
  data?: Hex;
  value?: bigint;
  gasLimit?: bigint;
}

export interface SimOptions {
  chainId?: bigint;
  /** Initial block timestamp (unix seconds). Default: the real current time; pass a fixed value for deterministic runs. */
  startTime?: bigint;
  /** Seconds each mined tx advances the clock. Default 1. */
  blockTime?: bigint;
  /** Start with the PQC precompiles active (default true). */
  pqcActive?: boolean;
  /** pqcKeyStatus return shape: 4 (default, docs) or 3 (official @qorechain/evm ABI). */
  keyStatusShape?: 3 | 4;
}

const DEFAULT_GAS = 30_000_000n;

/** Error(string) and Panic(uint256) plus common OZ ERC-20 errors, so reverts from tokens decode too. */
const BUILTIN_ERRORS: Abi = [
  { type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] },
  { type: "error", name: "Panic", inputs: [{ name: "code", type: "uint256" }] },
  {
    type: "error",
    name: "ERC20InsufficientAllowance",
    inputs: [
      { name: "spender", type: "address" },
      { name: "allowance", type: "uint256" },
      { name: "needed", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "ERC20InsufficientBalance",
    inputs: [
      { name: "sender", type: "address" },
      { name: "balance", type: "uint256" },
      { name: "needed", type: "uint256" },
    ],
  },
  { type: "error", name: "ERC20InvalidReceiver", inputs: [{ name: "receiver", type: "address" }] },
  { type: "error", name: "ERC20InvalidSender", inputs: [{ name: "sender", type: "address" }] },
  { type: "error", name: "ERC20InvalidSpender", inputs: [{ name: "spender", type: "address" }] },
  { type: "error", name: "SafeERC20FailedOperation", inputs: [{ name: "token", type: "address" }] },
  { type: "error", name: "ReentrancyGuardReentrantCall", inputs: [] },
];

/** 21000 + 16/non-zero calldata byte + 4/zero byte; creation adds 32000 and EIP-3860 initcode words (2 per 32 bytes). */
export function intrinsicGas(data: Hex, isCreate: boolean): bigint {
  const bytes = hexToBytes(data);
  let g = 21_000n;
  for (const b of bytes) g += b === 0 ? 4n : 16n;
  if (isCreate) g += 32_000n + 2n * BigInt(Math.ceil(bytes.length / 32));
  return g;
}

const toEjs = (a: ViemAddress) => new Address(ejsHexToBytes(a));

export class QoreSim {
  readonly chainId: bigint;
  readonly pqc: PqcState;
  private evm: EVM;
  private clock: bigint;
  private blockTime: bigint;
  private height = 1n;
  private abis: Abi[] = [BUILTIN_ERRORS];
  /** Every mined transaction, oldest first (for the app's activity feed). */
  readonly history: TxResult[] = [];

  private constructor(evm: EVM, pqc: PqcState, o: Required<Omit<SimOptions, "pqcActive" | "keyStatusShape">>) {
    this.evm = evm;
    this.pqc = pqc;
    this.chainId = o.chainId;
    this.clock = o.startTime;
    this.blockTime = o.blockTime;
  }

  static async create(opts: SimOptions = {}): Promise<QoreSim> {
    const chainId = opts.chainId ?? QORE_TESTNET_CHAIN_ID;
    // solc 0.8.28 targets cancun by default.
    const common: Common = createCustomCommon({ chainId: Number(chainId) }, Mainnet, { hardfork: Hardfork.Cancun });
    const pqc = createPqcState();
    pqc.active = opts.pqcActive ?? true;
    pqc.keyStatusShape = opts.keyStatusShape ?? 4;
    const evm = await createEVM({ common, customPrecompiles: pqcPrecompiles(pqc), allowUnlimitedContractSize: true });
    return new QoreSim(evm, pqc, {
      chainId,
      startTime: opts.startTime ?? BigInt(Math.floor(Date.now() / 1000)),
      blockTime: opts.blockTime ?? 1n,
    });
  }

  // ------------------------------------------------------------ time / blocks

  /** Timestamp the next mined block will carry. */
  get now(): bigint {
    return this.clock;
  }
  get blockNumber(): bigint {
    return this.height;
  }

  /** Move the clock forward. block.timestamp of the next tx is `now`. */
  advanceTime(seconds: bigint | number): void {
    const s = BigInt(seconds);
    if (s < 0n) throw new Error("cannot go back in time");
    this.clock += s;
  }
  setTime(timestamp: bigint): void {
    if (timestamp < this.clock) throw new Error("cannot go back in time");
    this.clock = timestamp;
  }
  /** Mine empty blocks, each advancing the clock by `blockTime`. */
  mine(blocks = 1): void {
    for (let i = 0; i < blocks; i++) {
      this.height += 1n;
      this.clock += this.blockTime;
    }
  }

  private block() {
    return createBlock(
      { header: { number: this.height, timestamp: this.clock, gasLimit: 60_000_000n, baseFeePerGas: 0n } },
      { common: this.evm.common, skipConsensusFormatValidation: true },
    );
  }

  /**
   * Capture the whole chain state (accounts, storage, clock, history, PQC counters). The returned function
   * restores it. Used by the drill so every attack runs against the same pristine state.
   */
  async snapshot(): Promise<() => Promise<void>> {
    const { clock, height } = this;
    const hist = this.history.length;
    const { verifyCalls, verifyOk } = this.pqc;
    await this.evm.journal.checkpoint();
    return async () => {
      await this.evm.journal.revert();
      this.clock = clock;
      this.height = height;
      this.history.length = hist;
      this.pqc.verifyCalls = verifyCalls;
      this.pqc.verifyOk = verifyOk;
    };
  }

  // ----------------------------------------------------------------- PQC admin

  /** Toggle the precompiles. Inactive = success with EMPTY return data (mainnet's inactive behaviour). */
  setPqcActive(active: boolean): void {
    this.pqc.active = active;
  }

  setKeyStatusShape(shape: 3 | 4): void {
    this.pqc.keyStatusShape = shape;
  }

  /** TEST ONLY: break the verifier on purpose (accepts every signature). */
  setUnsafeAcceptAll(on: boolean): void {
    this.pqc.unsafeAcceptAll = on;
  }

  /** Install an account's ML-DSA key into the in-memory registry that pqcKeyStatus reads. */
  registerAccountKey(
    addr: ViemAddress,
    pubkey: Uint8Array | Hex,
    opts: { possessionProven?: boolean; algorithmId?: number } = {},
  ): void {
    this.pqc.registry.set(addr.toLowerCase(), {
      algorithmId: opts.algorithmId ?? PQ_ALGORITHM_ID,
      pubkey: typeof pubkey === "string" ? pubkey : bytesToHex(pubkey),
      possessionProven: opts.possessionProven ?? true,
    });
  }
  unregisterAccountKey(addr: ViemAddress): void {
    this.pqc.registry.delete(addr.toLowerCase());
  }

  // ------------------------------------------------------------------ accounts

  async fund(addr: ViemAddress, wei: bigint): Promise<void> {
    const a = toEjs(addr);
    const acct = (await this.evm.stateManager.getAccount(a)) ?? new Account();
    acct.balance += wei;
    await this.evm.stateManager.putAccount(a, acct);
  }

  async balanceOf(addr: ViemAddress): Promise<bigint> {
    return (await this.evm.stateManager.getAccount(toEjs(addr)))?.balance ?? 0n;
  }

  async getCode(addr: ViemAddress): Promise<Hex> {
    return bytesToHex(await this.evm.stateManager.getCode(toEjs(addr)));
  }

  /** Install runtime bytecode at an address (like hardhat_setCode). */
  async setCode(addr: ViemAddress, code: Hex): Promise<void> {
    await this.evm.stateManager.putCode(toEjs(addr), ejsHexToBytes(code));
  }

  // ------------------------------------------------------------------- ABIs

  /** Register an ABI so revert reasons and events from any contract decode. */
  registerAbi(abi: Abi): void {
    this.abis.push(abi);
  }

  // ---------------------------------------------------------------- execution

  /** Deploy an artifact from `from`. Returns the tx result with createdAddress set on success. */
  async deploy(
    artifact: ContractArtifact,
    args: readonly unknown[] = [],
    from: ViemAddress = "0x00000000000000000000000000000000000d3910",
    value = 0n,
  ): Promise<TxResult & { address: ViemAddress }> {
    this.registerAbi(artifact.abi);
    const data = args.length
      ? encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args })
      : artifact.bytecode;
    const res = await this.exec({ from, to: null, data, value, gasLimit: DEFAULT_GAS }, true);
    if (!res.ok || !res.createdAddress) {
      throw new Error(`deploy failed: ${res.revert?.reason ?? "no address"}`);
    }
    return { ...res, address: res.createdAddress };
  }

  /** State-changing transaction. Mines one block. Never throws on revert: inspect `ok` / `revert`. */
  async send(req: TxRequest, abis: Abi[] = []): Promise<TxResult> {
    return this.exec({ ...req, to: req.to, data: req.data ?? "0x", value: req.value ?? 0n }, true, abis);
  }

  /** Read-only eth_call. State is rolled back. Does not mine. */
  async call(req: TxRequest, abis: Abi[] = []): Promise<TxResult> {
    return this.exec({ ...req, to: req.to, data: req.data ?? "0x", value: req.value ?? 0n }, false, abis);
  }

  private async exec(
    req: { from: ViemAddress; to: ViemAddress | null; data: Hex; value?: bigint; gasLimit?: bigint },
    commit: boolean,
    extraAbis: Abi[] = [],
  ): Promise<TxResult> {
    const caller = toEjs(req.from);
    const value = req.value ?? 0n;
    const gasLimit = req.gasLimit ?? DEFAULT_GAS;
    const j = this.evm.journal;
    await j.checkpoint();
    // Gas is free in the sim, but the sender must still cover `value`.
    if ((await this.balanceOf(req.from)) < value) {
      await j.revert();
      return this.finish(req, commit, extraAbis, {
        executionGasUsed: 0n,
        returnValue: new Uint8Array(),
        exceptionError: { error: "insufficient balance for value" },
      });
    }
    const result = await this.evm.runCall({
      block: this.block(),
      caller,
      origin: caller,
      to: req.to ? toEjs(req.to) : undefined,
      data: hexToBytes(req.data),
      value,
      gasLimit,
    });
    const failed = result.execResult.exceptionError !== undefined;
    if (!commit || failed) await j.revert();
    else await j.commit();
    return this.finish(req, commit, extraAbis, result.execResult, result.createdAddress);
  }

  private finish(
    req: { from: ViemAddress; to: ViemAddress | null; data?: Hex },
    commit: boolean,
    extraAbis: Abi[],
    er: { exceptionError?: unknown; executionGasUsed: bigint; returnValue: Uint8Array; logs?: unknown[] },
    created?: Address,
  ): TxResult {
    const ok = er.exceptionError === undefined;
    const intrinsic = intrinsicGas(req.data ?? "0x", req.to === null);
    const returnData = bytesToHex(er.returnValue);
    const logs: SimLog[] = ok
      ? ((er.logs ?? []) as [Uint8Array, Uint8Array[], Uint8Array][]).map(([a, t, d]) => ({
          address: ejsBytesToHex(a) as ViemAddress,
          topics: t.map((x) => ejsBytesToHex(x) as Hex),
          data: ejsBytesToHex(d) as Hex,
        }))
      : [];
    const abis = [...this.abis, ...extraAbis];
    const res: TxResult = {
      ok,
      from: req.from,
      to: req.to,
      gasUsed: er.executionGasUsed + intrinsic,
      executionGas: er.executionGasUsed,
      intrinsicGas: intrinsic,
      returnData,
      logs,
      events: ok ? this.decodeLogs(logs, extraAbis) : [],
      blockNumber: this.height,
      timestamp: this.clock,
      createdAddress: created ? (created.toString() as ViemAddress) : undefined,
    };
    if (!ok) res.revert = this.decodeRevert(returnData, er.exceptionError, abis);
    if (commit) {
      this.history.push(res);
      this.height += 1n;
      this.clock += this.blockTime;
    }
    return res;
  }

  private decodeRevert(data: Hex, err: unknown, abis: Abi[]): RevertInfo {
    const errName = (err as { error?: string } | undefined)?.error ?? "revert";
    if (data === "0x") return { data, name: "unknown", reason: errName === "revert" ? "revert (no data)" : errName };
    for (const abi of abis.slice().reverse()) {
      try {
        const d = decodeErrorResult({ abi, data });
        const args = (d.args ?? []) as readonly unknown[];
        const reason =
          d.errorName === "Error" ? `Error(${JSON.stringify(args[0])})` : `${d.errorName}(${args.map(String).join(", ")})`;
        return { data, name: d.errorName, args, reason };
      } catch {
        /* try the next abi */
      }
    }
    return { data, name: "unknown", reason: `unknown error ${data.slice(0, 10)}` };
  }

  /** Decode logs against every registered ABI plus `extraAbis`. Unknown logs are skipped. */
  decodeLogs(logs: SimLog[], extraAbis: Abi[] = []): DecodedEvent[] {
    const out: DecodedEvent[] = [];
    for (const log of logs) {
      for (const abi of [...extraAbis, ...this.abis.slice(1).reverse()]) {
        const parsed = parseEventLogs({
          abi,
          logs: [{ ...log, blockNumber: 0n, blockHash: "0x", transactionHash: "0x", transactionIndex: 0, logIndex: 0, removed: false }] as never,
          strict: false,
        });
        if (parsed.length) {
          const p = parsed[0] as unknown as { eventName: string; args: Record<string, unknown> };
          out.push({ address: log.address, eventName: p.eventName, args: p.args ?? {} });
          break;
        }
      }
    }
    return out;
  }
}

export { concatHex };
