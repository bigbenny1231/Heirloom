# SPEC changes

Deviations from `SPEC.md`, in the order they were made. Items 1 to 6 come from the contract and test build.

1. **pqcKeyStatus answer shapes (SPEC section 9).** `PQC.accountKey` now parses the raw returndata and accepts both the
   4-value form (`registered, algorithmId, pubkey, possessionProven`, bytes offset 0x80) and the 3-value form of the
   `@qorechain/evm` 0.14.0 ABI (`registered, algorithmId, pubkey`, offset 0x60). Rules: bool words must be 0/1, algorithm word
   <= 255, offset must be 0x80 or 0x60, the bytes block must lie inside the returndata, length must be 2592, a 4-value answer
   with `possessionProven == false` is rejected. Malformed answers revert `PrecompileUnavailable(0x...0a02)`.
   A 3-value answer cannot show possession, so:
   - owner actions, `setPayout` and `createVaultFor` (ACCOUNT) accept it; `createVaultFor` carries an ML-DSA signature over the CREATE
     digest verified against that same registry key, which is the proof of possession;
   - `createVault` (msg.sender, no signature) uses `PQC.accountKeyProven` and **reverts `PQKeyPossessionNotProven` on a 3-value
     answer**. We kept the `createVault(CreateParams)` signature unchanged (no extra PoP parameter) so app/scripts/sim are not
     affected; on a chain that answers 3 values use `createVaultFor`.
   Builder B (`sim/precompiles.ts`): add a 3-value mode (`abi.encode(bool,uint8,bytes)`); in that mode `createVault` must revert.
2. **evmVersion = paris** in `hardhat.config.ts` (SPEC silent). Avoids PUSH0/MCOPY/transient storage in case the QoreChain EVM
   predates Shanghai/Cancun. Deployed size 21,170 bytes (limit 24,576).
3. `settle` push to a token address without code counts as a failed push (credited), instead of a silent "success" of a call to an
   empty account. Not in SPEC; strictly safer.
4. Revert precedence for `rotateKey` on an unknown vault id is `VaultNotFound` (the key-mode check is skipped when status is NONE).
5. `tsconfig.json` (shared, rewritten by another builder to ESNext/Bundler): I only added `hardhat.config.ts` and
   `artifacts/**/*.d.ts` to `include` so hardhat-viem types resolve. `lib/encoding.ts` is unchanged.
6. Vendored `lib-sol/forge-std` (commit in `lib-sol/FORGE_STD_COMMIT`, git metadata and tests removed) for the Solidity
   fuzz/invariant tests in `contracts/test/QDMVault.t.sol`, imported by relative path.

## Findings worth knowing (no change made)

- **ACCOUNT mode trusts the chain's key registry.** The vault follows `pqcKeyStatus(owner)` live. If the chain ever let the
  classical key alone re-register a different ML-DSA key for an account, an ACCOUNT vault would follow it (documented by a
  test in `test/09-qday-drill.test.ts`). DEVICE mode pins the key hash and is immune. Before the drill, confirm re-registration
  needs the hybrid signature; if in doubt, run the drill vault in DEVICE mode.
- Test harness note: the mock precompile lives at fixed addresses and `setCode` does not clear storage. `MockQorePQC` now has an
  `epoch` (all registrations are keyed by it) and `reset()`; `deployWorld` calls `reset()` on both addresses after installing the
  code, so no registration, flag or raw answer leaks between fixtures or test files that share one network. Test helpers moved from
  `test/helpers` to `testkit/` so they are not run as tests. `hardhat.config.ts` pins the simulated hardfork to cancun
  (the default, osaka, adds the EIP-7623 calldata floor and distorts the gas report). The gas report measures against
  `StubQorePQC` and adds the documented precompile prices; it is an estimate.

## Pre-submission audit (Nov 15, 2026)

No contract change. Tooling, app and documentation only:

7. **Key-status decoder in the scripts (`scripts/lib/pure.ts`).** `decodeKeyStatus` used to accept only the two byte lengths of
   a registered 2592-byte key. QoreChain documents `false, 0, 0x, false` for an account with no key (160 bytes), which the
   probe would have reported as "malformed". The decoder now reads the shape from the offset word and requires the exact
   total length for whatever key length is declared, so it stays strict and reads the "no key" answer in both shapes.
8. **Native transactions retry once on a stale sequence (`scripts/lib/chain.ts`).** A transaction refused with "account
   sequence mismatch" was never accepted, so the script reads the sequence again and signs once more. This covers a REST
   endpoint that is a block behind the node that included the previous transaction.
9. **Deploy prints `qor1` forms** of the contract addresses, because the project form asks for a `qor1` testnet address.
10. **App.** A backup string is tied to the key it was made from and disappears when the key is rotated, imported or
    reset; "Reset the demo" clears every tab's local state; in-page failures (a bad backup string, a refused wallet
    request) are labelled "not sent" instead of "reverted"; amounts below the display precision show as `<0.01` instead of
    a rounded-up figure; the Withdraw and Agent screens say why a triggered or settled vault refuses them; tab, chip and
    small-button tap targets are at least 44 px; safe-area insets on all sides; arrow, Home and End keys move focus with
    the selected tab.
11. **Interop test** (`scripts/lib/interop.test.ts`): signatures from `lib/pq.ts` verify under `@qorechain/pqc` and are
    byte-identical to what that library produces, and its hedged signatures verify under ours.
