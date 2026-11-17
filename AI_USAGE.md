# AI usage

This file describes how Heirloom (Quantum Dead Man's Vault) was built with AI agents, what they produced, what the human author did, and how the outputs were checked. It is written for the Best AI-Native Build award.

## Summary

The project was built by one human owner and a team of AI agents. The owner, Andrew Garretson, chose the idea, set the product and architecture decisions, reviewed the results and made the final calls. An orchestrator Claude session planned the work, split it into parts and dispatched builder agents. Separate reviewer agents judged each part and could block it. Almost all code, tests and documentation in the repository was written by agents. Nothing was merged without passing the checks described below.

Roles: an orchestrator session; an architect agent that wrote the spec; builder agents for each part; a lighter agent for first drafts of the docs; and stronger reviewer agents that judged each part and could block it. All were Claude models from Anthropic.

## Workflow

**1. Direction (human).** The owner chose the idea: a heartbeat inheritance vault, ported from the owner's own NEAR Hackathon entry (Lastword), with the authority moved to post-quantum signatures. The owner set the rules that the design had to meet: the contract is the authority, not the caller; every owner action is a post-quantum check-in; nothing outside the project is touched; no secrets are committed; testnet only; no mainnet.

**2. Specification (orchestrator with the owner).** The orchestrator wrote the decisions and the specification before any code was written: `docs/DECISIONS.md`, `docs/SPEC.md`, `docs/THREAT_MODEL.md`, and the contract interface. The spec fixes the digest encoding, the action list, the state machine, the precompile handling and the test list. The owner approved the plan (a written outline and an interactive mockup) before the build started. The chain facts (testnet chain id, precompile addresses and signature sizes) were taken from QoreChain's documentation and the `@qorechain/evm` package, not from memory.

**3. Parallel builders.** The orchestrator split the work into parts that could be built in parallel, each with a written brief and a shared workspace:

- contract and Hardhat tests (Solidity 0.8.28, OpenZeppelin, Hardhat 3 with viem),
- an in-browser simulator (ethereumjs EVM running the real bytecode, with real ML-DSA-87 precompiles) and the drill bot,
- the React and Vite app (Demo mode on the simulator, Testnet mode through an injected wallet),
- testnet scripts and GitHub Actions workflows (deploy, drill setup, drill proof, drill verify, keeper, PQC probe),
- documentation.

Builders could not reach the network. Testnet code was written and type-checked offline, and it runs only later from GitHub Actions.

**4. Independent review (reviewer agents).** After each part, a reviewer agent that had not written that part reviewed it against the spec and the threat model. Reviews were findings-based. A finding blocked the part until the builder fixed it or the orchestrator recorded why it did not apply. Where a builder had to deviate from the spec, the change and its reason were appended to `docs/SPEC_CHANGES.md`. Examples are the `pqcKeyStatus` answer shapes, the `evmVersion` setting and the rule that a token address without code counts as a failed push during settlement.

**5. Integration and operations (human-in-the-loop).** The owner decides when to run anything on testnet, which secrets to create, when to register for the drill, and what to submit. Agents prepared the workflows and the printed instructions. The owner runs them.

## What the AI produced

| Area | AI-generated | Notes |
|---|---|---|
| Contract | `contracts/QDMVault.sol`, interface, PQC library, mocks | Written from the spec; reviewed as above |
| Tests | Hardhat tests in `test/`, simulator tests in `sim/`, script tests in `scripts/`, Solidity fuzz tests in `contracts/test/` | The Solidity fuzz/invariant tests run as part of `npm test` (6 of the 192) |
| Simulator and drill bot | `sim/` | Runs the real contract bytecode with real ML-DSA-87 verification |
| App | `app/` | Demo and Testnet modes |
| Scripts and workflows | `scripts/`, `.github/workflows/` | Written offline; not yet run against testnet from this build |
| Shared library | `lib/` | Digest encoding and ML-DSA-87 helpers, used by tests, scripts and app |
| Documentation | `README.md`, `docs/`, `scripts/README.md`, this file | Drafted by agents, checked by the owner |

## What the human contributed

- The idea, and the decision to port the design of Lastword to QoreChain with post-quantum authority.
- The product decisions: key modes (ACCOUNT and DEVICE), relayer-friendly signatures, the agent allowance, the drill setup and the choice of testnet.
- The rules the agents worked under, including scope limits, the no-secrets rule and the no-network rule.
- Review of the specification and the threat model, and the final say on each part.
- Testnet operation: creating the secrets, funding the accounts, running the workflows, and deciding when to register for the drill.
- The submission: the repository, the video, the cover image, the testnet addresses and the final form.


## How the outputs were verified

- **Unit and contract tests.** Hardhat 3 tests with viem cover the digest parity between the contract and `lib/encoding.ts`, the owner authorisation matrix (wrong nonce, expiry, key, vault, contract, chain, action, signature length), the state machine with time travel, bounties, settlement with hostile heirs and tokens, claims, the agent allowance, reentrancy and isolation between vaults. The mock precompile accepts only signatures that the test harness has verified with the real ML-DSA-87 library.
- **Real-crypto simulator.** The `sim/` tests run the real bytecode, and the precompiles verify real ML-DSA-87 signatures. The simulator is the same code that backs the Demo mode of the app.
- **Drill bot with a negative control.** The drill bot holds only the classical key of the drill account and tries each drain and stall path in the catalogue. The positive run must move no value and change no vault state. The negative control runs the same drill with a verifier that accepts every signature, and value does move. A drill that cannot fail would prove nothing; the negative control shows that it can.
- **Independent reviews.** Reviewer agents that had not written a part judged it against the spec and the threat model, and could block it. Deviations that came out of review are recorded in `docs/SPEC_CHANGES.md`.
- **Testnet probe.** A probe workflow checks on testnet, with a fresh key and no funds, that `pqcVerify` checks the 32-byte digest the way the contract assumes. Its result is not yet recorded here.

What the reviews found and what changed because of them (all fixed before testnet):

- Contract security audit: no critical or high findings. Two low findings fixed: vault ids now commit to every creation parameter (an attacker who could send transactions as the owner could otherwise pre-create a vault id with their own heirs), and the settle gas check now accounts for the call's own overhead.
- Test-quality review with mutation testing: 39 of 42 planted bugs were caught. Fixes: per-fixture reset of the mock precompile, gas estimates measured against a storage-free stub, the drill checks the exact reason each attack failed and has a negative control, the invariant tests now exercise the claim path, and exact-boundary tests for the state machine.
- App and simulator review: removed simulated transaction hashes that looked real, made gas figures include the transaction's base and calldata cost, fixed a stale-nonce bug that made the drill's negative control weaker than it looked, and removed padded drill rows.
- Pre-submission audit (a lead agent re-reading everything against QoreChain's public documentation and the official rules): no new contract finding. It corrected the funding instructions (the faucet takes a `qor1` address), made the scripts' key-status decoder read the documented "no key" answer, fixed app rough edges (a backup string that stayed on screen after the key changed, tap targets under 44 px, owner screens that did not say why a settled vault refuses them, in-page failures mislabelled as contract reverts), added a second app test that walks every Demo screen, added an interop test against QoreChain's own `@qorechain/pqc` library, and rewrote the submission checklist from the rules text.
- Scripts review: removed a path that could print the drill key into public CI logs, moved the drill proof transaction inside the drill window, cut the drill account's balance to the registration fee, and made deploy and setup check which `pqcKeyStatus` answer shape the chain returns before creating a vault.

## Test results

On Nov 15, 2026: `npm test` 192 passing (186 TypeScript + 6 Solidity fuzz/invariant), `npm run test:sim` 53 passing, `npm run test:scripts` 48 passing, `npm run app:test` 6 passing.

## Limits of this process

- AI agents wrote almost all of the code, and the reviewers were also AI agents. Independent human review of the contract has not been done. There has been no external audit.
- The testnet scripts have not yet been run against QoreChain testnet from this build. Their behaviour on the chain is unverified until they run.
- Agents made mistakes during the build. The reviews caught several, and the spec changes record them. The reviews are not a guarantee.
- The owner's final decisions, and any claims about results, are the owner's. Agents did not sign, submit or pay for anything.
