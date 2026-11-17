# QDMVault — contract specification (v1)

Binding for builders. Read `DECISIONS.md` first; this file makes every choice concrete.
The interface is `contracts/interfaces/IQDMVault.sol`; the digest encoding is `lib/encoding.ts`.
If this file and either of those disagree, that is a bug: fix all three together.

Solidity 0.8.28. OpenZeppelin `ReentrancyGuard`, `SafeERC20`, `Math`. One contract, `QDMVault`, holds many vaults.
No owner, no admin, no upgrade path, no `selfdestruct`, no `delegatecall`, no `receive()` and no `fallback()`.
The contract never calls `approve` on any token.

## 1. Principles

1. **The ML-DSA-87 signature is the authority.** `msg.sender` has no privilege, with two exceptions:
   `createVault` (owner = `msg.sender`) and `agentPay` (`msg.sender` = agent). Everyone may submit signed actions.
2. **Fail closed.** Any doubt about a precompile answer reverts.
3. **Internal accounting only.** `address(this).balance` and `token.balanceOf(this)` are never used to decide what a
   vault owns (the one exception is measuring the received amount inside `depositToken`).
4. **One vault can never spend another vault's money.** Every outflow first decrements that vault's own
   `balances` or `claimable` entry by exactly the amount sent.

## 2. Constants

| Name | Value |
|---|---|
| `TAG` | `keccak256("QDMV1")` |
| `MAX_HEIRS` | 10 |
| `MAX_TOKENS` | 4 |
| `MAX_PAYEES` | 8 |
| `MIN_INTERVAL` | 60 (seconds) |
| `MAX_INTERVAL` | 365 days (31,536,000) |
| `MAX_GRACE` | 12 |
| `MAX_BOUNTY_BPS` | 1000 (10%) |
| `NATIVE_PUSH_GAS` | 50,000 |
| `TOKEN_PUSH_GAS` | 150,000 |
| `PQC_VERIFY` | `0x0000000000000000000000000000000000000A01` |
| `PQC_KEY_STATUS` | `0x0000000000000000000000000000000000000A02` |
| ML-DSA-87 pubkey / signature length | 2592 / 4627 bytes |
| ML-DSA-87 `algorithmId` | 1 |
| Native asset id | `address(0)` |

## 3. Storage layout

Enums and structs are exactly those in `IQDMVault.sol` (`KeyMode`, `Status`, `State`, `Action`, `DenyReason`, `Heir`,
`CreateParams`, `Auth`, `Vault`, `Agent`).

```solidity
mapping(uint256 vaultId => Vault) private _vaults;
mapping(uint256 vaultId => Heir[]) private _heirs;                     // 1..10
mapping(uint256 vaultId => address[]) private _tokens;                 // 0..4, fixed at creation
mapping(uint256 vaultId => mapping(address token => bool)) private _tokenAllowed;
mapping(uint256 vaultId => mapping(address token => uint256)) private _balances;   // token 0 = native
mapping(uint256 vaultId => Agent) private _agents;
mapping(uint256 vaultId => mapping(address heir => uint256)) private _heirNonces;  // never reset
mapping(uint256 vaultId => mapping(uint256 heirIndex => mapping(address token => uint256))) private _claimable;
```

`Vault` packs into four slots: `owner|keyMode|status|grace|interval` , `lastCheckin|triggeredAt|nonce`, `pubkeyHash`, `bounty`.

### Vault id

```
vaultId = uint256(keccak256(abi.encode(address owner, uint8 keyMode, bytes32 pubkeyHash, keccak256(abi.encode(CreateParams p)))))
```

`pubkeyHash` is zero in ACCOUNT mode. `p` is the full `CreateParams` (salt, timing, bounty, tokens, heirs). The id commits to
who controls the vault AND to everything the creator chose, so nobody can squat an id with different heirs or timing, and a
front-runner who copies the salt only creates a different, unrelated vault. An id is used once: a CLOSED or SETTLED id can never be created again.

## 4. State

