/**
 * Q-Day drill bot. Models the hackathon's attacker: it holds the owner's CLASSICAL (ECDSA) key only, so
 * it can send any transaction as the owner (the sim lets it assert `from`), but it has no ML-DSA secret
 * and cannot forge a post-quantum signature. It tries every drain / stall path it can think of and
 * records, per attack, what happened and how much value moved.
 *
 * Reusable: the app renders `DrillReport`, tests assert `zeroValueMoved`.
 * Browser-safe.
 */
import {
  bytesToHex,
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import {
  KeyMode,
  NATIVE,
  State,
  checkInDigest,
  closeDigest,
  rotateKeyDigest,
  revokeAgentDigest,
  rotateKeyPopDigest,
  setAgentDigest,
  setHeirsDigest,
  setPayoutDigest,
  setTimingDigest,
  withdrawDigest,
  pubkeyHash,
  PQ_SIGNATURE_LENGTH,
  MAX_INTERVAL,
  type Signed,
} from "../lib/encoding.ts";
import { pqKeygen, pqSign } from "../lib/pq.ts";
import type { QoreSim, TxResult } from "./chain.ts";
import type { AuthStruct, VaultClient } from "./client.ts";

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
]);

export type DrillCategory =
  | "no-signature"
  | "garbage-signature"
  | "wrong-key"
  | "expired"
  | "replay"
  | "cross-vault"
  | "stall"
  | "agent"
  | "erc20"
  | "early"
  | "direct-send"
  | "heir";

/** A signed owner action the attacker saw on-chain earlier (calldata is public). args = full call args, auth last. */
export interface ObservedAction {
  fn: "checkIn" | "withdraw" | "setHeirs" | "setTiming" | "setAgent" | "revokeAgent" | "close" | "rotateKey";
  args: readonly unknown[];
}

export interface DrillOptions {
  sim: QoreSim;
  client: VaultClient;
  vaultId: bigint;
  /** The account whose ECDSA key the attacker holds. The drill sends txs as this address. */
  owner: Address;
  /** Where stolen funds would go. Default: a fixed address. */
  attacker?: Address;
  /** Past valid signed actions (replay / cross-vault material). */
  observed?: readonly ObservedAction[];
  /** DEVICE vaults: the owner's public key, visible in earlier calldata. Lets garbage-sig attacks reach the signature check. */
  ownerPubkey?: Hex;
  /** Seed for the attacker's own (wrong) ML-DSA key. */
  seed?: Uint8Array;
  /** Called after each attack (for live UIs). */
  onAttack?: (a: DrillAttack) => void;
}

export interface DrillAttack {
  id: string;
  category: DrillCategory;
  title: string;
  fn: string;
  sender: Address;
  /** "rejected" = tx reverted. "executed" = tx succeeded (a successful attack unless it moved nothing and changed nothing). */
  outcome: "rejected" | "executed";
  revertName?: string;
  revertReason?: string;
  /** Value that left the contract's custody or arrived at the owner/attacker addresses, per asset. */
  movedNative: bigint;
  movedTokens: Record<string, bigint>;
  /** Sum of raw units across assets (use the per-asset fields for display). */
  valueMoved: bigint;
  /** Vault nonce / lastCheckin / timing / status / heirs / agent changed. */
  vaultMutated: boolean;
  /** Who stopped it: the vault contract, the token's own allowance check, or nobody (executed). */
  blockedBy?: "vault" | "token";
  /** True if this attack's tx made at least one pqcVerify call (so the signature check itself decided). */
  reachedVerifier: boolean;
  tx: TxResult;
}

export interface DrillReport {
  vaultId: bigint;
  attacks: DrillAttack[];
  attempted: number;
  rejected: number;
  executed: number;
  totalMovedNative: bigint;
  totalMovedTokens: Record<string, bigint>;
  vaultMutated: boolean;
  /** Unique (function, attack category) pairs tried. */
  distinctPaths: number;
  /** Attacks whose tx reached the pqcVerify precompile. */
  reachedVerifier: number;
  /** What this drill does and does not cover. */
  scope: string;
  /** Attacks not run because they would not be attacks in this vault state. */
  skipped: string[];
  /** True iff no attack moved any value AND none mutated the vault. */
  zeroValueMoved: boolean;
}

