import type { Adapter, LabResult, LabVariant, SignatureInspect } from "../../chain/types";

export type { LabResult, LabVariant, SignatureInspect };
/** The lab members (lastSignature, labAttempt) are optional members of Adapter itself; testnet leaves them undefined. */
export type LabAdapter = Adapter;