Stored `Status`: `NONE → ACTIVE → TRIGGERED → SETTLED`, or `ACTIVE → CLOSED`. Nothing else.

Derived `State` (`stateOf`), with `t = block.timestamp`:

| Stored status | Condition | State |
|---|---|---|
| NONE | | NONE |
| ACTIVE | `t < lastCheckin + interval` | ALIVE |
| ACTIVE | `lastCheckin + interval <= t < lastCheckin + interval * (grace + 1)` | WARNING |
| ACTIVE | `t >= lastCheckin + interval * (grace + 1)` | OVERDUE |
| TRIGGERED / SETTLED / CLOSED | | same name |

`deadline = lastCheckin + interval * (grace + 1)`. With `grace = 0` there is no WARNING state. All in `uint64`
(max 2^64 is far above `timestamp + 365 days * 13`).

What is allowed when:

| | ALIVE | WARNING | OVERDUE | TRIGGERED | SETTLED | CLOSED |
|---|---|---|---|---|---|---|
| deposits | yes | yes | yes | yes | no | no |
| owner actions | yes | yes | yes (until someone triggers) | no | no | no |
| `agentPay` | yes | denied | denied | no agent | no agent | no agent |
| `trigger` | no | no | yes | no | no | no |
| `settle` | no | no | no | yes | no | no |
| `claim` | no | no | no | no | yes | no |
| `setPayout` | yes | yes | yes | yes | yes | no |

An owner who returns while OVERDUE but before anyone has called `trigger` is alive: any valid owner action resets the clock.

## 5. Signatures

### 5.1 Digest

```
digest = keccak256(abi.encode(
    bytes32 TAG,
    uint256 block.chainid,
    address address(this),
    uint256 vaultId,
    uint8   uint8(action),
    bytes32 keccak256(abi.encode(args...)),
    uint256 nonce,
    uint256 expiry
))
```

The signer signs the 32 digest bytes with ML-DSA-87. The contract passes `abi.encodePacked(digest)` (32 bytes) as
`message` to `pqcVerify`. `actionDigest(vaultId, action, argsHash, nonce, expiry)` is exposed as a view.

### 5.2 `args` per action

`abi.encode` of exactly these values in this order. Enums are encoded as `uint8`.

| Action (value) | `args` | Signed by | Nonce |
|---|---|---|---|
| CREATE (1) | `(address owner, uint8 keyMode, bytes32 pubkeyHash, CreateParams p)` | owner key (see 6.2) | `0` |
| CHECKIN (2) | `()` — `keccak256("")` | owner key | vault nonce |
| WITHDRAW (3) | `(address token, uint256 amount, address to)` | owner key | vault nonce |
| SET_HEIRS (4) | `(Heir[] heirs)` | owner key | vault nonce |
| SET_TIMING (5) | `(uint64 interval, uint8 grace, uint256 bounty)` | owner key | vault nonce |
| SET_AGENT (6) | `(address agent, address token, uint256 perTxLimit, uint256 dailyLimit, uint64 validUntil, address[] payees)` | owner key | vault nonce |
| REVOKE_AGENT (7) | `()` — `keccak256("")` | owner key | vault nonce |
| ROTATE_KEY (8) | `(bytes32 newPubkeyHash)` | current device key | vault nonce |
| ROTATE_KEY_POP (9) | `(bytes32 newPubkeyHash)` | new device key | same vault nonce and expiry as ROTATE_KEY |
| CLOSE (10) | `(address to)` | owner key | vault nonce |
| SET_PAYOUT (11) | `(uint256 heirIndex, address heir, address newPayout)` | heir's account key | `heirNonce[vaultId][heir]` |

Tuple shapes: `Heir = (address account, address payoutTo, uint16 bps)`;
`CreateParams = (bytes32 salt, uint64 interval, uint8 grace, uint256 bounty, address[] tokens, Heir[] heirs)`.
In Solidity the CREATE hash is `keccak256(abi.encode(owner, uint8(keyMode), pubkeyHash, p))` with `p` the struct.

