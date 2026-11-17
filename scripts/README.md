# Testnet tooling and GitHub Actions

Everything here runs from GitHub Actions against QoreChain testnet (`qorechain-diana`, EVM chain id 9800).
You can do all of it from a phone in the GitHub web UI.

## Before you start

Replace `<owner>` with your GitHub user name. The repository is `Heirloom`, and it is PUBLIC: anything printed in a
workflow log or summary is public. That is why no secret and no private key is ever printed by these workflows.

All times below are EST (UTC-5):

| Event | UTC | EST |
|---|---|---|
| Drill registration deadline | Tue Nov 17 23:59 | Tue Nov 17 6:59 PM |
| Drill (the bot attacks) | Wed Nov 18 00:00 to 23:59 | Tue Nov 17 7:00 PM to Wed Nov 18 6:59 PM |
| Hackathon deadline | Dec 2 23:59 | Dec 2 6:59 PM |

## Secrets and variables to create (once)

Open **Settings > Secrets and variables > Actions**:
`https://github.com/<owner>/Heirloom/settings/secrets/actions`

**Secrets** (tab "Secrets" > "New repository secret"):

| Name | Value |
|---|---|
| `DEPLOYER_MNEMONIC` | 12 or 24 words of a brand-new wallet used only for this project. It deploys, relays and runs the keeper. Fund it (see step 1). |
| `DRILL_MNEMONIC` | The 12 words of the drill wallet (see "The drill wallet" below). |

**Variables** (tab "Variables" > "New repository variable"):
`https://github.com/<owner>/Heirloom/settings/variables/actions`

| Name | Value | When |
|---|---|---|
| `HEIR_ADDRESSES` | 1 to 10 `0x...` addresses, comma-separated. The drill vaults pay them equally. Must not include the drill or deployer address. | before step 5 |
| `QDMV_ADDRESS` | the QDMVault address printed by the deploy workflow | after step 3 |
| `TEST_TOKEN_ADDRESS` | the "Q-Day Test USD" address printed by the deploy workflow | after step 3 |
| `QDMV_FROM_BLOCK` | the deploy block printed by the deploy workflow (makes the keeper scan fast) | after step 3 |
| `DRILL_ADDRESS` | the drill 0x address printed by drill setup | after step 5 |

Optional variables: `DRILL_QOR` (default 5, split between the two vaults), `DRILL_TOKENS` (default 1000, split),
`DRILL_KEY_MODE` (`account`, `device` or `both`; default `both`), `DRILL_ACCOUNT_SHARE_BPS` (default 1000: 10% of the QOR and tokens go in the ACCOUNT vault, 90% in the DEVICE vault, which does not depend on the chain key registry), `KEEPER_MAX_ACTIONS` (default 20).

## The drill wallet (read this twice)

1. In MetaMask mobile create a brand-new, separate wallet or account that has never been used anywhere, mainnet included.
   Write down its 12 words. Never import them anywhere else.
2. Save those 12 words as the secret `DRILL_MNEMONIC` (link above). They stay secret FOREVER: they hold the post-quantum
   key that controls the drill vaults. Do not paste them in chat, an issue or a file.
3. Never import the drill phrase into QoreX. QoreX derives its post-quantum key its own way and could register a
   DIFFERENT key for the same address, which would break the vaults.
