// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IQDMVault} from "./interfaces/IQDMVault.sol";
import {PQC} from "./libraries/PQC.sol";

/// @title QDMVault - Quantum Dead Man's Vault
/// @notice Heartbeat inheritance vaults whose every owner action is authorised by an ML-DSA-87
///         signature checked through the QoreChain PQ precompiles. msg.sender has no privilege
///         except in createVault (owner) and agentPay (agent). See docs/SPEC.md.
/// @dev No owner, no admin, no upgrade path, no delegatecall, no selfdestruct, no receive/fallback.
contract QDMVault is IQDMVault, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------ constants

    bytes32 public constant override TAG = keccak256("QDMV1");
    uint256 public constant override MAX_HEIRS = 10;
    uint256 public constant override MAX_TOKENS = 4;
    uint256 public constant override MAX_PAYEES = 8;
    uint64 public constant override MIN_INTERVAL = 60;
    uint64 public constant override MAX_INTERVAL = 365 days;
    uint8 public constant override MAX_GRACE = 12;
    uint256 public constant override MAX_BOUNTY_BPS = 1000;
    uint256 public constant override NATIVE_PUSH_GAS = 50_000;
    uint256 public constant override TOKEN_PUSH_GAS = 150_000;

    uint256 private constant BPS = 10_000;
    uint256 private constant PUSH_GAS_MARGIN = 5_000;
    uint256 private constant NATIVE_CALL_OVERHEAD = 36_600;
    uint256 private constant TOKEN_CALL_OVERHEAD = 6_000;

    // -------------------------------------------------------------- storage

    mapping(uint256 vaultId => Vault) private _vaults;
    mapping(uint256 vaultId => Heir[]) private _heirs;
    mapping(uint256 vaultId => address[]) private _tokens;
    mapping(uint256 vaultId => mapping(address token => bool)) private _tokenAllowed;
    mapping(uint256 vaultId => mapping(address token => uint256)) private _balances;
    mapping(uint256 vaultId => Agent) private _agents;
    mapping(uint256 vaultId => mapping(address heir => uint256)) private _heirNonces;
    mapping(uint256 vaultId => mapping(uint256 heirIndex => mapping(address token => uint256))) private _claimable;

    // ------------------------------------------------------------- creation

    /// @inheritdoc IQDMVault
    function createVault(CreateParams calldata p) external payable nonReentrant returns (uint256 vaultId) {
        // Refuse to lock value in a vault whose owner has no usable PQ key.
        PQC.accountKeyProven(msg.sender);
        vaultId = _create(msg.sender, KeyMode.ACCOUNT, bytes32(0), p);
    }

    /// @inheritdoc IQDMVault
    function createVaultFor(
        address owner,
        KeyMode keyMode,
        CreateParams calldata p,
        uint256 expiry,
        bytes calldata sig,
        bytes calldata pubkey
    ) external payable nonReentrant returns (uint256 vaultId) {
        if (owner == address(0)) revert ZeroAddress();
        if (block.timestamp > expiry) revert SignatureExpired(expiry);

        bytes32 pkHash = _verifyCreate(owner, keyMode, p, expiry, sig, pubkey);
        vaultId = _create(owner, keyMode, pkHash, p);
    }

    function _verifyCreate(
        address owner,
        KeyMode keyMode,
        CreateParams calldata p,
        uint256 expiry,
        bytes calldata sig,
        bytes calldata pubkey
    ) private view returns (bytes32 pkHash) {
        bytes memory key;
        (pkHash, key) = _resolveCreateKey(owner, keyMode, pubkey);
        bytes32 digest = _createDigest(owner, keyMode, pkHash, p, expiry);
        PQC.verify(key, sig, digest);
    }

    function _resolveCreateKey(address owner, KeyMode keyMode, bytes calldata pubkey)
        private
        view
        returns (bytes32 pkHash, bytes memory key)
    {
        if (keyMode == KeyMode.ACCOUNT) {
            if (pubkey.length != 0) revert UnexpectedPubkey();
            key = PQC.accountKey(owner);
        } else {
            if (pubkey.length != 2592) revert BadPubkeyLength(pubkey.length);
            pkHash = keccak256(pubkey);
            key = pubkey;
        }
    }

    function _createDigest(address owner, KeyMode keyMode, bytes32 pkHash, CreateParams calldata p, uint256 expiry)
        private
        view
        returns (bytes32)
    {
        return actionDigest(
            computeVaultId(owner, keyMode, pkHash, p),
            Action.CREATE,
            keccak256(abi.encode(owner, uint8(keyMode), pkHash, p)),
            0,
            expiry
        );
    }

    function _create(address owner, KeyMode keyMode, bytes32 pkHash, CreateParams calldata p)
        private
        returns (uint256 vaultId)
    {
        vaultId = computeVaultId(owner, keyMode, pkHash, p);
        if (_vaults[vaultId].status != Status.NONE) revert VaultExists(vaultId);
        _checkTiming(p.interval, p.grace);

        uint256 n = p.tokens.length;
        if (n > MAX_TOKENS) revert BadTokens();
        for (uint256 i; i < n; ++i) {
            address t = p.tokens[i];
            if (t == address(0) || t == address(this) || t.code.length == 0 || _tokenAllowed[vaultId][t]) {
                revert BadTokens();
            }
            _tokenAllowed[vaultId][t] = true;
            _tokens[vaultId].push(t);
        }

        _setHeirs(vaultId, p.heirs);

        Vault storage v = _vaults[vaultId];
        v.owner = owner;
        v.keyMode = keyMode;
        v.status = Status.ACTIVE;
        v.grace = p.grace;
        v.interval = p.interval;
        v.lastCheckin = uint64(block.timestamp);
        v.pubkeyHash = pkHash;
        v.bounty = p.bounty;

        emit VaultCreated(vaultId, owner, keyMode, pkHash, p.interval, p.grace, p.bounty, p.tokens);
        emit HeirsSet(vaultId, p.heirs);
        if (msg.value > 0) {
            _balances[vaultId][address(0)] += msg.value;
            emit Deposited(vaultId, address(0), msg.sender, msg.value);
        }
    }

    // ------------------------------------------------------------- deposits

    /// @inheritdoc IQDMVault
    function depositNative(uint256 vaultId) external payable nonReentrant {
        _requireDepositable(vaultId);
        if (msg.value == 0) revert ZeroAmount();
        _balances[vaultId][address(0)] += msg.value;
        emit Deposited(vaultId, address(0), msg.sender, msg.value);
    }

    /// @inheritdoc IQDMVault
    function depositToken(uint256 vaultId, address token, uint256 amount) external nonReentrant {
        _requireDepositable(vaultId);
        if (!_tokenAllowed[vaultId][token]) revert TokenNotAllowed(token);
        if (amount == 0) revert ZeroAmount();
        uint256 beforeBal = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 afterBal = IERC20(token).balanceOf(address(this));
        uint256 received = afterBal > beforeBal ? afterBal - beforeBal : 0;
        if (received == 0) revert ZeroAmount();
        _balances[vaultId][token] += received;
        emit Deposited(vaultId, token, msg.sender, received);
    }

    function _requireDepositable(uint256 vaultId) private view {
        Status s = _vaults[vaultId].status;
        if (s == Status.NONE) revert VaultNotFound(vaultId);
        if (s != Status.ACTIVE && s != Status.TRIGGERED) revert WrongStatus(s);
    }

    // -------------------------------------------------- owner actions (PQ)

    /// @inheritdoc IQDMVault
    function checkIn(uint256 vaultId, Auth calldata auth) external nonReentrant {
        _authOwner(vaultId, Action.CHECKIN, keccak256(""), auth);
    }

    /// @inheritdoc IQDMVault
    function withdraw(uint256 vaultId, address token, uint256 amount, address to, Auth calldata auth)
        external
        nonReentrant
    {
        _authOwner(vaultId, Action.WITHDRAW, keccak256(abi.encode(token, amount, to)), auth);
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        if (to == address(this)) revert BadRecipient();
        if (token != address(0) && !_tokenAllowed[vaultId][token]) revert TokenNotAllowed(token);
        uint256 bal = _balances[vaultId][token];
        if (bal < amount) revert InsufficientBalance(bal, amount);
        _balances[vaultId][token] = bal - amount;
        _send(token, to, amount);
        emit Withdrawn(vaultId, token, to, amount);
    }

    /// @inheritdoc IQDMVault
    function setHeirs(uint256 vaultId, Heir[] calldata heirs, Auth calldata auth) external nonReentrant {
        _authOwner(vaultId, Action.SET_HEIRS, keccak256(abi.encode(heirs)), auth);
        _setHeirs(vaultId, heirs);
        emit HeirsSet(vaultId, heirs);
    }

    /// @inheritdoc IQDMVault
    function setTiming(uint256 vaultId, uint64 interval, uint8 grace, uint256 bounty, Auth calldata auth)
        external
        nonReentrant
    {
        Vault storage v = _authOwner(vaultId, Action.SET_TIMING, keccak256(abi.encode(interval, grace, bounty)), auth);
        _checkTiming(interval, grace);
        v.interval = interval;
        v.grace = grace;
        v.bounty = bounty;
        emit TimingSet(vaultId, interval, grace, bounty);
    }

    /// @inheritdoc IQDMVault
    function setAgent(
        uint256 vaultId,
        address agent,
        address token,
        uint256 perTxLimit,
        uint256 dailyLimit,
        uint64 validUntil,
        address[] calldata payees,
        Auth calldata auth
    ) external nonReentrant {
        Vault storage v = _authOwner(
            vaultId,
            Action.SET_AGENT,
            keccak256(abi.encode(agent, token, perTxLimit, dailyLimit, validUntil, payees)),
            auth
        );
        if (agent == address(0) || agent == v.owner || agent == address(this)) revert BadAgent();
        if (token != address(0) && !_tokenAllowed[vaultId][token]) revert TokenNotAllowed(token);
        if (perTxLimit == 0 || perTxLimit > dailyLimit || validUntil <= block.timestamp) revert BadAgent();

        uint256 n = payees.length;
        if (n == 0 || n > MAX_PAYEES) revert BadPayees();
        for (uint256 i; i < n; ++i) {
            address a = payees[i];
            if (a == address(0) || a == address(this)) revert BadPayees();
            for (uint256 j; j < i; ++j) {
                if (payees[j] == a) revert BadPayees();
            }
        }

        Agent storage ag = _agents[vaultId];
        ag.agent = agent;
        ag.token = token;
        ag.validUntil = validUntil;
        ag.spentDay = 0;
        ag.perTxLimit = perTxLimit;
        ag.dailyLimit = dailyLimit;
        ag.spentToday = 0;
        delete ag.payees;
        for (uint256 i; i < n; ++i) {
            ag.payees.push(payees[i]);
        }
        emit AgentSet(vaultId, agent, token, perTxLimit, dailyLimit, validUntil, payees);
    }

    /// @inheritdoc IQDMVault
    function revokeAgent(uint256 vaultId, Auth calldata auth) external nonReentrant {
        _authOwner(vaultId, Action.REVOKE_AGENT, keccak256(""), auth);
        _revokeAgent(vaultId);
    }

    /// @inheritdoc IQDMVault
    function rotateKey(uint256 vaultId, bytes calldata newPubkey, bytes calldata newSig, Auth calldata auth)
        external
        nonReentrant
    {
        Vault storage v = _vaults[vaultId];
        if (v.status != Status.NONE && v.keyMode != KeyMode.DEVICE) revert WrongKeyMode();
        if (newPubkey.length != 2592) revert BadPubkeyLength(newPubkey.length);
        bytes32 newHash = keccak256(newPubkey);
        if (v.status != Status.NONE && newHash == v.pubkeyHash) revert SameKey();

        bytes32 argsHash = keccak256(abi.encode(newHash));
        _authOwner(vaultId, Action.ROTATE_KEY, argsHash, auth);

        // Proof of possession by the new key; its own action id so it can never be used as an owner action.
        PQC.verify(newPubkey, newSig, actionDigest(vaultId, Action.ROTATE_KEY_POP, argsHash, auth.nonce, auth.expiry));

        bytes32 oldHash = v.pubkeyHash;
        v.pubkeyHash = newHash;
        emit KeyRotated(vaultId, oldHash, newHash);
    }

    /// @inheritdoc IQDMVault
    function close(uint256 vaultId, address to, Auth calldata auth) external nonReentrant {
        Vault storage v = _authOwner(vaultId, Action.CLOSE, keccak256(abi.encode(to)), auth);
        if (to == address(0)) revert ZeroAddress();
        if (to == address(this)) revert BadRecipient();
        v.status = Status.CLOSED;
        _revokeAgent(vaultId);

        _drain(vaultId, address(0), to);
        address[] storage toks = _tokens[vaultId];
        uint256 n = toks.length;
        for (uint256 i; i < n; ++i) {
            _drain(vaultId, toks[i], to);
        }
        emit VaultClosed(vaultId, to);
    }

    function _drain(uint256 vaultId, address token, address to) private {
        uint256 bal = _balances[vaultId][token];
        if (bal == 0) return;
        _balances[vaultId][token] = 0;
        _send(token, to, bal);
        emit Withdrawn(vaultId, token, to, bal);
    }

    // ---------------------------------------------------------------- agent

    /// @inheritdoc IQDMVault
    function agentPay(uint256 vaultId, address to, uint256 amount) external nonReentrant returns (bool paid) {
        Agent storage a = _agents[vaultId];
        address agent = a.agent;
        if (agent == address(0) || msg.sender != agent) revert NotAgent();

        DenyReason reason = _agentCheck(vaultId, a, to, amount);
        if (reason != DenyReason.NONE) {
            emit AgentPayDenied(vaultId, agent, to, amount, reason);
            return false;
        }

        uint64 today = uint64(block.timestamp / 1 days);
        uint256 spent = a.spentDay == today ? a.spentToday : 0;
        address token = a.token;
        a.spentDay = today;
        a.spentToday = spent + amount;
        _balances[vaultId][token] -= amount;
        _send(token, to, amount);
        emit AgentPaid(vaultId, agent, to, amount, spent + amount);
        return true;
    }

    function _agentCheck(uint256 vaultId, Agent storage a, address to, uint256 amount)
        private
        view
        returns (DenyReason)
    {
        if (stateOf(vaultId) != State.ALIVE) return DenyReason.NOT_ALIVE;
        if (block.timestamp > a.validUntil) return DenyReason.EXPIRED;
        bool listed;
        uint256 n = a.payees.length;
        for (uint256 i; i < n; ++i) {
            if (a.payees[i] == to) {
                listed = true;
                break;
            }
        }
        if (!listed) return DenyReason.PAYEE_NOT_ALLOWED;
        if (amount == 0) return DenyReason.ZERO_AMOUNT;
        if (amount > a.perTxLimit) return DenyReason.OVER_PER_TX;
        uint256 spent = a.spentDay == uint64(block.timestamp / 1 days) ? a.spentToday : 0;
        if (spent + amount > a.dailyLimit) return DenyReason.OVER_DAILY;
        if (amount > _balances[vaultId][a.token]) return DenyReason.INSUFFICIENT_BALANCE;
        return DenyReason.NONE;
    }

    function _revokeAgent(uint256 vaultId) private {
        address old = _agents[vaultId].agent;
        if (old != address(0)) {
            delete _agents[vaultId];
            emit AgentRevoked(vaultId, old);
        }
    }

    // ---------------------------------------------------------- inheritance

    /// @inheritdoc IQDMVault
    function trigger(uint256 vaultId) external nonReentrant {
        Vault storage v = _vaults[vaultId];
        _requireActive(vaultId, v.status);
        uint64 deadline = v.lastCheckin + v.interval * (uint64(v.grace) + 1);
        if (block.timestamp < deadline) revert NotOverdue(deadline);

        v.status = Status.TRIGGERED;
        v.triggeredAt = uint64(block.timestamp);
        _revokeAgent(vaultId);

        uint256 bal = _balances[vaultId][address(0)];
        uint256 cap = (bal * MAX_BOUNTY_BPS) / BPS;
        uint256 bountyPaid = v.bounty < cap ? v.bounty : cap;
        if (bountyPaid > 0) {
            _balances[vaultId][address(0)] = bal - bountyPaid;
            _send(address(0), msg.sender, bountyPaid);
        }
        emit Triggered(vaultId, msg.sender, bountyPaid);
    }

    /// @inheritdoc IQDMVault
    function settle(uint256 vaultId) external nonReentrant {
        Vault storage v = _vaults[vaultId];
        if (v.status == Status.NONE) revert VaultNotFound(vaultId);
        if (v.status != Status.TRIGGERED) revert WrongStatus(v.status);
        v.status = Status.SETTLED;

        Heir[] memory heirs = _heirs[vaultId];
        _settleAsset(vaultId, address(0), heirs);
        address[] memory toks = _tokens[vaultId];
        for (uint256 i; i < toks.length; ++i) {
            _settleAsset(vaultId, toks[i], heirs);
        }
        emit Settled(vaultId);
    }

    function _settleAsset(uint256 vaultId, address asset, Heir[] memory heirs) private {
        uint256 total = _balances[vaultId][asset];
        if (total == 0) return;
        _balances[vaultId][asset] = 0;

        uint256 n = heirs.length;
        uint256 paidOut;
        for (uint256 i; i < n; ++i) {
            uint256 share = i == n - 1 ? total - paidOut : Math.mulDiv(total, heirs[i].bps, BPS);
            paidOut += share;
            if (share == 0) continue;

            if (_push(asset, heirs[i].payoutTo, share)) {
                emit HeirPaid(vaultId, i, asset, heirs[i].payoutTo, share);
            } else {
                _claimable[vaultId][i][asset] += share;
                emit HeirCredited(vaultId, i, asset, share);
            }
        }
    }

    /// @dev Gas-capped push that never reverts on a failing recipient (only on too little gas supplied).
    function _push(address asset, address to, uint256 amount) private returns (bool ok) {
        uint256 cap = asset == address(0) ? NATIVE_PUSH_GAS : TOKEN_PUSH_GAS;
        // The CALL forwards at most 63/64 of what is left after its own overhead (cold account 2600 + value transfer
        // 9000 + possible new account 25000 for native; cold account + calldata for tokens). Require enough that the
        // callee really gets the full cap.
        uint256 need = (cap * 64) / 63 + (asset == address(0) ? NATIVE_CALL_OVERHEAD : TOKEN_CALL_OVERHEAD) + PUSH_GAS_MARGIN;
        if (gasleft() < need) revert InsufficientGas();
        if (asset == address(0)) {
            assembly ("memory-safe") {
                ok := call(cap, to, amount, 0, 0, 0, 0)
            }
        } else {
            if (asset.code.length == 0) return false;
            bytes memory data = abi.encodeCall(IERC20.transfer, (to, amount));
            uint256 word;
            uint256 rds;
            assembly ("memory-safe") {
                let out := mload(0x40)
                mstore(out, 0)
                ok := call(cap, asset, 0, add(data, 0x20), mload(data), out, 32)
                rds := returndatasize()
                word := mload(out)
            }
            if (ok) {
                ok = rds == 0 || (rds >= 32 && word == 1);
            }
        }
    }

    /// @inheritdoc IQDMVault
    function claim(uint256 vaultId, uint256 heirIndex, address token) external nonReentrant {
        Status s = _vaults[vaultId].status;
        if (s == Status.NONE) revert VaultNotFound(vaultId);
        if (s != Status.SETTLED) revert WrongStatus(s);
        Heir[] storage hs = _heirs[vaultId];
        if (heirIndex >= hs.length) revert BadHeirIndex();
        uint256 amount = _claimable[vaultId][heirIndex][token];
        if (amount == 0) revert NothingToClaim();
        _claimable[vaultId][heirIndex][token] = 0;
        address to = hs[heirIndex].payoutTo;
        _send(token, to, amount);
        emit Claimed(vaultId, heirIndex, token, to, amount);
    }

    /// @inheritdoc IQDMVault
    function setPayout(
        uint256 vaultId,
        uint256 heirIndex,
        address newPayout,
        uint256 nonce,
        uint256 expiry,
        bytes calldata sig
    ) external nonReentrant {
        Status s = _vaults[vaultId].status;
        if (s == Status.NONE) revert VaultNotFound(vaultId);
        if (s == Status.CLOSED) revert WrongStatus(s);
        Heir[] storage hs = _heirs[vaultId];
        if (heirIndex >= hs.length) revert BadHeirIndex();
        address heir = hs[heirIndex].account;
        uint256 expected = _heirNonces[vaultId][heir];
        if (nonce != expected) revert BadNonce(expected, nonce);
        if (block.timestamp > expiry) revert SignatureExpired(expiry);
        if (newPayout == address(0)) revert ZeroAddress();
        if (newPayout == address(this)) revert BadRecipient();

        _verifyPayout(vaultId, heirIndex, heir, newPayout, nonce, expiry, sig);
        _heirNonces[vaultId][heir] = expected + 1;
        hs[heirIndex].payoutTo = newPayout;
        emit PayoutSet(vaultId, heirIndex, heir, newPayout);
    }

    function _verifyPayout(
        uint256 vaultId,
        uint256 heirIndex,
        address heir,
        address newPayout,
        uint256 nonce,
        uint256 expiry,
        bytes calldata sig
    ) private view {
        bytes32 argsHash = keccak256(abi.encode(heirIndex, heir, newPayout));
        bytes32 digest = actionDigest(vaultId, Action.SET_PAYOUT, argsHash, nonce, expiry);
        PQC.verify(PQC.accountKey(heir), sig, digest);
    }

    // ---------------------------------------------------------------- views

    /// @inheritdoc IQDMVault
    function computeVaultId(address owner, KeyMode keyMode, bytes32 pubkeyHash, CreateParams calldata p)
        public
        pure
        returns (uint256)
    {
        // The id commits to everything the creator chose (heirs, timing, tokens, salt), so nobody can squat an id
        // with different parameters.
        return uint256(keccak256(abi.encode(owner, uint8(keyMode), pubkeyHash, keccak256(abi.encode(p)))));
    }

    /// @inheritdoc IQDMVault
    function actionDigest(uint256 vaultId, Action action, bytes32 argsHash, uint256 nonce, uint256 expiry)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(TAG, block.chainid, address(this), vaultId, uint8(action), argsHash, nonce, expiry)
        );
    }

    function getVault(uint256 vaultId) external view returns (Vault memory) {
        return _vaults[vaultId];
    }

    function stateOf(uint256 vaultId) public view returns (State) {
        Vault storage v = _vaults[vaultId];
        Status s = v.status;
        if (s == Status.NONE) return State.NONE;
        if (s == Status.TRIGGERED) return State.TRIGGERED;
        if (s == Status.SETTLED) return State.SETTLED;
        if (s == Status.CLOSED) return State.CLOSED;
        uint256 t = block.timestamp;
        uint256 last = v.lastCheckin;
        if (t < last + v.interval) return State.ALIVE;
        if (t < last + uint256(v.interval) * (uint256(v.grace) + 1)) return State.WARNING;
        return State.OVERDUE;
    }

    function deadlines(uint256 vaultId) external view returns (uint64 warningAt, uint64 deadline) {
        Vault storage v = _vaults[vaultId];
        if (v.status == Status.NONE) return (0, 0);
        warningAt = v.lastCheckin + v.interval;
        deadline = v.lastCheckin + v.interval * (uint64(v.grace) + 1);
    }

    function getHeirs(uint256 vaultId) external view returns (Heir[] memory) {
        return _heirs[vaultId];
    }

    function getTokens(uint256 vaultId) external view returns (address[] memory) {
        return _tokens[vaultId];
    }

    function balanceOf(uint256 vaultId, address token) external view returns (uint256) {
        return _balances[vaultId][token];
    }

    function getAgent(uint256 vaultId) external view returns (Agent memory) {
        return _agents[vaultId];
    }

    function heirNonce(uint256 vaultId, address heir) external view returns (uint256) {
        return _heirNonces[vaultId][heir];
    }

    function claimable(uint256 vaultId, uint256 heirIndex, address token) external view returns (uint256) {
        return _claimable[vaultId][heirIndex][token];
    }

    // ------------------------------------------------------------- internal

    function _requireActive(uint256 vaultId, Status s) private pure {
        if (s == Status.NONE) revert VaultNotFound(vaultId);
        if (s != Status.ACTIVE) revert WrongStatus(s);
    }

    function _checkTiming(uint64 interval, uint8 grace) private pure {
        if (interval < MIN_INTERVAL || interval > MAX_INTERVAL) revert BadInterval();
        if (grace > MAX_GRACE) revert BadGrace();
    }

    /// @dev Section 5.3. Every successful owner action is a check-in.
    function _authOwner(uint256 vaultId, Action action, bytes32 argsHash, Auth calldata auth)
        private
        returns (Vault storage v)
    {
        v = _vaults[vaultId];
        _requireActive(vaultId, v.status);
        if (auth.nonce != v.nonce) revert BadNonce(v.nonce, auth.nonce);
        if (block.timestamp > auth.expiry) revert SignatureExpired(auth.expiry);

        bytes memory key;
        if (v.keyMode == KeyMode.ACCOUNT) {
            if (auth.pubkey.length != 0) revert UnexpectedPubkey();
            key = PQC.accountKey(v.owner);
        } else {
            if (auth.pubkey.length != 2592) revert BadPubkeyLength(auth.pubkey.length);
            if (keccak256(auth.pubkey) != v.pubkeyHash) revert PubkeyMismatch();
            key = auth.pubkey;
        }
        PQC.verify(key, auth.sig, actionDigest(vaultId, action, argsHash, auth.nonce, auth.expiry));

        v.nonce += 1;
        v.lastCheckin = uint64(block.timestamp);
        emit CheckedIn(vaultId, action, auth.nonce, uint64(block.timestamp));
    }

    function _setHeirs(uint256 vaultId, Heir[] calldata heirs) private {
        uint256 n = heirs.length;
        if (n == 0 || n > MAX_HEIRS) revert BadHeirs();
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            Heir calldata h = heirs[i];
            if (h.account == address(0) || h.payoutTo == address(0) || h.payoutTo == address(this) || h.bps == 0) {
                revert BadHeirs();
            }
            for (uint256 j; j < i; ++j) {
                if (heirs[j].account == h.account) revert BadHeirs();
            }
            sum += h.bps;
        }
        if (sum != BPS) revert BadHeirs();
        delete _heirs[vaultId];
        for (uint256 i; i < n; ++i) {
            _heirs[vaultId].push(heirs[i]);
        }
    }

    function _send(address token, address to, uint256 amount) private {
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }
}
