/**
 * A ready-made demo/test world: sim chain + deployed QDMVault + TestToken + named accounts with
 * deterministic ML-DSA keys. Isomorphic: pass the compiled artifacts in (node: sim/node.ts loaders;
 * browser: bundled JSON), so the app's Demo mode and the vitest suites start from the exact same state.
 */
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { pqKeygen, type PqKeyPair } from "../lib/pq.ts";
import { QoreSim, type ContractArtifact, type SimOptions, type TxResult } from "./chain.ts";
import { VaultClient, simBackend } from "./client.ts";

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export const ETH = 10n ** 18n;

/** Deterministic addresses so snapshots and docs are stable. */
export const ACCOUNTS = {
  deployer: "0x00000000000000000000000000000000000d3910",
  owner: "0x0000000000000000000000000000000000000a11",
  heir1: "0x0000000000000000000000000000000000000b01",
  heir2: "0x0000000000000000000000000000000000000b02",
  heir3: "0x0000000000000000000000000000000000000b03",
  heirPayout1: "0x0000000000000000000000000000000000000c01",
  heirPayout2: "0x0000000000000000000000000000000000000c02",
  heirPayout3: "0x0000000000000000000000000000000000000c03",
  agent: "0x0000000000000000000000000000000000000d01",
  payee: "0x0000000000000000000000000000000000000e01",
  relayer: "0x0000000000000000000000000000000000000f01",
  keeper: "0x0000000000000000000000000000000000000f02",
  attacker: "0x000000000000000000000000000000000000dead",
} as const satisfies Record<string, Address>;

const seedOf = (n: number) => new Uint8Array(32).fill(n);

export interface World {
  sim: QoreSim;
  client: VaultClient;
  vault: Address;
  token: Address;
  tokenAbi: ContractArtifact["abi"];
  accounts: typeof ACCOUNTS;
  /** Account-registered keys (owner + heirs) and a DEVICE key + spare device key for rotation. */
  keys: { owner: PqKeyPair; heir1: PqKeyPair; heir2: PqKeyPair; heir3: PqKeyPair; device: PqKeyPair; device2: PqKeyPair };
  tokenBalance(who: Address): Promise<bigint>;
  tokenTransfer(from: Address, to: Address, amount: bigint): Promise<TxResult>;
  tokenApprove(from: Address, spender: Address, amount: bigint): Promise<TxResult>;
}

export async function createWorld(
  artifacts: { vault: ContractArtifact; token: ContractArtifact },
  opts: SimOptions & { ownerFunds?: bigint } = {},
): Promise<World> {
  const sim = await QoreSim.create(opts);
  const A = ACCOUNTS;
  for (const a of Object.values(A)) await sim.fund(a, 1_000n * ETH);

  const keys = {
    owner: pqKeygen(seedOf(1)),
    heir1: pqKeygen(seedOf(2)),
    heir2: pqKeygen(seedOf(3)),
    heir3: pqKeygen(seedOf(4)),
    device: pqKeygen(seedOf(5)),
    device2: pqKeygen(seedOf(6)),
  };
  // QoreChain gives every account a registered, possession-proven ML-DSA-87 key.
  sim.registerAccountKey(A.owner, keys.owner.publicKey);
  sim.registerAccountKey(A.heir1, keys.heir1.publicKey);
  sim.registerAccountKey(A.heir2, keys.heir2.publicKey);
  sim.registerAccountKey(A.heir3, keys.heir3.publicKey);

  const v = await sim.deploy(artifacts.vault, [], A.deployer);
  const supply = 1_000_000n * ETH;
  const t = await sim.deploy(artifacts.token, ["Test USD", "fUSD", A.deployer, supply], A.deployer);
  const client = new VaultClient(simBackend(sim), v.address, artifacts.vault.abi, A.relayer);

  const world: World = {
    sim,
    client,
    vault: v.address,
    token: t.address,
    tokenAbi: artifacts.token.abi,
    accounts: A,
    keys,
    async tokenBalance(who) {
      const r = await sim.call({ from: A.deployer, to: t.address, data: encodeFunctionData({ abi: ERC20, functionName: "balanceOf", args: [who] }) });
      return decodeFunctionResult({ abi: ERC20, functionName: "balanceOf", data: r.returnData as Hex }) as bigint;
    },
    tokenTransfer: (from, to, amount) =>
      sim.send({ from, to: t.address, data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [to, amount] }) }),
    tokenApprove: (from, spender, amount) =>
      sim.send({ from, to: t.address, data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [spender, amount] }) }),
  };
  await world.tokenTransfer(A.deployer, A.owner, 10_000n * ETH);
  await world.tokenTransfer(A.deployer, A.agent, 100n * ETH);
  return world;
}