4. Drill setup prints the drill 0x address. Check that it matches the address MetaMask shows for that account (same
   derivation path m/44'/60'/0'/0/0, so they must be equal). If they differ, stop.
5. For the drill form you need the classical private key. Export it from MetaMask (Account details > Show private
   key). It is the only secret that goes on the form. After the drill it is public, and that is fine: it only controls
   the classical half of the drill account, and the vaults need the post-quantum key too.

## Run order

Run a workflow: **Actions** tab > pick the workflow on the left > **Run workflow** > **Run workflow**.
`https://github.com/<owner>/Heirloom/actions`

1. **Fund the deployer.** Run **Account status** (`status.yml`) to see the deployer's `0x` and `qor1` addresses:
   `https://github.com/<owner>/Heirloom/actions/workflows/status.yml`. Open the run's summary and copy the **`qor1...`**
   address (the faucet form refuses `0x` input; both forms are the same account). Sign in at
   https://dashboard.qorechain.io/faucet, paste the `qor1` address and claim. One claim pays 100 testnet QOR and is
   allowed once per 24 hours per account and per address, so claim early. Run Account status again to confirm the balance.
   The whole flow (deploy, drill setup with the default 5 QOR, proof, check-in, keeper) needs well under 20 QOR.
2. **Probe PQC precompile** (`probe.yml`). No secrets, no funds.
   `https://github.com/<owner>/Heirloom/actions/workflows/probe.yml`
   Optionally type the deployer's 0x address in the `address` box to see how its key status looks. Open the run summary
   and look for `"conventionConfirmed": true`. If the run fails, or prints PRECOMPILE UNSAFE, stop and tell the developer.
3. **CI** (`ci.yml`) runs by itself on every push and must be green. Then run **Deploy to testnet** (`deploy.yml`):
   `https://github.com/<owner>/Heirloom/actions/workflows/deploy.yml`. It registers the deployer's post-quantum key,
   opens an unscoped EVM window (contract creation needs one), deploys QDMVault and the test token, and prints the
   addresses in both forms (`0x` for the variables and the drill form, `qor1` for the project form's "testnet address"
   field). Create `QDMV_ADDRESS`, `TEST_TOKEN_ADDRESS` and `QDMV_FROM_BLOCK`.
4. Create `HEIR_ADDRESSES` and the secret `DRILL_MNEMONIC`.
5. **Drill setup** (`drill-setup.yml`):
   `https://github.com/<owner>/Heirloom/actions/workflows/drill-setup.yml`. It checks the drill wallet is brand new,
   funds it with exactly the registration fee, registers its post-quantum key, and relays the creation of TWO vaults
   in the same QDMVault contract: an ACCOUNT-mode vault (key read from the chain's registry) and a DEVICE-mode vault
   (key pinned in the vault), both funded with QOR and test tokens. The drill account itself never opens an EVM
   window. Safe to run again: it only tops up what is missing. Create the variable `DRILL_ADDRESS` and check the
   address against MetaMask (see above).
6. **Register for the drill by Tue Nov 17, 6:59 PM EST** with these form fields:
   - the drill account's classical private key (exported from MetaMask). The organisers publish submitted keys after
     the drill, which is expected: it must be a key that controls nothing else,
   - up to 5 contract addresses: the QDMVault address and the Q-Day Test USD address (both from step 3),
   - the proof transaction hash: you can only make it once the drill has started, so if the form needs it at
     registration, ask the organisers; otherwise submit it when step 8 produces it.
7. Optional: run **Drill verify** (`drill-verify.yml`) any time before the drill to confirm both vaults are funded and ALIVE.
8. **During the drill (Tue Nov 17 7:00 PM to Wed Nov 18 6:59 PM EST)** run **Drill proof transaction**
   (`drill-proof.yml`): `https://github.com/<owner>/Heirloom/actions/workflows/drill-proof.yml`. The relayer sends the
   drill account exactly fee + 1 uqor, then the drill account makes one hybrid-signed native self-send and the run
   prints `PROOF TX HASH`. The script refuses to run outside the drill window. Copy the hash from the run summary.
   Optional extra evidence the same day: **Drill check-in** (`drill-checkin.yml`) relays a check-in signed by the drill
   account's post-quantum key to each vault.
9. **After the drill**, run **Drill verify** (`drill-verify.yml`): read-only. It prints both vaults' QOR and token
   balances against what setup deposited and says KEPT or LOST. It also fails if the drill account has a live EVM window, and reports whether one was ever opened.
10. **Keeper** (`keeper.yml`) runs every 30 minutes by itself once `QDMV_ADDRESS` exists. It triggers overdue vaults and
    settles triggered ones. It pauses itself from Nov 16 to Nov 19 UTC so it cannot race the drill runs. Turn it off
    any time: Actions > Keeper > "..." menu > Disable workflow.

If a run goes red, open it, tap the failed step and read the last lines. The messages say what to fix
(for example "send it some QOR first" or "Missing DEPLOYER_MNEMONIC").

## What each file does

| File | Purpose |
|---|---|
| `scripts/lib/net.ts` | Testnet constants (chain ids, RPC, REST) and account loading from the environment. Same derivation as the official template: EVM address, `qor1` address, secp256k1 key and ML-DSA-87 key from one mnemonic. |
| `scripts/lib/chain.ts` | Hybrid-signed native transactions, EVM window open/close/reuse, viem clients, artifact loading. |
| `scripts/lib/pure.ts` | Pure helpers (budgets, parsing, probe decoding, keeper planning). Unit tested. |
| `scripts/lib/deployments.ts` | Reads vault and token addresses from the variables or `deployments/testnet.json`. |
| `scripts/window.ts` | `status`, `register`, `open [--targets 0x..,0x..] [--blocks N] [--txs N] [--value uqor]`, `close`. With `--targets` the window is scoped (`allowed_targets`, max 16, no contract creation). `--account drill` works for status/register/close only; opening a window on the drill account is refused. |
| `scripts/probe-pqc.ts` | Read-only probe of the `pqcVerify` and `pqcKeyStatus` precompiles with a fresh key. Exits non-zero if the digest convention fails. |
| `scripts/deploy.ts` | Deploys QDMVault and the test token, writes `deployments/testnet.json`. |
| `scripts/drill/setup.ts` | Creates and funds the two drill vaults (ACCOUNT and DEVICE mode); prints the drill addresses. Never prints a key. |
| `scripts/drill/proof-tx.ts` | One native self-send from the drill account (relayer tops it up by exactly fee + 1 uqor first); prints the hash. Refuses outside the drill window unless `--force`. |
| `scripts/drill/checkin.ts` | Relays a check-in signed by the drill account's post-quantum key. |
| `scripts/drill/verify.ts` | Compares vault balances with what setup deposited. |
| `scripts/keeper.ts` | Triggers and settles vaults. Simulates every call first, so reruns and races are harmless. `--dry-run` only prints. |

## Local commands (for developers)

```
npm run test:scripts        # unit tests, offline
npm run typecheck:scripts   # typecheck, offline
npm run probe               # needs network
npm run window -- status    # needs DEPLOYER_MNEMONIC and network
```

## Things worth knowing

- Opening a window advances the account's EVM nonce; the scripts read the nonce afresh for every transaction.
- A window's value budget covers value plus gas limit times fee cap of every admitted transaction. The scripts size it
  from the planned transactions (fee cap 250 gwei) and reuse a live window when it fits.
- The workflows that send from the deployer share one concurrency group so two runs never race on its nonce.
- Action versions are pinned to commit SHAs; `.github/dependabot.yml` proposes updates weekly.
- Workflows that hold secrets install with `npm ci --ignore-scripts`.