### 5.3 Owner authorisation — `_authOwner(vaultId, action, argsHash, auth)`

Run by every owner action, in this order:

1. `v.status == ACTIVE`, else `VaultNotFound` (NONE) or `WrongStatus(status)`.
2. `auth.nonce == v.nonce`, else `BadNonce(expected, got)`.
3. `block.timestamp <= auth.expiry`, else `SignatureExpired(expiry)`.
4. Resolve the public key:
   - ACCOUNT: `auth.pubkey.length == 0`, else `UnexpectedPubkey`. `pubkey = PQC.accountKey(v.owner)` (section 9).
   - DEVICE: `auth.pubkey.length == 2592`, else `BadPubkeyLength`; `keccak256(auth.pubkey) == v.pubkeyHash`, else `PubkeyMismatch`.
5. `PQC.verify(pubkey, auth.sig, digest)` (section 9).
6. `v.nonce += 1; v.lastCheckin = uint64(block.timestamp);`
7. `emit CheckedIn(vaultId, action, auth.nonce, uint64(block.timestamp))`.

So **every owner action is a check-in**. A PQ-signed action is proof of life.

There is no cap on how far ahead `expiry` may be. Sequential nonces mean at most one signed action can be pending,
and using the nonce for anything else kills it. Clients sign with `expiry = now + 10 minutes`.

## 6. External functions

All state-changing functions are `nonReentrant`. Checks, then effects, then interactions.

### 6.1 `createVault(CreateParams p) payable returns (uint256 vaultId)`

- Caller: anyone; `owner = msg.sender`, `keyMode = ACCOUNT`, `pubkeyHash = 0`. No signature.
- Requires `PQC.accountKey(msg.sender)` to succeed (registered, ML-DSA-87, possession proven), so value cannot be
  locked in a vault whose owner has no usable PQ key.
- Then `_create` (6.3).

### 6.2 `createVaultFor(address owner, KeyMode keyMode, CreateParams p, uint256 expiry, bytes sig, bytes pubkey) payable returns (uint256 vaultId)`

- Caller: anyone. `owner != address(0)`, else `ZeroAddress`.
- `block.timestamp <= expiry`, else `SignatureExpired`.
- ACCOUNT: `pubkey.length == 0` (else `UnexpectedPubkey`); `pubkeyHash = 0`; verifying key = `PQC.accountKey(owner)`.
- DEVICE: `pubkey.length == 2592` (else `BadPubkeyLength`); `pubkeyHash = keccak256(pubkey)`; verifying key = `pubkey`.
  The signature is the proof of possession. In DEVICE mode `owner` is a label chosen by the key holder; it grants nothing.
- `digest = actionDigest(vaultId, CREATE, keccak256(abi.encode(owner, uint8(keyMode), pubkeyHash, p)), 0, expiry)`; `PQC.verify`.
- Then `_create`. Replay is impossible because the id then exists.

### 6.3 `_create` (shared)

1. `vaultId = computeVaultId(owner, keyMode, pubkeyHash, p)`; `status == NONE`, else `VaultExists(vaultId)`.
2. `_checkTiming(p.interval, p.grace)`: `60 <= interval <= 365 days` else `BadInterval`; `grace <= 12` else `BadGrace`.
3. Tokens: `length <= 4`; each non-zero, has code (`token.code.length > 0`), not `address(this)`, no duplicates; else `BadTokens`.
4. `_setHeirs(vaultId, p.heirs)` (6.7).
5. Store the vault: `status = ACTIVE`, `lastCheckin = now`, `nonce = 0`, `bounty = p.bounty` (any value; it is capped at pay time).
6. If `msg.value > 0`: `_balances[vaultId][0] += msg.value`, `emit Deposited(vaultId, 0, msg.sender, msg.value)`.
7. `emit VaultCreated(...)`, `emit HeirsSet(...)`.

### 6.4 Deposits

