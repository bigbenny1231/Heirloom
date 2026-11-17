/** Node-only test helpers shared by the vitest suites. */
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { KeyMode, type CreateParams, type Heir } from "../lib/encoding.ts";
import type { TxResult } from "./chain.ts";
import { loadTokenArtifact, loadVaultArtifact } from "./node.ts";
import { ACCOUNTS, ETH, createWorld, type World } from "./world.ts";
import { expectOk } from "./client.ts";

export { ACCOUNTS, ETH };

export const newWorld = (opts?: Parameters<typeof createWorld>[1]) =>
  createWorld({ vault: loadVaultArtifact(), token: loadTokenArtifact() }, opts);

export const salt = (n: number): Hex => keccak256(encodeAbiParameters([{ type: "uint256" }], [BigInt(n)]));

export function heirs3(): Heir[] {
  return [
    { account: ACCOUNTS.heir1, payoutTo: ACCOUNTS.heirPayout1, bps: 5000 },
    { account: ACCOUNTS.heir2, payoutTo: ACCOUNTS.heirPayout2, bps: 3000 },
    { account: ACCOUNTS.heir3, payoutTo: ACCOUNTS.heirPayout3, bps: 2000 },
  ];
}

export function params(w: World, n: number, over: Partial<CreateParams> = {}): CreateParams {
  return {
    salt: salt(n),
    interval: 3600n,
    grace: 1,
    bounty: ETH / 100n,
    tokens: [w.token],
    heirs: heirs3(),
    ...over,
  };
}

/** Create an ACCOUNT-mode vault via the signed path (createVaultFor), funded with `native`. */
export async function accountVault(w: World, n = 1, native = 10n * ETH, over: Partial<CreateParams> = {}) {
  const r = await w.client.createVaultFor({
    owner: ACCOUNTS.owner,
    keyMode: KeyMode.ACCOUNT,
    key: w.keys.owner,
    params: params(w, n, over),
    value: native,
  });
  expectOk(r.tx);
  return r.vaultId;
}

export async function deviceVault(w: World, n = 2, native = 10n * ETH, over: Partial<CreateParams> = {}) {
  const r = await w.client.createVaultFor({
    owner: ACCOUNTS.owner,
    keyMode: KeyMode.DEVICE,
    key: w.keys.device,
    params: params(w, n, over),
    value: native,
  });
  expectOk(r.tx);
  return r.vaultId;
}

export const names = (tx: TxResult) => tx.events.map((e) => e.eventName);
export const ev = (tx: TxResult, name: string) => tx.events.find((e) => e.eventName === name);
export type { Address };