interface Snapshot {
  contractNative: bigint;
  partyNative: bigint;
  contractToken: Record<string, bigint>;
  partyToken: Record<string, bigint>;
  fingerprint: string;
}

function junk(n: number, seed: number): Hex {
  const b = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    b[i] = x & 0xff;
  }
  return bytesToHex(b);
}

export const DRILL_SCOPE =
  "Contract-level attacks only. QoreChain itself also refuses classical-only native transfers and EVM windows; those chain-level checks are not simulated here.";

export async function runDrill(opts: DrillOptions): Promise<DrillReport> {
  const { sim, client, vaultId, owner } = opts;
  const attacker: Address = opts.attacker ?? "0x000000000000000000000000000000000000dead";
  const domain = client.domain;
  const tokens = [...(await client.getTokens(vaultId))];
  const v0 = await client.getVault(vaultId);
  const device = v0.keyMode === KeyMode.DEVICE;
  const evil = pqKeygen(opts.seed ?? new Uint8Array(32).fill(0xbd));
  const evilPk = bytesToHex(evil.publicKey);
  const evilNew = pqKeygen(new Uint8Array(32).fill(0xbe)); // pretend new key for rotateKey attempts
  const evilNewPk = bytesToHex(evilNew.publicKey);

  // ---------------------------------------------------------------- snapshots
  const tokenBal = async (t: Address, who: Address): Promise<bigint> => {
    const r = await sim.call({ from: attacker, to: t, data: encodeFunctionData({ abi: ERC20, functionName: "balanceOf", args: [who] }) });
    return r.ok ? (decodeFunctionResult({ abi: ERC20, functionName: "balanceOf", data: r.returnData }) as bigint) : 0n;
  };
  const snap = async (): Promise<Snapshot> => {
    const v = await client.getVault(vaultId);
    const heirs = await client.getHeirs(vaultId);
    const agent = await client.getAgent(vaultId);
    const contractToken: Record<string, bigint> = {};
    const partyToken: Record<string, bigint> = {};
    for (const t of tokens) {
      contractToken[t] = (await tokenBal(t, client.vault)) ;
      partyToken[t] = (await tokenBal(t, attacker)) + (await tokenBal(t, owner));
    }
    return {
      contractNative: await sim.balanceOf(client.vault),
      partyNative: (await sim.balanceOf(attacker)) + (await sim.balanceOf(owner)),
      contractToken,
      partyToken,
      fingerprint: JSON.stringify(
        { s: v.status, n: v.nonce, l: v.lastCheckin, i: v.interval, g: v.grace, b: v.bounty, h: heirs, a: agent },
        (_k, x) => (typeof x === "bigint" ? x.toString() : x),
      ),
    };
  };

  const max0 = (x: bigint) => (x > 0n ? x : 0n);
  const attacks: DrillAttack[] = [];

  async function attempt(
    id: string,
    category: DrillCategory,
    title: string,
    fn: string,
    sender: Address,
    run: () => Promise<TxResult>,
    refusedLabel?: string,
  ) {
    // Every attack runs against the same pristine state: one success must not mask the next.
    const restore = await sim.snapshot();
    const before = await snap();
    const verifies0 = sim.pqc.verifyCalls;
    const tx = await run();
    const reachedVerifier = sim.pqc.verifyCalls > verifies0;
    const after = await snap();
    await restore();
    const nLoss = max0(before.contractNative - after.contractNative);
    const nGain = max0(after.partyNative - before.partyNative);
    const movedNative = nLoss > nGain ? nLoss : nGain;
    const movedTokens: Record<string, bigint> = {};
    let sum = movedNative;
    for (const t of tokens) {
      const loss = max0(before.contractToken[t] - after.contractToken[t]);
      const gain = max0(after.partyToken[t] - before.partyToken[t]);
      movedTokens[t] = loss > gain ? loss : gain;
      sum += movedTokens[t];
    }
    const a: DrillAttack = {
      id,
      category,
      title,
      fn,
      sender,
      outcome: tx.ok ? "executed" : "rejected",
      revertName: tx.revert?.name,
      revertReason: refusedLabel && tx.revert?.data === "0x" ? refusedLabel : tx.revert?.reason,
      movedNative,
      movedTokens,
      valueMoved: sum,
      vaultMutated: before.fingerprint !== after.fingerprint,
      blockedBy: !tx.ok ? (tx.revert?.name.startsWith("ERC20") ? "token" : "vault") : undefined,
      reachedVerifier,
      tx,
    };
    attacks.push(a);
    opts.onAttack?.(a);
  }

  // ---------------------------------------------- owner-action attack catalogue
  const nowTs = await client.backend.now();
  const nonceNow = v0.nonce;
  const futureExpiry = nowTs + 600n;

  interface Spec {
    fn: string;
    label: string;
    stall?: boolean;
    /** args between vaultId and auth. */
    mid(): unknown[];
    digest(s: Signed): Hex;
  }
  const allNative = await client.balanceOf(vaultId, NATIVE);
  const allToken = tokens[0] ? await client.balanceOf(vaultId, tokens[0]) : 0n;
  const specs: Spec[] = [
    { fn: "checkIn", label: "check in to stall the heirs", stall: true, mid: () => [], digest: (s) => checkInDigest(domain, s) },
    {
      fn: "withdraw",
      label: "withdraw all native funds to the attacker",
      mid: () => [NATIVE, allNative > 0n ? allNative : 1n, attacker],
      digest: (s) => withdrawDigest(domain, s, NATIVE, allNative > 0n ? allNative : 1n, attacker),
    },
    ...(tokens[0]
      ? [
          {
            fn: "withdraw",
            label: "withdraw all tokens to the attacker",
            mid: () => [tokens[0], allToken > 0n ? allToken : 1n, attacker],
            digest: (s: Signed) => withdrawDigest(domain, s, tokens[0], allToken > 0n ? allToken : 1n, attacker),
          } satisfies Spec,
        ]
      : []),
    {
      fn: "close",
      label: "close the vault, sweeping everything to the attacker",
      mid: () => [attacker],
      digest: (s) => closeDigest(domain, s, attacker),
    },
    {
      fn: "setHeirs",
      label: "make the attacker the sole heir",
      mid: () => [[{ account: attacker, payoutTo: attacker, bps: 10000 }]],
      digest: (s) => setHeirsDigest(domain, s, [{ account: attacker, payoutTo: attacker, bps: 10000 }]),
    },
    {
      fn: "setTiming",
      label: "stretch the timer to a year to starve the heirs",
      stall: true,
      mid: () => [MAX_INTERVAL, 12, 0n],
      digest: (s) => setTimingDigest(domain, s, MAX_INTERVAL, 12, 0n),
    },
    {
      fn: "setAgent",
      label: "install the attacker as an unlimited agent",
      mid: () => [attacker, NATIVE, 10n ** 30n, 10n ** 30n, nowTs + 86400n * 365n, [attacker]],
      digest: (s) => setAgentDigest(domain, s, attacker, NATIVE, 10n ** 30n, 10n ** 30n, nowTs + 86400n * 365n, [attacker]),
    },
    { fn: "revokeAgent", label: "revoke the agent (also a check-in)", stall: true, mid: () => [], digest: (s) => revokeAgentDigest(domain, s) },
  ];

  const authFor = (sig: Hex, nonce: bigint, expiry: bigint, pubkey: Hex): AuthStruct => ({ nonce, expiry, sig, pubkey });
  const ownerPk = (opts.ownerPubkey ?? evilPk) as Hex;
  const accountPk: Hex = "0x";

  for (const sp of specs) {
    const midArgs = sp.mid();
    const idp = `${sp.fn}${tokens[0] && sp.label.includes("tokens") ? ":token" : ""}`;
    const stallCat: DrillCategory | null = sp.stall ? "stall" : null;

    // 1. no signature at all
    await attempt(`${idp}/none`, stallCat ?? "no-signature", `${sp.label}: no signature`, sp.fn, owner, () =>
      client.send(sp.fn, [vaultId, ...midArgs, authFor("0x", nonceNow, futureExpiry, device ? ownerPk : accountPk)], { sender: owner }),
    );
    // 2. garbage signature of the right length
    await attempt(`${idp}/garbage`, "garbage-signature", `${sp.label}: garbage signature`, sp.fn, owner, () =>
      client.send(sp.fn, [vaultId, ...midArgs, authFor(junk(PQ_SIGNATURE_LENGTH, 7), nonceNow, futureExpiry, device ? ownerPk : accountPk)], { sender: owner }),
    );
    // 3. a perfectly valid ML-DSA signature, but from the attacker's own key
    {
      const s: Signed = { vaultId, nonce: nonceNow, expiry: futureExpiry };
      const sig = bytesToHex(pqSign(sp.digest(s), evil.secretKey));
      await attempt(`${idp}/wrongkey`, "wrong-key", `${sp.label}: valid signature from the attacker's own key`, sp.fn, owner, () =>
        client.send(sp.fn, [vaultId, ...midArgs, authFor(sig, nonceNow, futureExpiry, device ? evilPk : accountPk)], { sender: owner }),
      );
    }
  }

  // rotateKey (DEVICE only; ACCOUNT vaults must reject with WrongKeyMode)
  {
    const newHash = pubkeyHash(evilNew.publicKey);
    const s: Signed = { vaultId, nonce: nonceNow, expiry: futureExpiry };
    const sigOld = bytesToHex(pqSign(rotateKeyDigest(domain, s, newHash), evil.secretKey));
    const pop = bytesToHex(pqSign(rotateKeyPopDigest(domain, s, newHash), evilNew.secretKey));
    await attempt("rotateKey/wrongkey", "wrong-key", "rotate the vault key to the attacker's key (old-key sig from the attacker)", "rotateKey", owner, () =>
      client.send("rotateKey", [vaultId, evilNewPk, pop, authFor(sigOld, nonceNow, futureExpiry, device ? evilPk : accountPk)], { sender: owner }),
    );
    await attempt("rotateKey/none", "no-signature", "rotate the vault key: no signature", "rotateKey", owner, () =>
      client.send("rotateKey", [vaultId, evilNewPk, "0x", authFor("0x", nonceNow, futureExpiry, device ? ownerPk : accountPk)], { sender: owner }),
    );
  }

  // ------------------------------------------------ replay and cross-vault
  for (const [i, o] of (opts.observed ?? []).entries()) {
    const seenVault = o.args[0] as bigint;
    const auth = o.args[o.args.length - 1] as AuthStruct;
    // A verbatim resubmission on a DIFFERENT vault is just the owner's own signed action being relayed there
    // (legitimate, anyone may relay), so only same-vault verbatim replays are attacks.
    if (seenVault === vaultId) {
      const expired = auth.expiry < nowTs;
      await attempt(
        `replay/${i}/${o.fn}`,
        expired ? "expired" : "replay",
        expired
          ? `submit a real owner ${o.fn} signature after its expiry passed`
          : `replay an old valid ${o.fn} signature verbatim`,
        o.fn,
        owner,
        () =>
        client.send(o.fn, [...o.args], { sender: owner }),
      );
    }
    // Patch nonce and expiry to look fresh: the signature covers them, so it must still fail.
    const patched = [vaultId, ...o.args.slice(1, -1), { ...auth, nonce: nonceNow, expiry: futureExpiry }];
    await attempt(
      `replay/${i}/${o.fn}/patched`,
      seenVault === vaultId ? "replay" : "cross-vault",
      seenVault === vaultId
        ? `replay an old ${o.fn} signature with a fresh nonce and expiry patched in`
        : `reuse a signature from vault ${String(seenVault).slice(0, 8)}… on this vault (nonce patched)`,
      o.fn,
      owner,
      () => client.send(o.fn, patched, { sender: owner }),
    );
  }

  // --------------------------------------------------------------- agent paths
  await attempt("agentPay/owner", "agent", "agentPay called as the owner (not the agent)", "agentPay", owner, () =>
    client.agentPay(vaultId, attacker, allNative > 0n ? allNative : 1n, owner),
  );
  await attempt("agentPay/attacker", "agent", "agentPay called from the attacker address", "agentPay", attacker, () =>
    client.agentPay(vaultId, attacker, 1n, attacker),
  );

  // ---------------------------------------------- ERC-20: approve to self, then pull
  if (tokens[0]) {
    const t = tokens[0];
    await attempt("erc20/transferFrom", "erc20", "owner approves itself on the token, then pulls the vault's tokens with transferFrom (stopped by the token's allowance check, not the vault)", "transferFrom", owner, async () => {
      // the approve is harmless (it is the owner's own allowance); the attack is the pull from the vault
      await sim.send({ from: owner, to: t, data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [owner, 2n ** 256n - 1n] }) });
      return sim.send({ from: owner, to: t, data: encodeFunctionData({ abi: ERC20, functionName: "transferFrom", args: [client.vault, owner, 1n] }) });
    });
    await attempt("erc20/transferFrom-attacker", "erc20", "attacker pulls the vault's tokens with transferFrom (stopped by the token's allowance check, not the vault)", "transferFrom", attacker, () =>
      sim.send({ from: attacker, to: t, data: encodeFunctionData({ abi: ERC20, functionName: "transferFrom", args: [client.vault, attacker, 1n] }) }),
    );
  }

  // --------------------------------------------------------------- timing abuse
  // Only meaningful while the vault is not yet overdue: on an overdue vault trigger/settle are the
  // legitimate, anyone-callable inheritance path, not attacks.
  const skipped: string[] = [];
  const state0 = await client.stateOf(vaultId);
  if (state0 === State.ALIVE || state0 === State.WARNING) {
    await attempt("trigger/early", "early", "trigger the inheritance before the vault is overdue", "trigger", owner, () => client.trigger(vaultId, owner));
    await attempt("settle/early", "early", "settle before the vault was triggered", "settle", owner, () => client.settle(vaultId, owner));
    await attempt("claim/early", "early", "claim before settlement", "claim", owner, () => client.claim(vaultId, 0n, NATIVE, owner));
  } else {
    skipped.push("trigger/early", "settle/early", "claim/early (vault is already overdue or beyond)");
  }

  // ----------------------------------------------------------- heir redirect
  {
    const heirs = await client.getHeirs(vaultId);
    const heir = heirs[0]?.account;
    if (heir) {
      const hn = await client.heirNonce(vaultId, heir);
      const s: Signed = { vaultId, nonce: hn, expiry: futureExpiry };
      const sigEvil = bytesToHex(pqSign(setPayoutDigest(domain, s, 0n, heir, attacker), evil.secretKey));
      await attempt("setPayout/wrongkey", "heir", "redirect heir 0's payout with a signature from the attacker's key", "setPayout", owner, () =>
        client.send("setPayout", [vaultId, 0n, attacker, hn, futureExpiry, sigEvil], { sender: owner }),
      );
      await attempt("setPayout/garbage", "heir", "redirect heir 0's payout with a garbage signature", "setPayout", owner, () =>
        client.send("setPayout", [vaultId, 0n, attacker, hn, futureExpiry, junk(PQ_SIGNATURE_LENGTH, 11)], { sender: owner }),
      );
    }
  }

  // ------------------------------------------------------------- direct send
  await attempt("send/native", "direct-send", "plain transfer to the contract (refused, no receive)", "(send)", owner, () =>
    sim.send({ from: owner, to: client.vault, value: 1n, data: "0x" }),
    "refused (no receive function)",
  );

  const totalTokens: Record<string, bigint> = {};
  for (const a of attacks) for (const [t, n] of Object.entries(a.movedTokens)) totalTokens[t] = (totalTokens[t] ?? 0n) + n;
  const totalNative = attacks.reduce((s, a) => s + a.movedNative, 0n);
  const mutated = attacks.some((a) => a.vaultMutated);
  return {
    vaultId,
    attacks,
    attempted: attacks.length,
    rejected: attacks.filter((a) => a.outcome === "rejected").length,
    executed: attacks.filter((a) => a.outcome === "executed").length,
    totalMovedNative: totalNative,
    totalMovedTokens: totalTokens,
    vaultMutated: mutated,
    distinctPaths: new Set(attacks.map((a) => `${a.fn}:${a.category}`)).size,
    reachedVerifier: attacks.filter((a) => a.reachedVerifier).length,
    scope: DRILL_SCOPE,
    skipped,
    zeroValueMoved: totalNative === 0n && Object.values(totalTokens).every((n) => n === 0n) && !mutated,
  };
}
