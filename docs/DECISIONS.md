# Heirloom, Quantum Dead Man's Vault (QDMV): design decisions (Nov 15 2026)

Written by the orchestrating agent with the owner before any code, and given to every builder agent as its brief
(see `AI_USAGE.md`). Kept as written, apart from tidying, so the record of what was decided up front stays honest.

Hackathon: QoreChain "Build Before Q-Day", category Post-Quantum dApp. Deadline Dec 2 23:59 UTC.
Q-Day drill: register by Tue Nov 17 23:59 UTC; drill Wed Nov 18 00:00-23:59 UTC. A bot holds the
classical (secp256k1/ECDSA) key of our drill account and tries native transfers, EVM windows, EVM transfers,
token approvals and drain calls on up to 5 of our contracts. Ranked by proof tx, fewest successful attacks, most value kept.

## Verified chain facts (official docs + @qorechain/evm 0.14.0)
- Testnet qorechain-diana, EVM chainId 9800, EVM RPC https://evm-testnet.qore.host, REST https://api-testnet.qore.host
- Every account has a secp256k1 key + a registered ML-DSA-87 key (FIPS 204, "dilithium5", algorithmId 1).
  Pubkey 2592 bytes, signature 4627 bytes.
- EVM txs only pass inside an "EVM authorisation window" opened by a hybrid-signed native message.
  The classical key alone can never open one. Window: blocks, max_txs, max_value, optional allowed_targets (<=16; contract creation refused), native_only.
- Precompiles (testnet only; on mainnet an inactive precompile returns SUCCESS with EMPTY data, so contracts must
  check returndata length and fail closed):
  - pqcVerify @ 0x0000000000000000000000000000000000000A01:
    `function pqcVerify(bytes pubkey, bytes signature, bytes message) external view returns (bool valid)`; gas 25,000 + 8/byte input.
  - pqcKeyStatus @ 0x0000000000000000000000000000000000000A02:
    `function pqcKeyStatus(address account) external view returns (bool registered, uint8 algorithmId, bytes pubkey, bool possessionProven)`; 2,500 gas.
    possessionProven can be false (registration without proof is allowed) -> we require true.
- Unknown until tested on testnet: whether pqcVerify verifies the raw message bytes with an empty ML-DSA context
  (noble/@qorechain/pqc default). We sign a 32-byte digest and pass exactly those 32 bytes as `message`.
  A CI job (probe) will eth_call the precompile with a freshly generated key to confirm (no funds needed).
- Build environment: the agents' build machine had no route to the testnet or to the Solidity compiler download host.
  So everything local runs offline, and all testnet work runs later from GitHub Actions workflows.
- solc: Hardhat 3 uses the npm `solc@0.8.28` soljson.js via `path` in the config, so no compiler download is needed.
  Foundry was not available on the build machine; the Solidity fuzz and invariant tests run under Hardhat 3 instead.

## Product decisions
1. One contract `QDMVault` holds many vaults (vaultId => Vault). Solidity 0.8.28, OpenZeppelin (ReentrancyGuard, SafeERC20).
2. The PQ signature is the authority, not msg.sender. Owner actions are `action(params..., nonce, expiry, pqSig[, pubkey])`
   and ANYONE may submit them (relayer friendly). So the owner's own account never needs an open EVM window
   after setup; the drill account keeps its window closed.
3. Digest the owner signs (32 bytes, then passed as `message`):
   keccak256(abi.encode(TAG, block.chainid, address(this), vaultId, uint8(action), keccak256(abi.encode(args...)), nonce, expiry))
   with TAG = keccak256("QDMV1"). Nonce is per vault, strictly sequential (must equal vault.nonce, then ++). expiry = unix seconds; block.timestamp <= expiry.