- `depositNative(uint256 vaultId) payable` — anyone. Status ACTIVE or TRIGGERED, else `WrongStatus`/`VaultNotFound`.
  `msg.value > 0` else `ZeroAmount`. Credits `_balances[vaultId][0]`. `emit Deposited`.
- `depositToken(uint256 vaultId, address token, uint256 amount)` — anyone. Same status rule. `_tokenAllowed[vaultId][token]`
  else `TokenNotAllowed(token)`. `amount > 0`. Measures `balanceOf(this)` before and after `safeTransferFrom` and credits the
  difference (fee-on-transfer safe); a zero difference reverts `ZeroAmount`. `emit Deposited` with the credited amount.

Deposits are not check-ins.

### 6.5 `checkIn(uint256 vaultId, Auth auth)`

`_authOwner(CHECKIN, keccak256(""))`. Nothing else.

### 6.6 `withdraw(uint256 vaultId, address token, uint256 amount, address to, Auth auth)`

- `_authOwner(WITHDRAW, keccak256(abi.encode(token, amount, to)))`.
- `amount > 0` (`ZeroAmount`); `to != 0` (`ZeroAddress`); `to != address(this)` (`BadRecipient`);
  `token == 0 || _tokenAllowed` (`TokenNotAllowed`); `_balances >= amount` (`InsufficientBalance`).
- Decrement, then send: native by `call{value}` (no gas cap), token by `safeTransfer`. Failure reverts `TransferFailed`.
- `emit Withdrawn(vaultId, token, to, amount)`.

### 6.7 `setHeirs(uint256 vaultId, Heir[] heirs, Auth auth)`

- `_authOwner(SET_HEIRS, keccak256(abi.encode(heirs)))`, then `_setHeirs`, `emit HeirsSet`.
- `_setHeirs`: `1 <= length <= 10`; each `account != 0`, `payoutTo != 0`, `payoutTo != address(this)`, `bps > 0`;
  no duplicate `account`; `sum(bps) == 10000`. Any failure: `BadHeirs`. Replaces the whole list.
- Heir nonces are keyed by account and survive replacement, so an old `setPayout` signature can never be replayed.

### 6.8 `setTiming(uint256 vaultId, uint64 interval, uint8 grace, uint256 bounty, Auth auth)`

`_authOwner(SET_TIMING, keccak256(abi.encode(interval, grace, bounty)))`, `_checkTiming`, store all three, `emit TimingSet`.

### 6.9 `setAgent(uint256 vaultId, address agent, address token, uint256 perTxLimit, uint256 dailyLimit, uint64 validUntil, address[] payees, Auth auth)`

- `_authOwner(SET_AGENT, keccak256(abi.encode(agent, token, perTxLimit, dailyLimit, validUntil, payees)))`.
- `agent != 0`, `agent != v.owner`, `agent != address(this)`, else `BadAgent`.
- `token == 0 || _tokenAllowed`, else `TokenNotAllowed`.
- `perTxLimit > 0`, `perTxLimit <= dailyLimit`, `validUntil > block.timestamp`, else `BadAgent`.
- `1 <= payees.length <= 8`; each non-zero, not `address(this)`, no duplicates; else `BadPayees`.
- Replaces any existing agent. `spentDay = 0`, `spentToday = 0`. `emit AgentSet`.

### 6.10 `revokeAgent(uint256 vaultId, Auth auth)`

`_authOwner(REVOKE_AGENT, keccak256(""))`. `emit AgentRevoked(vaultId, oldAgent)` and `delete _agents[vaultId]`.
Succeeds when there is no agent (it is then a plain check-in; no `AgentRevoked` event).

### 6.11 `rotateKey(uint256 vaultId, bytes newPubkey, bytes newSig, Auth auth)`

