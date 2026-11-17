/**
 * QDMV digest encoding: the single source of truth shared by tests, scripts, the simulator and the app.
 *
 * Every signed action is a 32-byte digest:
 *
 *   digest = keccak256(abi.encode(
 *     bytes32 TAG,            // keccak256("QDMV1")
 *     uint256 chainId,        // block.chainid
 *     address vault,          // address(QDMVault)
 *     uint256 vaultId,
 *     uint8   action,         // Action enum value
 *     bytes32 argsHash,       // keccak256(abi.encode(args...)), args per action below
 *     uint256 nonce,
 *     uint256 expiry          // unix seconds; valid while block.timestamp <= expiry
 *   ))
 *
 * The signer signs exactly these 32 bytes with ML-DSA-87 (empty context) and the contract passes the same
 * 32 bytes as `message` to the pqcVerify precompile. Nothing is prefixed or re-hashed.
 *
 * This file must stay byte-for-byte in step with docs/SPEC.md section 5 and contracts/QDMVault.sol.
 * `QDMVault.actionDigest(...)` and `QDMVault.computeVaultId(...)` exist so tests can cross-check it.
 */
import {
  encodeAbiParameters,
  hexToBytes,
  keccak256,
  stringToBytes,
  type Address,
  type Hex,
} from "viem";

// ------------------------------------------------------------------ constants

/** Domain tag: keccak256("QDMV1") over the UTF-8 bytes. */
export const TAG: Hex = keccak256(stringToBytes("QDMV1"));

/** ML-DSA-87 (FIPS 204, "dilithium5") sizes in bytes. */
export const PQ_PUBKEY_LENGTH = 2592;
export const PQ_SIGNATURE_LENGTH = 4627;
/** algorithmId reported by pqcKeyStatus for ML-DSA-87. */
export const PQ_ALGORITHM_ID = 1;

/** Precompile addresses, lowercase (viem setCode / getCode friendly). */
export const PQC_VERIFY_ADDRESS: Address = "0x0000000000000000000000000000000000000a01";
export const PQC_KEY_STATUS_ADDRESS: Address = "0x0000000000000000000000000000000000000a02";

/** QoreChain testnet (qorechain-diana) EVM chain id. */
export const QORE_TESTNET_CHAIN_ID = 9800n;

/** The native asset is represented by the zero address everywhere. */
export const NATIVE: Address = "0x0000000000000000000000000000000000000000";
export const ZERO_HASH: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";

/** Contract limits (mirrors of the Solidity constants). */
export const MAX_HEIRS = 10;
export const MAX_TOKENS = 4;
export const MAX_PAYEES = 8;
export const MIN_INTERVAL = 60n;
export const MAX_INTERVAL = 365n * 86400n;
export const MAX_GRACE = 12;
export const BPS_DENOMINATOR = 10000;
export const MAX_BOUNTY_BPS = 1000n;

// ---------------------------------------------------------------------- enums

/** Must match IQDMVault.Action. The numeric value is signed. Never reorder. */
export enum Action {
  NONE = 0,
  CREATE = 1,
  CHECKIN = 2,
  WITHDRAW = 3,
  SET_HEIRS = 4,
  SET_TIMING = 5,
  SET_AGENT = 6,
  REVOKE_AGENT = 7,
  ROTATE_KEY = 8,
  ROTATE_KEY_POP = 9,
  CLOSE = 10,
  SET_PAYOUT = 11,
}

/** Must match IQDMVault.KeyMode. */
export enum KeyMode {
  ACCOUNT = 0,
  DEVICE = 1,
}

/** Must match IQDMVault.Status. */
export enum Status {
  NONE = 0,
  ACTIVE = 1,
  TRIGGERED = 2,
  SETTLED = 3,
  CLOSED = 4,
}

/** Must match IQDMVault.State. */
export enum State {
  NONE = 0,
  ALIVE = 1,
  WARNING = 2,
  OVERDUE = 3,
  TRIGGERED = 4,
  SETTLED = 5,
  CLOSED = 6,
}

/** Must match IQDMVault.DenyReason. */
export enum DenyReason {
  NONE = 0,
  NOT_ALIVE = 1,
  EXPIRED = 2,
  PAYEE_NOT_ALLOWED = 3,
  ZERO_AMOUNT = 4,
  OVER_PER_TX = 5,
  OVER_DAILY = 6,
  INSUFFICIENT_BALANCE = 7,
}

