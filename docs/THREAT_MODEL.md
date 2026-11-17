# QDMVault — threat model

Companion to `SPEC.md`. Section numbers in brackets point there.

## What we protect

1. Value inside a vault leaves only (a) on an ML-DSA-87 signature by the owner's key, (b) through the agent allowance the
   owner signed, or (c) to the heirs after the heartbeat deadline.
2. One vault can never spend another vault's value.
3. Nobody but the owner's PQ key can keep a vault alive.

## What we trust

- The chain's `pqcVerify` and `pqcKeyStatus` precompiles, when they answer. When they do not answer, we stop [9].
- ML-DSA-87 itself, and the owner's and heirs' handling of their PQ secret keys.
- The tokens the owner lists at creation. A hostile token can hurt every vault that lists that same token, never a vault that does not list it.

## Unverified until the CI probe runs on testnet

- That `pqcVerify` checks the raw 32 message bytes with an empty ML-DSA context. If it does not, every signed call
  reverts `PQSignatureInvalid`: safe, but nothing works until the signer is adjusted.
- Whether the chain itself refuses a **native** transfer signed by the classical key alone. We do not rely on it; see the drill table.

## Drill bot — attack to defence

The bot holds the secp256k1 key of the drill account. It does not hold the ML-DSA-87 key.

| Bot attack | What happens | Defence |
|---|---|---|
| Native transfer out of the drill account | Outside our contracts. Whatever sits in the account is exposed to the chain's own rules | **The account holds only fee dust.** All value is deposited in the vault before the drill. Nothing worth taking is in the account |
| Open an EVM authorisation window | Refused by the chain: a window needs the hybrid signature | Chain rule (verified in docs). And even with a window open, see the last row |
| EVM transfer (QOR or ERC-20) from the account | Needs a window; and the account holds no tokens | Value is in the vault, not the account. Our window stays closed: owner actions are submitted by a relayer, never by the drill account [1] |
| Token approval from the account | Needs a window. If it somehow passed, it approves a spender over a zero balance | The account holds no tokens. The vault never calls `approve`, has no allowance function, and cannot be made to grant one |
| Drain calls on our contracts as `msg.sender` = drill account | Every call below fails or is harmless | `msg.sender` has no privilege in `QDMVault` [1] |

The last row in detail, for every function the bot can call:

| Call | Result |
|---|---|
| `withdraw`, `close`, `setHeirs`, `setTiming`, `setAgent`, `revokeAgent`, `checkIn` | Needs a 4627-byte ML-DSA-87 signature over the exact digest. Reverts `PQSignatureInvalid` [5.3] |
| `rotateKey` | ACCOUNT vault: `WrongKeyMode`. DEVICE vault: needs the current key's signature |
| `createVault` | Creates a different, empty vault id. It cannot touch the existing vault |
| `agentPay` | `NotAgent`. The owner address can never be the agent [6.9]. The drill vault has no agent |
| `setPayout` | Needs the heir's PQ signature |
| `trigger` | `NotOverdue` during the drill (see setup rules) |
| `settle`, `claim` | `WrongStatus` |
| `depositNative`, `depositToken` | The bot gives us money |
| Plain transfer or unknown selector to the vault | Reverts: no `receive`, no `fallback` |

### Drill setup rules (operational, not optional)

1. Drill vault: ACCOUNT mode, owner = drill account, created with `createVaultFor` or during setup. Check in on Nov 17.
2. `interval` at least 7 days, so the vault cannot become OVERDUE during the drill. `bounty = 0`.
3. No agent on the drill vault.
4. Heirs are accounts whose keys the bot does not have.
5. Move everything of value into the vault and leave the account with fee dust. Close the EVM window once setup is done.
6. Every contract we register must be equally dull to the classical key. `TestToken`: fixed supply minted in the constructor to a
   recipient, no mint function, no owner. `MockQorePQC` is never deployed to testnet.
7. After the drill, prove control with a PQ-signed `checkIn` or `withdraw` submitted by a relayer (the proof transaction).

## Attacker models

### 1. Leaked owner ECDSA key (the drill bot, Q-Day)

Stopped by principle 1: the classical key signs nothing the vault accepts. It also cannot keep the vault alive, because
check-in is PQ-signed, so a thief cannot starve the heirs by faking life. Residual: with an open EVM window it could call
`createVault` and make a second ACCOUNT vault under the owner's address with the thief's heirs. That vault is empty; the
real owner's PQ key controls it and can close it. Clients must show vaults by id, never "any vault of this owner".

### 2. Leaked heir ECDSA key

Cannot redirect the share: `setPayout` needs the heir's registered ML-DSA-87 key with possession proven [6.17]. Cannot pull
funds early: there is no heir-initiated withdrawal, only `trigger` after the deadline. Residual: if the heir's `payoutTo` is
an account controlled by that leaked key, what happens after payout is the chain's business. The heir can PQ-sign a
`setPayout` to a fresh address at any time before being paid.

### 3. Leaked agent key

Bounded, not prevented: at most `perTxLimit` per call and `dailyLimit` per UTC day (up to twice that across one midnight),
in one asset, only to the 1..8 payees the owner signed, only until `validUntil`, only while the vault is ALIVE [6.13].
The agent cannot change its own limits, cannot check in, and dies on `trigger`, `close` or `revokeAgent`.
Every refusal is an on-chain `AgentPayDenied` event with a reason code.

### 4. Malicious relayer / submitter