- DEVICE mode only, else `WrongKeyMode` (checked before `_authOwner`). An ACCOUNT vault follows the chain's key registry.
- `newPubkey.length == 2592` (`BadPubkeyLength`); `newHash = keccak256(newPubkey)`; `newHash != v.pubkeyHash` (`SameKey`).
- `_authOwner(ROTATE_KEY, keccak256(abi.encode(newHash)))` — signed by the current key.
- `PQC.verify(newPubkey, newSig, actionDigest(vaultId, ROTATE_KEY_POP, keccak256(abi.encode(newHash)), auth.nonce, auth.expiry))`
  — proof of possession by the new key.
- `v.pubkeyHash = newHash`. `emit KeyRotated(vaultId, oldHash, newHash)`.

### 6.12 `close(uint256 vaultId, address to, Auth auth)`

- `_authOwner(CLOSE, keccak256(abi.encode(to)))`. `to != 0`, `to != address(this)`.
- `status = CLOSED`; `delete _agents[vaultId]` (emit `AgentRevoked` if one existed).
- For native then each token: read the balance, zero it, send it (skip zeros), `emit Withdrawn`. Any failed send reverts the whole call.
- `emit VaultClosed(vaultId, to)`.

### 6.13 `agentPay(uint256 vaultId, address to, uint256 amount) returns (bool paid)`

- `msg.sender == _agents[vaultId].agent` and that agent is non-zero, else revert `NotAgent`.
- Policy checks in this order. The first failure emits `AgentPayDenied(vaultId, agent, to, amount, reason)` and
  **returns `false` without reverting and without changing state** (so the denial is on chain):
  1. `stateOf(vaultId) != ALIVE` → `NOT_ALIVE`
  2. `block.timestamp > validUntil` → `EXPIRED`
  3. `to` not in `payees` → `PAYEE_NOT_ALLOWED`
  4. `amount == 0` → `ZERO_AMOUNT`
  5. `amount > perTxLimit` → `OVER_PER_TX`
  6. `spent + amount > dailyLimit`, where `spent = (spentDay == today) ? spentToday : 0`, `today = block.timestamp / 86400` → `OVER_DAILY`
  7. `amount > _balances[vaultId][token]` → `INSUFFICIENT_BALANCE`
- Otherwise: `spentDay = today; spentToday = spent + amount;` decrement the balance; send (native `call`, no gas cap; token
  `safeTransfer`); a failed send reverts `TransferFailed`. `emit AgentPaid(vaultId, agent, to, amount, spentToday)`; return `true`.
- An agent payment is **not** a check-in. The agent cannot keep the vault alive.

### 6.14 `trigger(uint256 vaultId)`

- Anyone. `status == ACTIVE` (else `VaultNotFound`/`WrongStatus`); `block.timestamp >= deadline`, else `NotOverdue(deadline)`.
- `status = TRIGGERED; triggeredAt = now;` delete the agent (emit `AgentRevoked` if one existed).
- `bountyPaid = min(v.bounty, _balances[vaultId][0] * 1000 / 10000)`. Decrement, then `msg.sender.call{value: bountyPaid}("")`
  if non-zero; failure reverts `TransferFailed` (the caller chose an address that cannot receive).
- `emit Triggered(vaultId, msg.sender, bountyPaid)`.

### 6.15 `settle(uint256 vaultId)`

- Anyone. `status == TRIGGERED`, else `WrongStatus`. Set `status = SETTLED` first.
- For `asset` in `[address(0), tokens...]`, with `total = _balances[vaultId][asset]`, then `_balances = 0`; skip when `total == 0`:
  - heir `i < n-1`: `share = Math.mulDiv(total, bps_i, 10000)`; last heir: `share = total - sum(previous shares)` (**dust to the last heir**).
  - Skip zero shares. Otherwise push to `heirs[i].payoutTo`:
    - before each push require `gasleft() >= cap * 64 / 63 + overhead + 5000` (`overhead` = 36,600 native, 6,000 token: cold account,
      value transfer and new-account cost of the CALL itself), else revert `InsufficientGas`
      (stops a caller from starving pushes on purpose);
    - native: assembly `call(NATIVE_PUSH_GAS, to, share, 0, 0, 0, 0)`;
    - token: assembly `call(TOKEN_PUSH_GAS, token, 0, transfer(to, share), ..., 0, 32)`; success means the call succeeded and
      (`returndatasize == 0` or (`returndatasize >= 32` and the word equals 1)). At most 32 bytes of returndata are copied.
  - On success `emit HeirPaid(vaultId, i, asset, payoutTo, share)`.
  - On failure `_claimable[vaultId][i][asset] += share; emit HeirCredited(vaultId, i, asset, share)`.