// ---------------------------------------------------------------------- types

export interface Heir {
  account: Address;
  payoutTo: Address;
  /** basis points, 1..10000; all heirs sum to 10000 */
  bps: number;
}

export interface CreateParams {
  salt: Hex;
  interval: bigint;
  grace: number;
  bounty: bigint;
  tokens: readonly Address[];
  heirs: readonly Heir[];
}

/** Where a signature is valid: one chain, one deployed QDMVault. */
export interface Domain {
  chainId: bigint;
  vault: Address;
}

/** Fields common to every signed request. */
export interface Signed {
  vaultId: bigint;
  nonce: bigint;
  expiry: bigint;
}

// ABI fragments reused below (also usable with viem contract calls).
export const HEIR_ABI = {
  type: "tuple",
  components: [
    { name: "account", type: "address" },
    { name: "payoutTo", type: "address" },
    { name: "bps", type: "uint16" },
  ],
} as const;

export const HEIRS_ABI = { ...HEIR_ABI, type: "tuple[]" } as const;

export const CREATE_PARAMS_ABI = {
  type: "tuple",
  components: [
    { name: "salt", type: "bytes32" },
    { name: "interval", type: "uint64" },
    { name: "grace", type: "uint8" },
    { name: "bounty", type: "uint256" },
    { name: "tokens", type: "address[]" },
    { name: "heirs", ...HEIRS_ABI },
  ],
} as const;

// -------------------------------------------------------------------- helpers

/** keccak256 of a 2592-byte ML-DSA-87 public key (what DEVICE vaults pin). */
export function pubkeyHash(pubkey: Hex | Uint8Array): Hex {
  const bytes = typeof pubkey === "string" ? hexToBytes(pubkey) : pubkey;
  if (bytes.length !== PQ_PUBKEY_LENGTH) {
    throw new Error(`pubkey must be ${PQ_PUBKEY_LENGTH} bytes, got ${bytes.length}`);
  }
  return keccak256(bytes);
}

/**
 * Vault id = uint256(keccak256(abi.encode(address owner, uint8 keyMode, bytes32 pubkeyHash, bytes32 paramsHash)))
 * with paramsHash = keccak256(abi.encode(CreateParams p)) (salt, interval, grace, bounty, tokens and heirs included).
 * The id therefore commits to everything the creator chose: nobody can squat an id with different parameters.
 * pubkeyHash is ZERO_HASH in ACCOUNT mode.
 */
export function computeVaultId(owner: Address, keyMode: KeyMode, pkHash: Hex, p: CreateParams): bigint {
  if (keyMode === KeyMode.ACCOUNT && pkHash !== ZERO_HASH) {
    throw new Error("ACCOUNT mode vault ids use a zero pubkeyHash");
  }
  const paramsHash = keccak256(
    encodeAbiParameters(
      [CREATE_PARAMS_ABI],
      [{ salt: p.salt, interval: p.interval, grace: p.grace, bounty: p.bounty, tokens: p.tokens, heirs: p.heirs }],
    ),
  );
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }],
        [owner, keyMode, pkHash, paramsHash],
      ),
    ),
  );
}

/** The outer digest. `argsHash` is keccak256(abi.encode(args...)) for the action. */
export function actionDigest(
  domain: Domain,
  vaultId: bigint,
  action: Action,
  argsHash: Hex,
  nonce: bigint,
  expiry: bigint,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint8" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [TAG, domain.chainId, domain.vault, vaultId, action, argsHash, nonce, expiry],
    ),
  );
}

/** The 32 raw bytes to hand to the ML-DSA-87 signer (and that the contract passes as `message`). */
export function digestToMessage(digest: Hex): Uint8Array {
  const bytes = hexToBytes(digest);
  if (bytes.length !== 32) throw new Error("digest must be 32 bytes");
  return bytes;
}

/** keccak256(abi.encode()) = keccak256 of zero bytes. Used by CHECKIN and REVOKE_AGENT. */
export const EMPTY_ARGS_HASH: Hex = keccak256("0x");

// ------------------------------------------------------- per-action args hash

