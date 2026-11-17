/**
 * Gas report (an ESTIMATE). The vault is measured against StubQorePQC (no storage reads, constant answers), so the numbers
 * contain our own code, calldata and memory work but not the precompiles. The documented precompile prices are then added:
 * pqcVerify = 25,000 + 8/byte of ABI-encoded input, pqcKeyStatus = 2,500. Hardfork is pinned to cancun in hardhat.config.ts
 * (the default, osaka, adds the EIP-7623 calldata floor). The sim (sim/timing.test.ts) prints its own real-priced numbers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { zeroAddress, type Address, type Hex } from "viem";
import { PQC_KEY_STATUS_ADDRESS, PQC_VERIFY_ADDRESS } from "../lib/encoding.js";
import {
  testClient, viem, E18, act, deployToken, deployWorld, depositTokenTo, makeAccountVault, makeAccountVaultFor, makeDeviceVault, networkHelpers, now,
  overdueAndTrigger, ownerDo, parseEther, publicClient, pqKey, registerHeirs, signAuth, signPayout, registerAccount, type Scenario,
} from "../testkit/harness.js";

const A = (a: { account: { address: Address } }) => a.account.address;
// ABI: selector + 3 offsets + 3 lengths + pubkey(2592) + sig(4627 padded to 4640) + message(32)
const VERIFY_INPUT_BYTES = 4 + 6 * 32 + 2592 + 4640 + 32;
const VERIFY_GAS = 25_000 + 8 * VERIFY_INPUT_BYTES;
const KEYSTATUS_GAS = 2_500;

const rows: { name: string; gas: bigint; verifies: number; keyStatus: number }[] = [];
async function rec(name: string, hash: Hex, verifies: number, keyStatus: number) {
  const rc = await publicClient.getTransactionReceipt({ hash });
  rows.push({ name, gas: rc.gasUsed, verifies, keyStatus });
  return rc.gasUsed;
}

describe("gas report", () => {
  it("measures every action", async () => {
    const w = await networkHelpers.loadFixture(deployWorld);
    const stub = await viem.deployContract("StubQorePQC");
    const stubCode = (await publicClient.getCode({ address: stub.address }))!;
    await testClient.setCode({ address: PQC_VERIFY_ADDRESS, bytecode: stubCode });
    await testClient.setCode({ address: PQC_KEY_STATUS_ADDRESS, bytecode: stubCode });
    await registerHeirs(w);
    const t1 = await deployToken(w, "G1");
    const t2 = await deployToken(w, "G2");
    const heirs = [
      { account: A(w.heir1), payoutTo: A(w.heir1), bps: 5000 },
      { account: A(w.heir2), payoutTo: A(w.heir2), bps: 3000 },
      { account: A(w.heir3), payoutTo: A(w.heir3), bps: 2000 },
    ];
    // ACCOUNT vault via createVault (1 key status call)
    const acc = await makeAccountVault(w, { interval: 3600n, grace: 1, tokens: [t1.address, t2.address], heirs }, 0n);
    rows.push({ name: "createVault (ACCOUNT, 3 heirs, 2 tokens)", gas: 0n, verifies: 0, keyStatus: 1 });
    // measure createVault precisely on a second vault
    await registerAccount(w, A(w.owner), pqKey("owner"));
    const h = await w.vault.write.createVault([{ salt: "0x" + "ee".repeat(32) as Hex, interval: 3600n, grace: 1, bounty: 0n, tokens: [t1.address, t2.address], heirs }], { account: w.owner.account });
    rows.pop();
    await rec("createVault (ACCOUNT, 3 heirs, 2 tokens)", h, 0, 1);

    const dev = await makeDeviceVault(w, { interval: 3600n, grace: 1, tokens: [t1.address, t2.address], heirs, salt: "0x" + "dd".repeat(32) as Hex }, 0n);

    await rec("depositNative", await w.vault.write.depositNative([acc.vaultId], { value: parseEther("5") }), 0, 0);
    await t1.write.approve([w.vault.address, 10n ** 30n], { account: w.deployer.account });
    await t2.write.approve([w.vault.address, 10n ** 30n], { account: w.deployer.account });
    await rec("depositToken", await w.vault.write.depositToken([acc.vaultId, t1.address, 1000n * E18], { account: w.deployer.account }), 0, 0);
    await w.vault.write.depositToken([acc.vaultId, t2.address, 1000n * E18], { account: w.deployer.account });
    await w.vault.write.depositNative([dev.vaultId], { value: parseEther("5") });

    const run = async (s: Scenario, a: ReturnType<typeof act.checkIn>, label: string, v: number, ks: number) => {
      const auth = await signAuth(s.w, s.vaultId, s.key, s.mode, a.digest);
      await rec(label, await a.send(s.w, s.vaultId, auth), v, ks);
    };
    await run(acc, act.checkIn(), "checkIn (ACCOUNT)", 1, 1);
    await run(dev, act.checkIn(), "checkIn (DEVICE)", 1, 0);
    await run(acc, act.withdraw(zeroAddress, parseEther("1"), A(w.payee1)), "withdraw native (ACCOUNT)", 1, 1);
    await run(dev, act.withdraw(zeroAddress, parseEther("1"), A(w.payee1)), "withdraw native (DEVICE)", 1, 0);
    await run(acc, act.withdraw(t1.address, 10n * E18, A(w.payee1)), "withdraw token (ACCOUNT)", 1, 1);
    await run(acc, act.setHeirs(heirs), "setHeirs 3 heirs (ACCOUNT)", 1, 1);
    await run(acc, act.setTiming(7200n, 1, 0n), "setTiming (ACCOUNT)", 1, 1);
    await run(acc, act.setAgent(A(w.agent), zeroAddress, 10n ** 17n, 10n ** 18n, (await now()) + 86400n, [A(w.payee1), A(w.payee2)]), "setAgent 2 payees (ACCOUNT)", 1, 1);
    await rec("agentPay (native)", await w.vault.write.agentPay([acc.vaultId, A(w.payee1), 10n ** 16n], { account: w.agent.account }), 0, 0);
    await run(acc, act.revokeAgent(), "revokeAgent (ACCOUNT)", 1, 1);
    await run(dev, act.rotate(pqKey("gas-new")), "rotateKey (DEVICE, 2 verifies)", 2, 0);

    const au = await signPayout(w, acc.vaultId, pqKey("heir1"), 0n, A(w.heir1), A(w.payee3));
    await rec("setPayout (heir key)", await w.vault.write.setPayout([acc.vaultId, 0n, A(w.payee3), au.nonce, au.expiry, au.sig], { account: w.relayer.account }), 1, 1);

    // trigger + settle: vault `acc` with native + 2 tokens, 3 heirs
    await overdueAndTrigger(w, acc.vaultId).then((hash) => rec("trigger (no bounty)", hash, 0, 0));
    await rec("settle (3 heirs, native + 2 tokens = 9 pushes)", await w.vault.write.settle([acc.vaultId], { account: w.relayer.account }), 0, 0);

    // settle with native only, 3 heirs
    const s2 = await makeAccountVault(w, { interval: 60n, grace: 0, heirs, salt: "0x" + "cc".repeat(32) as Hex }, parseEther("3"));
    await overdueAndTrigger(w, s2.vaultId);
    await rec("settle (3 heirs, native only = 3 pushes)", await w.vault.write.settle([s2.vaultId], { account: w.relayer.account }), 0, 0);

    // settle with 10 heirs, native + 4 tokens worst case = 50 pushes
    const t3 = await deployToken(w, "G3");
    const t4 = await deployToken(w, "G4");
    const ten = w.wallets.slice(1, 11).map((x) => ({ account: A(x), payoutTo: A(x), bps: 1000 }));
    const s3 = await makeAccountVault(w, { interval: 60n, grace: 0, heirs: ten, tokens: [t1.address, t2.address, t3.address, t4.address], salt: "0x" + "bb".repeat(32) as Hex }, parseEther("10"));
    for (const t of [t1, t2, t3, t4]) {
      await t.write.approve([w.vault.address, 10n ** 30n], { account: w.deployer.account });
      await w.vault.write.depositToken([s3.vaultId, t.address, 1_000_000n], { account: w.deployer.account });
    }
    await overdueAndTrigger(w, s3.vaultId);
    await rec("settle WORST CASE (10 heirs x native + 4 tokens = 50 pushes)", await w.vault.write.settle([s3.vaultId], { account: w.relayer.account }), 0, 0);

    // close with 2 tokens
    const c = await makeAccountVaultFor(w, { interval: 3600n, grace: 1, tokens: [t1.address, t2.address], heirs, salt: "0x" + "aa".repeat(32) as Hex }, parseEther("1"));
    await depositTokenTo(w, c, t1, w.deployer, 5n);
    await depositTokenTo(w, c, t2, w.deployer, 5n);
    await run(c, act.close(A(w.payee1)), "close (native + 2 tokens)", 1, 1);

    console.log("\n  ESTIMATE. Gas per action: measured against a stub precompile | + documented precompile prices");
    console.log("  " + "-".repeat(96));
    for (const r of rows) {
      const est = r.gas + BigInt(r.verifies) * BigInt(VERIFY_GAS) + BigInt(r.keyStatus) * BigInt(KEYSTATUS_GAS);
      console.log(`  ${r.name.padEnd(62)} ${String(r.gas).padStart(9)}  | ${String(est).padStart(9)}`);
    }
    console.log(`  (pqcVerify input ~${VERIFY_INPUT_BYTES} bytes => ${VERIFY_GAS} gas each; pqcKeyStatus ${KEYSTATUS_GAS})\n`);

    const get = (n: string) => rows.find((r) => r.name.startsWith(n))!;
    const est = (n: string) => { const r = get(n); return r.gas + BigInt(r.verifies) * BigInt(VERIFY_GAS) + BigInt(r.keyStatus) * BigInt(KEYSTATUS_GAS); };
    assert.ok(get("settle WORST").gas < 8_000_000n, "worst-case settle must fit in a normal block");
    // our own code + 7 KB of signature calldata: bounded, and the pqcVerify price dominates the estimate
    assert.ok(get("checkIn (DEVICE)").gas > 100_000n && get("checkIn (DEVICE)").gas < 250_000n, `checkIn own gas ${get("checkIn (DEVICE)").gas}`);
    assert.ok(est("checkIn (DEVICE)") > 200_000n && est("checkIn (DEVICE)") < 400_000n);
    assert.ok(est("checkIn (ACCOUNT)") - est("checkIn (DEVICE)") < 20_000n, "ACCOUNT mode adds only the key-status call and a 2.6 KB copy");
    assert.ok(est("rotateKey") > est("checkIn (DEVICE)") + 80_000n, "rotation costs a second verify");
    assert.ok(get("settle (3 heirs, native + 2 tokens").gas < get("settle WORST").gas);
    assert.ok(rows.every((r) => r.gas > 0n));
  });
});