- `emit Settled(vaultId)`. One call settles everything; loops are bounded by 10 heirs × 5 assets = 50 pushes.
- A failing or hostile heir address can never block the other heirs or the vault.

### 6.16 `claim(uint256 vaultId, uint256 heirIndex, address token)`

- Anyone. `status == SETTLED` (else `WrongStatus`); `heirIndex < heirs.length` (else `BadHeirIndex`);
  `amount = _claimable[...] > 0` (else `NothingToClaim`).
- Zero the entry, send to the heir's **current** `payoutTo` (native `call` no gas cap, token `safeTransfer`). Failure reverts
  `TransferFailed`; the heir fixes it with `setPayout` and claims again. `emit Claimed`.

### 6.17 `setPayout(uint256 vaultId, uint256 heirIndex, address newPayout, uint256 nonce, uint256 expiry, bytes sig)`

- Anyone submits. Status ACTIVE, TRIGGERED or SETTLED (else `VaultNotFound`/`WrongStatus`). `heirIndex < heirs.length` (`BadHeirIndex`).
- `heir = heirs[heirIndex].account`. `nonce == _heirNonces[vaultId][heir]` (`BadNonce`). `block.timestamp <= expiry` (`SignatureExpired`).
- `newPayout != 0` (`ZeroAddress`), `newPayout != address(this)` (`BadRecipient`).
- `pubkey = PQC.accountKey(heir)`; `PQC.verify(pubkey, sig, actionDigest(vaultId, SET_PAYOUT, keccak256(abi.encode(heirIndex, heir, newPayout)), nonce, expiry))`.
- `_heirNonces[vaultId][heir] += 1; heirs[heirIndex].payoutTo = newPayout; emit PayoutSet(vaultId, heirIndex, heir, newPayout)`.
- Does not touch the vault nonce or `lastCheckin`. Heirs always use ACCOUNT keys, whatever the vault's key mode.

### 6.18 Views

`computeVaultId` (pure), `actionDigest`, `getVault`, `stateOf`, `deadlines`, `getHeirs`, `getTokens`, `balanceOf`,
`getAgent`, `heirNonce`, `claimable`, and the constant getters. `stateOf` and `deadlines` return `NONE` / zeros for an unknown id.

## 7. Bounty, settlement and dust — worked rules

- Bounty: `min(bounty, floor(nativeBalance / 10))`, native only, paid out of that vault's balance before the split.
- Split per asset: floor shares for heirs `0..n-2`, remainder to heir `n-1`. `sum(shares) == total` exactly.
- Nothing is ever left in `_balances` after `settle`. Deposits are refused once SETTLED, so nothing can strand.
- Invariant (per asset, whole contract): `sum(_balances) + sum(_claimable) <= real holdings`.
  Rebasing tokens that shrink balances break this and are not supported; fee-on-transfer tokens are.

## 8. Agent rules — summary

One agent per vault, one asset, per-payment cap, UTC-day cap, expiry, 1..8 payees. The agent is a plain ECDSA account
and must differ from the owner. It can pay only while the vault is ALIVE. It is deleted by `revokeAgent`, `close` and `trigger`.
Worst case loss with a leaked agent key: `dailyLimit` per UTC day (up to `2 × dailyLimit` across one midnight) to
allow-listed payees only, until `validUntil` or revocation.

## 9. Precompile handling — `contracts/libraries/PQC.sol`

Both functions are `internal view` and use low-level `staticcall`. Never a high-level interface call.

`verify(bytes memory pubkey, bytes calldata sig, bytes32 digest)`:

