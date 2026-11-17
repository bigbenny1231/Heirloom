# Security

## Status

Heirloom (Quantum Dead Man's Vault) is a hackathon project for QoreChain testnet. It has not had an external or human audit. Do not use it with real funds.

What has been checked (Nov 15, 2026):

- **Contract review.** An independent AI security review of `contracts/QDMVault.sol` and `contracts/libraries/PQC.sol` found no critical or high issues. Two low findings were fixed: vault ids now commit to every creation parameter, and the settle gas check now includes the call's own overhead. Proof-of-concept tests were written for each finding.
- **Tests.** 192 Hardhat tests (including 6 Solidity fuzz/invariant tests) and 53 simulator tests that run the real bytecode with real ML-DSA-87 verification. A mutation-testing review planted 42 bugs in the contract; 39 were caught, and tests were added for the 3 that were not.
- **Drill model.** The drill bot holds only the owner's classical key and tries every drain and stall path. It moves no value. A negative control with a verifier that accepts everything shows the drill would detect a broken check.
- **Repository hygiene.** No keys, mnemonics or tokens are committed (the only phrases in the repo are public test vectors). Workflows that use secrets run only on manual or scheduled triggers, never on pull requests, and never print secrets or the drill key. Actions are pinned to commit SHAs with read-only permissions.

## Dependencies

`npm audit --omit=dev` reports no vulnerabilities: the project has no runtime dependencies. The contract uses OpenZeppelin Contracts 5.1 at compile time only.

`npm audit` reports advisories in development tooling only (Hardhat 3 through its `zod` dependency, Vitest and its worker pool, the `tmp` helper inside `solc`'s CLI, and `ws` inside viem's WebSocket transport). None of this code is part of the deployed contract, and the app bundle uses only browser APIs. The affected paths need a developer to run a local dev or test UI server, or to feed untrusted input to the tooling. Upgrades will be applied when the upstream packages ship fixes that are compatible with Hardhat 3.

## Trust assumptions

See [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md). In short: ACCOUNT-mode vaults trust QoreChain's rule that a registered ML-DSA-87 key can only be replaced with the old key's signature; DEVICE-mode vaults pin the key hash and don't depend on that rule.

## Reporting a problem

Please open a private security advisory on this repository (Security tab > Report a vulnerability) rather than a public issue.
