/**
 * QoreChain PQC precompiles for the ethereumjs EVM, with REAL ML-DSA-87 verification.
 *
 *   0x...0A01 pqcVerify(bytes pubkey, bytes signature, bytes message) -> bool   gas 25000 + 8/input byte
 *   0x...0A02 pqcKeyStatus(address) -> (bool registered, uint8 algorithmId, bytes pubkey, bool possessionProven)
 *
 * Both accept calldata with or without the 4-byte function selector (the real chain's framing is not
 * documented; QDMVault calls with the selector). Browser-safe.
 */
import { EVMError, type CustomPrecompile, type PrecompileInput, type ExecResult } from "@ethereumjs/evm";
import {
  bytesToHex,
  decodeAbiParameters,
  encodeAbiParameters,
  hexToBytes,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { PQC_KEY_STATUS_ADDRESS, PQC_VERIFY_ADDRESS, PQ_ALGORITHM_ID } from "../lib/encoding.ts";
import { pqVerify } from "../lib/pq.ts";

export const PQC_VERIFY_GAS_BASE = 25_000n;
export const PQC_VERIFY_GAS_PER_BYTE = 8n;
export const PQC_KEY_STATUS_GAS = 2_500n;

const VERIFY_SELECTOR = toFunctionSelector("pqcVerify(bytes,bytes,bytes)");
const STATUS_SELECTOR = toFunctionSelector("pqcKeyStatus(address)");

export interface AccountKeyRecord {
  algorithmId: number;
  pubkey: Hex;
  possessionProven: boolean;
}

/** Mutable state shared between the sim API and the precompile closures. */
export interface PqcState {
  /** When false the precompiles behave like an inactive precompile on mainnet: success + empty data. */
  active: boolean;
  /** pqcKeyStatus return shape: 4 = (registered, alg, pubkey, possessionProven) per docs; 3 = official @qorechain/evm ABI (no possessionProven). */
  keyStatusShape: 3 | 4;
  registry: Map<string, AccountKeyRecord>;
  /** TEST ONLY: make pqcVerify accept anything. Exists to prove the drill detects a broken verifier. */
  unsafeAcceptAll: boolean;
  /** Counters for tests / UI. */
  verifyCalls: number;
  verifyOk: number;
}

export function createPqcState(): PqcState {
  return { active: true, keyStatusShape: 4, registry: new Map(), unsafeAcceptAll: false, verifyCalls: 0, verifyOk: 0 };
}

const EMPTY = new Uint8Array(0);

function ok(gasUsed: bigint, returnValue: Uint8Array): ExecResult {
  return { executionGasUsed: gasUsed, returnValue };
}

function fail(gasLimit: bigint, message: (typeof EVMError.errorMessages)[keyof typeof EVMError.errorMessages]): ExecResult {
  return { executionGasUsed: gasLimit, returnValue: EMPTY, exceptionError: new EVMError(message) };
}

/** Strip the selector if present. */
function body(data: Uint8Array, selector: Hex): Uint8Array {
  if (data.length >= 4 && bytesToHex(data.subarray(0, 4)) === selector) return data.subarray(4);
  return data;
}

export function pqcPrecompiles(state: PqcState): CustomPrecompile[] {
  const verify = (input: PrecompileInput): ExecResult => {
    const cost = PQC_VERIFY_GAS_BASE + PQC_VERIFY_GAS_PER_BYTE * BigInt(input.data.length);
    if (input.gasLimit < cost) return fail(input.gasLimit, EVMError.errorMessages.OUT_OF_GAS);
    if (!state.active) return ok(cost, EMPTY);
    state.verifyCalls++;
    let valid = false;
    try {
      const [pubkey, sig, message] = decodeAbiParameters(
        [{ type: "bytes" }, { type: "bytes" }, { type: "bytes" }],
        bytesToHex(body(input.data, VERIFY_SELECTOR)),
      );
      valid = pqVerify(hexToBytes(sig), hexToBytes(message), hexToBytes(pubkey));
    } catch {
      valid = false; // malformed input verifies as false, never throws
    }
    if (state.unsafeAcceptAll) valid = true;
    if (valid) state.verifyOk++;
    return ok(cost, hexToBytes(encodeAbiParameters([{ type: "bool" }], [valid])));
  };

  const keyStatus = (input: PrecompileInput): ExecResult => {
    const cost = PQC_KEY_STATUS_GAS;
    if (input.gasLimit < cost) return fail(input.gasLimit, EVMError.errorMessages.OUT_OF_GAS);
    if (!state.active) return ok(cost, EMPTY);
    let account: Address;
    try {
      [account] = decodeAbiParameters([{ type: "address" }], bytesToHex(body(input.data, STATUS_SELECTOR)));
    } catch {
      return fail(input.gasLimit, EVMError.errorMessages.INVALID_INPUT_LENGTH);
    }
    const rec = state.registry.get(account.toLowerCase());
    const three = state.keyStatusShape === 3;
    const types = three
      ? [{ type: "bool" }, { type: "uint8" }, { type: "bytes" }]
      : [{ type: "bool" }, { type: "uint8" }, { type: "bytes" }, { type: "bool" }];
    const vals: unknown[] = rec ? [true, rec.algorithmId, rec.pubkey] : [false, 0, "0x"];
    if (!three) vals.push(rec ? rec.possessionProven : false);
    const out = encodeAbiParameters(types as never, vals as never);
    return ok(cost, hexToBytes(out));
  };

  return [
    { address: PQC_VERIFY_ADDRESS, function: verify },
    { address: PQC_KEY_STATUS_ADDRESS, function: keyStatus },
  ];
}

export { PQ_ALGORITHM_ID };
