/**
 * Public surface of the QDMV simulator. Browser-safe: never import ./node.ts from here.
 */
export { QoreSim } from "./chain.ts";
export type {
  ContractArtifact,
  DecodedEvent,
  RevertInfo,
  SimLog,
  SimOptions,
  TxRequest,
  TxResult,
} from "./chain.ts";
export {
  PQC_KEY_STATUS_GAS,
  PQC_VERIFY_GAS_BASE,
  PQC_VERIFY_GAS_PER_BYTE,
  createPqcState,
  pqcPrecompiles,
} from "./precompiles.ts";
export type { AccountKeyRecord, PqcState } from "./precompiles.ts";
export { TxFailed, VaultClient, expectOk, simBackend } from "./client.ts";
export type { ActionOpts, AgentView, AuthStruct, Backend, VaultView } from "./client.ts";
export { runDrill } from "./drill.ts";
export type { DrillAttack, DrillOptions, DrillReport, ObservedAction } from "./drill.ts";
export { pqKeygen, pqSign, pqVerify, pqPubkeyHash, exportDeviceKey, importDeviceKey } from "../lib/pq.ts";
export type { PqKeyPair } from "../lib/pq.ts";
export * from "../lib/encoding.ts";
export { ACCOUNTS, ETH, createWorld } from "./world.ts";
export type { World } from "./world.ts";
