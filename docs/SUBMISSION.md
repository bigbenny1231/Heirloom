# Submission checklist

Project: Heirloom (Quantum Dead Man's Vault). Repository: `github.com/bigbenny1231/Heirloom`. Live demo: https://heirloomqore.vercel.app. Hackathon: QoreChain "Build Before Q-Day", category Post-Quantum dApp.

What Heirloom does that other inheritance entries do not: it pays out funds held by the contract (no seed phrase is ever handed over), it needs no witness or guardian quorum (anyone can trigger it after the deadline, and heirs get fixed shares), and every owner action, the check-in included, is an ML-DSA-87 signature verified on chain. See "How Heirloom is different" in the README.

Status key: **done** (in the repository), **to do** (builder or repository work still open), **owner action** (only the owner can do it).

Timeline (all times UTC; Eastern shown for the owner):

| Date | Deadline |
|---|---|
| Tue Nov 17, 23:59 UTC (6:59 PM EST) | Register for the Q-Day drill |
| Wed Nov 18 | Q-Day drill runs (00:00 to 23:59 UTC) |
| Thu Nov 19 | Drill proof transaction hash submitted |
| Wed Dec 2, 23:59 UTC (6:59 PM EST) | Final submission. The project locks automatically at this time |

## General submission requirements

Checked against the official pages on Nov 15, 2026: https://build.qorechain.io/rules and https://build.qorechain.io/start.
The organisers say rules and dates may still change, so read both pages again before submitting.

| Item | Status | Where it lives / action |
|---|---|---|
| Registration complete (GitHub, X and a QoreX testnet address all connected; 18 or older) | owner action | On build.qorechain.io. Every team member registers. Team size for Post-Quantum dApp is 1 to 3. |
| Public GitHub repository | done | https://github.com/bigbenny1231/Heirloom (public). |
| Live demo link | done | https://heirloomqore.vercel.app, deployed by Vercel from `main` on every push. Demo mode needs nothing; Testnet mode can load the live vault read only. |
| QoreChain Build GitHub App installed on the repository | owner action | Required by the start page. Install it on the public repository once it exists. |
| MIT or Apache-2.0 licence file in the repository | done | [`LICENSE`](../LICENSE) (MIT), "Copyright (c) 2026 Andrew Garretson" |
| README | done | [`README.md`](../README.md): summary table, architecture diagram, quickstart, test counts, security notes, credits. Testnet addresses are listed under "Testnet deployment". |
| Libraries, kits and templates credited in the README | done | README "Credits" lists OpenZeppelin, noble, ethereumjs, viem, Hardhat, React, Vite, the QoreChain kits and the `create-qorechain-dapp` template. |
| Built during the event (Nov 4 to Dec 2) | done | Built in November 2026. The design is ported from the author's own NEAR entry; no code was copied (README "Credits"). |
| Featured (cover) image: 16:9, at least 1200 x 675 px, JPG, PNG or WebP, at most 5 MB | owner action | Not in the repository. The rules list it as required; the start page calls it optional. Make one. |
| Video of at most 3 minutes that shows the project working | owner action | Not in the repository. Suggested cut: the problem in one sentence, Demo mode on a phone (check in, "try without a signature" refused, Q-Day drill, skip time, trigger and pay heirs), then the testnet deploy and drill runs with explorer links. Check the length before upload. |
| At least one QoreChain testnet address (`qor1...`) | to do, owner action | The deploy workflow prints the QDMVault and test-token addresses in both `0x` and `qor1` form ([`scripts/README.md`](../scripts/README.md)). Put them in README.md and in the form. |
| Tick only the kits and network features that are in the code | owner action | In the code: `@qorechain/sdk` (hybrid signing, key registration, EVM window messages), `@qorechain/evm` (window status and cost), the `create-qorechain-dapp` Hardhat template as starting point; network features `pqcVerify`, `pqcKeyStatus`, scoped EVM authorisation windows, hybrid-signed native transactions. `@qorechain/pqc` is used only by an interop test (`scripts/lib/interop.test.ts`) that proves our signer and QoreChain's library agree byte for byte; signing itself uses `@noble/post-quantum`, the library `@qorechain/pqc` is built on. Tick it only if the form means "used anywhere". |
| Country and region on the project form | owner action | Regional award (the Americas) goes by the country chosen on the form; winners may be asked for proof of residence. |
| Submission is read-only after Dec 2, 23:59 UTC | note | Finalists may get a change request with 48 hours to answer (checks Dec 3 to 5, judging Dec 6 to 15, winners Dec 16). |

## Category: Post-Quantum dApp

| Requirement | Status | Where it lives / action |
|---|---|---|
| Uses the `pqcVerify` precompile (`0x0000000000000000000000000000000000000A01`) | done in code | `contracts/libraries/PQC.sol`. Runtime confirmation on testnet pending the probe. |
| Uses the `pqcKeyStatus` precompile (`0x0000000000000000000000000000000000000A02`) | done in code | `contracts/libraries/PQC.sol`, with both answer shapes handled ([`docs/SPEC_CHANGES.md`](SPEC_CHANGES.md)). |
| Scoped EVM authorisation window | done in tooling | `scripts/window.ts` (`open --targets`, up to 16 targets, no contract creation). Used by the deploy and drill workflows. Runs only from GitHub Actions against testnet. |
| Testnet probe of the PQC precompile | to do, owner action | Run `probe.yml` from the Actions tab. It needs no secrets and no funds. Record `conventionConfirmed` in the summary. |
| Two-stage QCAI audit | to do, owner action | The public rules, start and kits pages (read Nov 15) do not describe it. Ask the organisers (Discord) what the two stages are, how to request it and by when. Record the answer here. |
| Foundry or Hardhat tests | done (Hardhat) | Hardhat 3 tests in `test/` run with `npm test`. Simulator tests run with `npm run test:sim`. 192 Hardhat tests (incl. 6 Solidity fuzz/invariant), 53 simulator tests, 48 script tests and 49 app tests pass (342 in total). |
| Solidity fuzz and invariant tests | done | `contracts/test/QDMVault.t.sol` (forge-std vendored in `lib-sol/`) runs under Hardhat 3's Solidity test runner as part of `npm test`. |
| CI green | to do | `ci.yml` runs on push. Confirm it is green on the submitted commit. |

## Special awards

### Q-Day Survivor (drill)

| Step | Status | Where it lives / action |
|---|---|---|
| Set up the drill secrets (`DEPLOYER_MNEMONIC`, `DRILL_MNEMONIC`) and the variable `HEIR_ADDRESSES` | owner action | Repository settings. Never put a mnemonic in a file or chat. The drill wallet is a brand-new MetaMask wallet, never imported into QoreX. |
| Deploy to testnet | owner action | `deploy.yml`. Then create the variables `QDMV_ADDRESS`, `TEST_TOKEN_ADDRESS`, `QDMV_FROM_BLOCK`. |
| Drill setup | owner action | `drill-setup.yml`. Safe to re-run. |
| Register for the drill by Tue Nov 17, 23:59 UTC (6:59 PM EST) | owner action | On the project page: the drill account's classical private key (exported from MetaMask, never printed by CI) and the QDMVault and test-token addresses (up to five contracts are allowed). The account must be fresh, must never have held mainnet funds, and must have its ML-DSA-87 key registered (drill setup does this and checks it). The organisers publish submitted keys after the drill; the vault's post-quantum key comes from the phrase, which stays secret. |
| Ask how "value kept" is measured | owner action, before Nov 17 | The drill ranks by proof transaction, then fewest successful attacks, then most value kept. The rules do not say whether "value" means the drill account's own balance or also the registered contracts. Our value sits in the vault contract and the drill account holds only dust. If the organisers count only the account's own balance, also leave some test QOR in the drill account (the chain refuses classical-only transfers and windows, so the bot cannot move it). The faucet pays 100 QOR per claim, so raising `DRILL_QOR` above the default 5 is cheap if absolute value counts. |
| Drill runs Wed Nov 18 UTC (Tue 7:00 PM to Wed 6:59 PM EST) | owner action | The attack bot runs against the registered contracts. Run `drill-proof.yml` (and optionally `drill-checkin.yml`) inside this window. |
| Proof transaction hash by Thu Nov 19 | owner action | Copy the hash from the `drill-proof.yml` run summary and paste it on the project page. The script refuses to run outside the drill window. |
| Post-drill verification | owner action | Run `drill-verify.yml` on Wed Nov 18 or later. It prints KEPT or LOST. |
| Drill design documentation | done | `docs/THREAT_MODEL.md` (attack-to-defence table), `sim/drill.ts` (attack catalogue), `test/09-qday-drill.test.ts`. |

### Best AI-Native Build

| Requirement | Status | Where it lives / action |
|---|---|---|
| Document the AI workflow | done (draft) | [`AI_USAGE.md`](../AI_USAGE.md). Owner to confirm the list of human contributions. |

### Top-Quality (score of at least 70 out of 100)

| Requirement | Status | Where it lives / action |
|---|---|---|
| Score at least 70 out of 100 and pass every submission check | owner action | Seven awards go to the highest-scored projects that won nothing else. The category rubric is not published on the rules page (it says only that a jury scores each project against its category rubric). Ask for it, then check the README, video and test evidence against it. |

### Regional: Americas

| Requirement | Status | Where it lives / action |
|---|---|---|
| Eligibility for the Americas region | owner action | Choose the country on the project form. The award goes to the highest-scored eligible project in the region that has not won another prize. |

### People's Choice

| Requirement | Status | Where it lives / action |
|---|---|---|
| Community vote, Dec 6 to 15 | owner action | Votes are cast with QoreX on mainnet (3 votes per eligible wallet, one per project, team members cannot vote for their own project). A clear cover image, a short video and a working public demo link are what voters see. |

## Open items that block submission

0. Registration on build.qorechain.io complete, and the QoreChain Build GitHub App installed on the repository.
1. Testnet addresses (`0x` and `qor1`) in README.md after deploy.
2. Probe result (`conventionConfirmed`) recorded in README.md and in this checklist.
3. QCAI audit process confirmed with the organisers.
4. Cover image and video produced and attached.
5. Repository created, licence and tag applied, CI green on the submitted commit.