1. `pubkey.length == 2592`, else `BadPubkeyLength(len)`. `sig.length == 4627`, else `BadSignatureLength(len)`.
2. `(ok, ret) = PQC_VERIFY.staticcall(abi.encodeCall(IQorePQCVerify.pqcVerify, (pubkey, sig, abi.encodePacked(digest))))`.
3. `!ok || ret.length != 32` → `PrecompileUnavailable(PQC_VERIFY)`. An inactive precompile returns success with empty data and lands here.
4. `abi.decode(ret, (uint256)) != 1` → `PQSignatureInvalid`. Only the exact word `1` passes.

`accountKey(address account) returns (bytes memory pubkey)` parses the raw returndata and accepts two shapes:

1. `(ok, ret) = PQC_KEY_STATUS.staticcall(abi.encodeCall(IQorePQCKeyStatus.pqcKeyStatus, (account)))`; `!ok || ret.length < 96` → `PrecompileUnavailable(PQC_KEY_STATUS)`.
2. word0 (registered) must be 0 or 1, word1 (algorithmId) <= 255, word2 is the bytes offset: `0x80` = 4-value form
   `(bool, uint8, bytes, bool possessionProven)` (word3 must be 0 or 1); `0x60` = 3-value form `(bool, uint8, bytes)` as in the
   `@qorechain/evm` 0.14.0 ABI (possession unknown). Any other offset, or a bytes block outside the returndata →
   `PrecompileUnavailable(PQC_KEY_STATUS)`.
3. `!registered` → `PQKeyNotRegistered(account)`; `algorithmId != 1` → `PQKeyWrongAlgorithm(id)`; 4-value form with
   `!possessionProven` → `PQKeyPossessionNotProven(account)`; `pubkey.length != 2592` → `BadPubkeyLength(len)`.
4. `accountKeyProven` (used by `createVault`, which has no signature) additionally requires the 4-value form with possession
   proven; a 3-value answer reverts `PQKeyPossessionNotProven`. In the 3-value form use `createVaultFor`, whose ML-DSA signature
   over the CREATE digest, verified against the registry key, is the proof of possession.

Consequence: on a chain without the precompiles every signed action and `createVault` reverts. Funds already inside can
then only leave through `trigger`/`settle` to the heirs. This is the intended fail-closed behaviour.

## 10. Events and errors

Exactly as declared in `IQDMVault.sol`. Every state change emits at least one event. Every revert uses a custom error
(plus OpenZeppelin's own `ReentrancyGuardReentrantCall` and `SafeERC20FailedOperation`, which builders may let through).

## 11. Tests builders must write (minimum)

- Digest parity: `actionDigest` and `computeVaultId` on chain equal `lib/encoding.ts` for every action, with fixed vectors.
- Each owner action: happy path; wrong nonce; expired; wrong key; wrong vault; wrong contract; wrong chain id; wrong action id;
  short/long signature; DEVICE pubkey mismatch; ACCOUNT with a pubkey supplied.
- Precompile inactive (no code at A01/A02 → empty success): every signed path reverts `PrecompileUnavailable`.
- Key status variants: unregistered, wrong algorithm, possession not proven.
- State walk with time travel: ALIVE → WARNING → OVERDUE; owner action while OVERDUE revives; `trigger` early reverts.
- Bounty: zero balance, bounty above 10%, bounty below 10%.
- Settlement: 1 heir, 10 heirs, dust amounts (e.g. 10 wei across 3 heirs), a reverting heir, a gas-burning heir, a token that
  returns false, a token that reverts, a reentrant token; sum of paid + credited equals the pre-settle balance.
- Claim after `setPayout`; `setPayout` replay; `setPayout` with another heir's key.
- Agent: each `DenyReason` in order, day rollover, revoked on trigger, non-agent caller reverts.
- Isolation: two vaults holding the same token; draining one never changes the other.
- Rotation: old key rejected after rotation; rotation without a valid PoP rejected; PoP signature not usable as any other action.