4. Key modes per vault:
   - ACCOUNT: pubkey read live from pqcKeyStatus(owner); require registered && algorithmId==1 && possessionProven. (Drill vault uses this: it showcases QoreChain's registry.)
   - DEVICE: vault pins keccak256(pubkey) at creation (creation carries a PQ proof-of-possession signature over the creation digest); every action passes the 2592-byte pubkey in calldata and the contract checks its hash. Rotation = action ROTATE_KEY signed by the old key plus a PoP signature by the new key. (The phone app uses this so no mnemonic ever touches the browser.)
5. Owner actions that need a PQ signature: CHECKIN, WITHDRAW(token,amount,to), SET_HEIRS, SET_TIMING, SET_AGENT, REVOKE_AGENT, ROTATE_KEY, CLOSE (withdraw everything to `to` and close). Check-in is PQ-signed too, so a leaked ECDSA key can't keep the vault "alive" forever to starve heirs.
6. Creation: `createVault(...)` by msg.sender (ACCOUNT mode, owner=msg.sender) and `createVaultFor(owner, ...)` with a PQ signature (either mode) so the owner never sends an EVM tx. Deposits (native + ERC-20) are open to anyone — harmless.
7. Assets: native QOR plus up to 4 ERC-20 tokens per vault (fUSD etc.). Track per-vault balances internally; never use address(this).balance for accounting.
8. Timing: heartbeat interval (60 s .. 365 days, small values allowed for demos), grace (0..12 missed). States:
   Alive (now < last+interval), Warning (< last+interval*(grace+1)), Overdue (derived), Triggered (stored), Settled (stored), Closed (stored).
9. trigger(vaultId): anyone, once overdue. Pays caller bounty = min(vault.bounty, 10% of native balance). Revokes the agent. Locks all owner actions.
10. settle(vaultId): anyone, after trigger. Pays heirs by bps (sum 10000, 1..10 heirs) for native and each token, to each heir's payoutTo. If a push fails, credit `claimable[heir][token]` and let anyone call `claim(heir, token)` later, which sends to the heir's current payoutTo. Dust goes to the last heir.
11. Heir payout-address change: `setPayout(vaultId, heirIndex, newPayout, nonce, expiry, sig)` signed by the HEIR's ACCOUNT key (pqcKeyStatus(heir.account), possessionProven). Heir nonce per (vault, heir). Allowed before and after trigger until paid.
12. Agent allowance (AI Agents features: transaction, value, duration and target limits): owner sets (PQ-signed) agent address (plain ECDSA account OK), token, perTxLimit, dailyLimit (UTC day = block.timestamp/86400), validUntil, up to 8 allowed payees. `agentPay(vaultId, to, amount)` with msg.sender==agent; refused once triggered, expired, over a cap, or payee not allowed. Every allow/deny emits an event.
13. Safety: custom errors, events for every state change, CEI + nonReentrant, fail-closed precompile calls (check success AND returndata.length==32 AND decoded true; key status must decode), signature length must be 4627, pubkey length 2592, bounded loops, no owner/admin of the contract itself, no upgradeability, no selfdestruct.
14. Tests: Hardhat 3 node:test + viem. Precompiles mocked with `MockQorePQC` installed via setCode at 0x…0a01 and 0x…0a02 (lowercase addresses in viem). The mock only accepts signatures that the TEST HARNESS has verified for real with noble ML-DSA-87 (registered as keccak(pubkey,msg,sig) triples), so real crypto stays in the loop. Separately, an ethereumjs-based simulator runs the real bytecode with real ML-DSA-87 verification as custom precompiles (used by integration tests and the in-browser preview).
15. Layout (repo root = build/):
    contracts/QDMVault.sol, contracts/interfaces/IQorePQC.sol, contracts/libraries/PQC.sol, contracts/mocks/MockQorePQC.sol, contracts/mocks/TestToken.sol
    test/*.ts (Hardhat), lib/ (TS: digest encoding, signing, key helpers — shared by tests, scripts, app), sim/ (ethereumjs chain + real precompiles),
    app/ (Vite + React, builds to one self-contained HTML for the phone preview; Demo mode on the in-browser sim, Testnet mode via viem + injected QoreX EVM account),
    scripts/ (deploy, window, drill kit, precompile probe), .github/workflows/ (ci, probe, deploy, keeper), docs/.
16. Isolation: the agents touch nothing outside this project. No network calls to QoreChain from the build machine. No keys committed. No mainnet.