Every parameter is inside the signed digest, so a relayer cannot change a recipient, an amount or a heir list.
It can only (a) drop the request: the owner uses any other submitter; (b) delay it: bounded by `expiry`, and killed the
moment the owner uses that nonce for something else; (c) submit it as-is, which is what the owner asked for.
A relayer cannot reorder two signed actions: nonces are strictly sequential.
In `createVaultFor` the relayer's own `msg.value` is deposited; a copycat submitting the same creation produces the same vault.

### 5. Griefing caller

- Squatting a vault id: impossible, the id commits to owner, key mode and key hash [3].
- Filling token slots with junk: impossible, the token list is fixed by the owner at creation.
- Triggering early: `NotOverdue`.
- Starving settlement pushes of gas so shares fall to `claimable`: `settle` reverts `InsufficientGas` instead [6.15].
- A heir address that reverts or burns gas: its share is credited to `claimable`; the gas burnt is capped per push;
  the other heirs are paid in the same transaction.
- Spamming `AgentPayDenied` events: only the agent can call `agentPay`.
- Dust deposits: harmless; deposits are not check-ins.

### 6. Reentrant or hostile token

All state-changing functions are `nonReentrant` and follow checks-effects-interactions: balances are decremented before any
external call. Tokens are only those the vault's owner listed, and accounting is per vault, so a token that lies or reverts
can damage only vaults whose owners listed that token (all of them, if several list it; never any other vault). In `settle` a token call gets at most 150,000 gas and at most 32 bytes of its
returndata are read (no returndata bomb); failure becomes a `claimable` credit. Deposits credit the measured balance
increase, so fee-on-transfer tokens cannot inflate a vault. Rebasing tokens are unsupported.

### 7. Precompile inactive (mainnet today) or misbehaving

An inactive precompile returns success with empty data. `PQC.verify` requires exactly 32 bytes equal to the word `1`;
`PQC.accountKey` requires a well-formed 3-value or 4-value answer (registered, algorithm 1, a 2592-byte key inside the returndata, and possession proven whenever the 4-value form reports it); `createVault` additionally requires the 4-value form with possession proven [9].
Anything else reverts. So on such a chain no vault can be created by `createVault`, no signed action passes, and nothing
can be withdrawn by a forged "signature". Funds are not lost: the heartbeat path still pays the heirs.
Signature and key lengths are checked before the call, so truncated or padded inputs never reach the precompile.

### 8. Replay

| Replay across | Stopped by |
|---|---|
| Chains | `block.chainid` in the digest |
| Contracts (a second `QDMVault` deployment) | `address(this)` in the digest |
| Vaults | `vaultId` in the digest |
| Actions (e.g. a CHECKIN reused as REVOKE_AGENT, both with empty args) | `uint8(action)` in the digest |
| Time | `expiry`, and the per-vault sequential nonce |
| Same vault, same action | Nonce increments on success |
| Creation | The vault id then exists (`VaultExists`); ids are never reusable, even after close |
| Rotation PoP reused as an owner action | `ROTATE_KEY_POP` is its own action id and is never accepted by `_authOwner` |
| Heir signature after the heir list is replaced | Heir nonces are keyed by `(vaultId, heir account)` and never reset; the digest binds index and account |
| Other protocols | `TAG = keccak256("QDMV1")` |

Arguments are hashed with `abi.encode` (never `encodePacked`), so dynamic arrays cannot collide.

### 9. Front-running

- `trigger`: a front-runner takes the bounty. The vault is triggered either way; that is the bounty's purpose.
  The bounty is capped at 10% of the native balance and comes only out of that vault.
- Owner check-in racing a `trigger`: whichever lands first wins. If the check-in lands first, `trigger` reverts `NotOverdue`.
  If `trigger` lands first, the owner was past the full deadline. Owners should not live on the last block.
- `settle`: no caller-controlled input and no reward. Order does not matter.
- `claim`: pays the heir's current `payoutTo`, never the caller.
- A signed owner action copied from the mempool and submitted by someone else: same effect, the owner saves gas.
- `setPayout` racing `settle`: if `settle` lands first the share goes to the old address. Heirs should set the payout early.

## Trust assumptions about identity

- **ACCOUNT mode trusts the chain's registry rule** that replacing a registered ML-DSA key needs the OLD PQ key
  (`MsgRotatePQCKey` / `MigratePQCKey` need old and new signatures; `MsgRegisterPQCKeyV2` is refused when a key already exists).
  If that rule failed, an ECDSA-only attacker could re-register a key and an ACCOUNT vault would follow it. **DEVICE mode** pins
  `keccak256(pubkey)` in the vault and does not depend on the registry at all.
- **DEVICE-mode `owner` is only a label** chosen by the key holder. `VaultCreated.owner` is not proof of ownership; clients must
  list vaults by id (and check the pinned key hash), never by "vaults of address X".
- **Vault ids commit to all creation parameters** (heirs, timing, tokens, salt), so a party who can send transactions as the owner
  cannot squat an id with its own heirs; copying the salt produces a different, unrelated vault.

## Lessons carried over from the NEAR contract

- Never credit a vault with a refund the contract did not measure: there is no refund path at all here.
- Deposits after settlement strand value: refused.
- An agent must not spend while the owner is silent: `agentPay` requires ALIVE, not just "not triggered".
- A failing recipient must not block settlement: push with a gas cap, fall back to pull.

## Known limits

- An owner who loses the PQ key cannot recover the vault; the heirs receive it after the deadline. That is the product.
- In DEVICE mode the `owner` address is a label. Authority is the pinned key.
- A daily limit is per UTC day, not a rolling 24 hours.
- No pause and no admin: a bug cannot be patched in place. Users move to a new deployment with `close`.