export const argsHash = {
  /** abi.encode(address owner, uint8 keyMode, bytes32 pubkeyHash, CreateParams p) */
  create(owner: Address, keyMode: KeyMode, pkHash: Hex, p: CreateParams): Hex {
    return keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint8" }, { type: "bytes32" }, CREATE_PARAMS_ABI],
        [
          owner,
          keyMode,
          pkHash,
          {
            salt: p.salt,
            interval: p.interval,
            grace: p.grace,
            bounty: p.bounty,
            tokens: p.tokens,
            heirs: p.heirs,
          },
        ],
      ),
    );
  },
  /** abi.encode() */
  checkIn(): Hex {
    return EMPTY_ARGS_HASH;
  },
  /** abi.encode(address token, uint256 amount, address to) */
  withdraw(token: Address, amount: bigint, to: Address): Hex {
    return keccak256(
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "address" }], [token, amount, to]),
    );
  },
  /** abi.encode(Heir[] heirs) */
  setHeirs(heirs: readonly Heir[]): Hex {
    return keccak256(encodeAbiParameters([HEIRS_ABI], [heirs]));
  },
  /** abi.encode(uint64 interval, uint8 grace, uint256 bounty) */
  setTiming(interval: bigint, grace: number, bounty: bigint): Hex {
    return keccak256(
      encodeAbiParameters([{ type: "uint64" }, { type: "uint8" }, { type: "uint256" }], [interval, grace, bounty]),
    );
  },
  /** abi.encode(address agent, address token, uint256 perTxLimit, uint256 dailyLimit, uint64 validUntil, address[] payees) */
  setAgent(
    agent: Address,
    token: Address,
    perTxLimit: bigint,
    dailyLimit: bigint,
    validUntil: bigint,
    payees: readonly Address[],
  ): Hex {
    return keccak256(
      encodeAbiParameters(
        [
          { type: "address" },
          { type: "address" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint64" },
          { type: "address[]" },
        ],
        [agent, token, perTxLimit, dailyLimit, validUntil, payees],
      ),
    );
  },
  /** abi.encode() */
  revokeAgent(): Hex {
    return EMPTY_ARGS_HASH;
  },
  /** abi.encode(bytes32 newPubkeyHash); shared by ROTATE_KEY and ROTATE_KEY_POP */
  rotateKey(newPubkeyHash: Hex): Hex {
    return keccak256(encodeAbiParameters([{ type: "bytes32" }], [newPubkeyHash]));
  },
  /** abi.encode(address to) */
  close(to: Address): Hex {
    return keccak256(encodeAbiParameters([{ type: "address" }], [to]));
  },
  /** abi.encode(uint256 heirIndex, address heir, address newPayout) */
  setPayout(heirIndex: bigint, heir: Address, newPayout: Address): Hex {
    return keccak256(
      encodeAbiParameters(
        [{ type: "uint256" }, { type: "address" }, { type: "address" }],
        [heirIndex, heir, newPayout],
      ),
    );
  },
} as const;

// ------------------------------------------------------- per-action digests

/**
 * CREATE (createVaultFor). Signed by the owner's account key (ACCOUNT) or by the device key being
 * pinned (DEVICE, which makes it the proof of possession). The nonce is always 0.
 * `pkHash` is ZERO_HASH in ACCOUNT mode and keccak256(pubkey) in DEVICE mode.
 * Returns the vault id too, since it is derived from the same inputs.
 */
export function createDigest(
  domain: Domain,
  owner: Address,
  keyMode: KeyMode,
  pkHash: Hex,
  p: CreateParams,
  expiry: bigint,
): { vaultId: bigint; digest: Hex } {
  const vaultId = computeVaultId(owner, keyMode, pkHash, p);
  const digest = actionDigest(domain, vaultId, Action.CREATE, argsHash.create(owner, keyMode, pkHash, p), 0n, expiry);
  return { vaultId, digest };
}

/** CHECKIN. nonce = vault.nonce. */
export function checkInDigest(domain: Domain, s: Signed): Hex {
  return actionDigest(domain, s.vaultId, Action.CHECKIN, argsHash.checkIn(), s.nonce, s.expiry);
}

/** WITHDRAW. token = NATIVE (zero address) for QOR. */
export function withdrawDigest(domain: Domain, s: Signed, token: Address, amount: bigint, to: Address): Hex {
  return actionDigest(domain, s.vaultId, Action.WITHDRAW, argsHash.withdraw(token, amount, to), s.nonce, s.expiry);
}

/** SET_HEIRS. */
export function setHeirsDigest(domain: Domain, s: Signed, heirs: readonly Heir[]): Hex {
  return actionDigest(domain, s.vaultId, Action.SET_HEIRS, argsHash.setHeirs(heirs), s.nonce, s.expiry);
}

/** SET_TIMING. */
export function setTimingDigest(domain: Domain, s: Signed, interval: bigint, grace: number, bounty: bigint): Hex {
  return actionDigest(
    domain,
    s.vaultId,
    Action.SET_TIMING,
    argsHash.setTiming(interval, grace, bounty),
    s.nonce,
    s.expiry,
  );
}

/** SET_AGENT. */
export function setAgentDigest(
  domain: Domain,
  s: Signed,
  agent: Address,
  token: Address,
  perTxLimit: bigint,
  dailyLimit: bigint,
  validUntil: bigint,
  payees: readonly Address[],
): Hex {
  return actionDigest(
    domain,
    s.vaultId,
    Action.SET_AGENT,
    argsHash.setAgent(agent, token, perTxLimit, dailyLimit, validUntil, payees),
    s.nonce,
    s.expiry,
  );
}

/** REVOKE_AGENT. */
export function revokeAgentDigest(domain: Domain, s: Signed): Hex {
  return actionDigest(domain, s.vaultId, Action.REVOKE_AGENT, argsHash.revokeAgent(), s.nonce, s.expiry);
}

/** ROTATE_KEY: signed by the CURRENT device key. DEVICE mode only. */
export function rotateKeyDigest(domain: Domain, s: Signed, newPubkeyHash: Hex): Hex {
  return actionDigest(domain, s.vaultId, Action.ROTATE_KEY, argsHash.rotateKey(newPubkeyHash), s.nonce, s.expiry);
}

/** ROTATE_KEY_POP: signed by the NEW device key, same vaultId, nonce and expiry as rotateKeyDigest. */
export function rotateKeyPopDigest(domain: Domain, s: Signed, newPubkeyHash: Hex): Hex {
  return actionDigest(
    domain,
    s.vaultId,
    Action.ROTATE_KEY_POP,
    argsHash.rotateKey(newPubkeyHash),
    s.nonce,
    s.expiry,
  );
}

/** CLOSE: withdraw everything to `to` and close the vault. */
export function closeDigest(domain: Domain, s: Signed, to: Address): Hex {
  return actionDigest(domain, s.vaultId, Action.CLOSE, argsHash.close(to), s.nonce, s.expiry);
}

/**
 * SET_PAYOUT: signed by the HEIR's registered account key. `s.nonce` is heirNonce(vaultId, heir),
 * not the vault nonce.
 */
export function setPayoutDigest(domain: Domain, s: Signed, heirIndex: bigint, heir: Address, newPayout: Address): Hex {
  return actionDigest(
    domain,
    s.vaultId,
    Action.SET_PAYOUT,
    argsHash.setPayout(heirIndex, heir, newPayout),
    s.nonce,
    s.expiry,
  );
}

// ---------------------------------------------------------- derived helpers

/** Mirror of the contract's state derivation for a vault whose stored status is ACTIVE. */
export function deriveActiveState(lastCheckin: bigint, interval: bigint, grace: number, now: bigint): State {
  if (now < lastCheckin + interval) return State.ALIVE;
  if (now < lastCheckin + interval * BigInt(grace + 1)) return State.WARNING;
  return State.OVERDUE;
}

/** Mirror of the trigger bounty: min(bounty, 10% of the native balance). */
export function triggerBounty(bounty: bigint, nativeBalance: bigint): bigint {
  const cap = (nativeBalance * MAX_BOUNTY_BPS) / 10000n;
  return bounty < cap ? bounty : cap;
}

/** Mirror of the settlement split: floor shares, the last heir takes the remainder. */
export function splitShares(total: bigint, bps: readonly number[]): bigint[] {
  const out: bigint[] = [];
  let paid = 0n;
  for (let i = 0; i < bps.length; i++) {
    const share = i === bps.length - 1 ? total - paid : (total * BigInt(bps[i])) / 10000n;
    out.push(share);
    paid += share;
  }
  return out;
}
