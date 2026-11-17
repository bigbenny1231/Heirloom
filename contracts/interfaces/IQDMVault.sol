// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IQDMVault - Quantum Dead Man's Vault
/// @notice Interface matching docs/SPEC.md exactly. The post-quantum (ML-DSA-87) signature is the
///         authority for every owner and heir action; msg.sender carries no privilege except in
///         createVault (owner = msg.sender) and agentPay (msg.sender = agent).
interface IQDMVault {
    // ------------------------------------------------------------------ enums

    /// @dev Where the owner's ML-DSA-87 public key comes from.
    enum KeyMode {
        ACCOUNT, // 0: read live from pqcKeyStatus(owner)
        DEVICE //   1: keccak256(pubkey) pinned in the vault; pubkey passed in calldata
    }

    /// @dev Stored lifecycle status.
    enum Status {
        NONE, //      0: vault id unused
        ACTIVE, //    1
        TRIGGERED, // 2
        SETTLED, //   3
        CLOSED //     4
    }

    /// @dev Derived state returned by stateOf().
    enum State {
        NONE, //      0
        ALIVE, //     1
        WARNING, //   2
        OVERDUE, //   3
        TRIGGERED, // 4
        SETTLED, //   5
        CLOSED //     6
    }

    /// @dev Signed action ids. The numeric value is part of the signed digest. Never reorder.
    enum Action {
        NONE, //           0 (never signed)
        CREATE, //         1
        CHECKIN, //        2
        WITHDRAW, //       3
        SET_HEIRS, //      4
        SET_TIMING, //     5
        SET_AGENT, //      6
        REVOKE_AGENT, //   7
        ROTATE_KEY, //     8 (signed by the current key)
        ROTATE_KEY_POP, // 9 (signed by the new key)
        CLOSE, //          10
        SET_PAYOUT //      11 (signed by an heir's account key)
    }

    /// @dev Reason codes for a refused agent payment (emitted, not reverted).
    enum DenyReason {
        NONE, //                 0
        NOT_ALIVE, //            1
        EXPIRED, //              2
        PAYEE_NOT_ALLOWED, //    3
        ZERO_AMOUNT, //          4
        OVER_PER_TX, //          5
        OVER_DAILY, //           6
        INSUFFICIENT_BALANCE //  7
    }

    // ---------------------------------------------------------------- structs

    struct Heir {
        address account; //  heir identity; its registered PQ key authorises setPayout
        address payoutTo; // where the heir's share is sent
        uint16 bps; //       share in basis points; all heirs sum to 10000
    }

    struct CreateParams {
        bytes32 salt; //     owner-chosen, part of the vault id
        uint64 interval; //  heartbeat interval in seconds, 60 .. 365 days
        uint8 grace; //      missed intervals tolerated, 0 .. 12
        uint256 bounty; //   max native bounty paid to the trigger caller
        address[] tokens; // ERC-20 tokens this vault accepts, 0 .. 4, fixed for the vault's life
        Heir[] heirs; //     1 .. 10
    }

    /// @dev Owner authorisation attached to every owner action.
    struct Auth {
        uint256 nonce; //  must equal the vault's nonce
        uint256 expiry; // unix seconds; block.timestamp <= expiry
        bytes sig; //      ML-DSA-87 signature (4627 bytes) over the action digest
        bytes pubkey; //   ACCOUNT mode: empty. DEVICE mode: the 2592-byte public key
    }

    struct Vault {
        address owner;
        KeyMode keyMode;
        Status status;
        uint8 grace;
        uint64 interval;
        uint64 lastCheckin;
        uint64 triggeredAt;
        uint64 nonce;
        bytes32 pubkeyHash; // DEVICE mode only, else 0
        uint256 bounty;
    }

    struct Agent {
        address agent; //      0 = no agent
        address token; //      address(0) = native
        uint64 validUntil; //  unix seconds, inclusive
        uint64 spentDay; //    block.timestamp / 86400 of the last payment
        uint256 perTxLimit;
        uint256 dailyLimit;
        uint256 spentToday;
        address[] payees; //   1 .. 8
    }

    // ----------------------------------------------------------------- events

    event VaultCreated(
        uint256 indexed vaultId,
        address indexed owner,
        KeyMode keyMode,
        bytes32 pubkeyHash,
        uint64 interval,
        uint8 grace,
        uint256 bounty,
        address[] tokens
    );
    event HeirsSet(uint256 indexed vaultId, Heir[] heirs);
    event Deposited(uint256 indexed vaultId, address indexed token, address indexed from, uint256 amount);
    /// @dev Emitted by every successful owner-signed action (it is the proof of life).
    event CheckedIn(uint256 indexed vaultId, Action indexed action, uint256 nonce, uint64 at);
    event Withdrawn(uint256 indexed vaultId, address indexed token, address indexed to, uint256 amount);
    event TimingSet(uint256 indexed vaultId, uint64 interval, uint8 grace, uint256 bounty);
    event AgentSet(
        uint256 indexed vaultId,
        address indexed agent,
        address token,
        uint256 perTxLimit,
        uint256 dailyLimit,
        uint64 validUntil,
        address[] payees
    );
    event AgentRevoked(uint256 indexed vaultId, address indexed agent);
    event AgentPaid(
        uint256 indexed vaultId, address indexed agent, address indexed to, uint256 amount, uint256 spentToday
    );
    event AgentPayDenied(
        uint256 indexed vaultId, address indexed agent, address indexed to, uint256 amount, DenyReason reason
    );
    event KeyRotated(uint256 indexed vaultId, bytes32 oldPubkeyHash, bytes32 newPubkeyHash);
    event VaultClosed(uint256 indexed vaultId, address indexed to);
    event Triggered(uint256 indexed vaultId, address indexed caller, uint256 bountyPaid);
    event Settled(uint256 indexed vaultId);
    event HeirPaid(
        uint256 indexed vaultId, uint256 indexed heirIndex, address indexed token, address to, uint256 amount
    );
    event HeirCredited(uint256 indexed vaultId, uint256 indexed heirIndex, address indexed token, uint256 amount);
    event Claimed(
        uint256 indexed vaultId, uint256 indexed heirIndex, address indexed token, address to, uint256 amount
    );
    event PayoutSet(uint256 indexed vaultId, uint256 indexed heirIndex, address indexed heir, address newPayout);

    // ----------------------------------------------------------------- errors

    error VaultExists(uint256 vaultId);
    error VaultNotFound(uint256 vaultId);
    error WrongStatus(Status actual);
    error NotOverdue(uint64 deadline);
    error BadNonce(uint256 expected, uint256 got);
    error SignatureExpired(uint256 expiry);
    error BadSignatureLength(uint256 length);
    error BadPubkeyLength(uint256 length);
    error PubkeyMismatch();
    error UnexpectedPubkey();
    error WrongKeyMode();
    error SameKey();
    error PrecompileUnavailable(address precompile);
    error PQSignatureInvalid();
    error PQKeyNotRegistered(address account);
    error PQKeyWrongAlgorithm(uint8 algorithmId);
    error PQKeyPossessionNotProven(address account);
    error BadInterval();
    error BadGrace();
    error BadHeirs();
    error BadHeirIndex();
    error BadTokens();
    error TokenNotAllowed(address token);
    error ZeroAmount();
    error ZeroAddress();
    error BadRecipient();
    error InsufficientBalance(uint256 available, uint256 wanted);
    error TransferFailed();
    error InsufficientGas();
    error NotAgent();
    error BadAgent();
    error BadPayees();
    error NothingToClaim();

    // ------------------------------------------------------------- constants

    function TAG() external view returns (bytes32);
    function MAX_HEIRS() external view returns (uint256);
    function MAX_TOKENS() external view returns (uint256);
    function MAX_PAYEES() external view returns (uint256);
    function MIN_INTERVAL() external view returns (uint64);
    function MAX_INTERVAL() external view returns (uint64);
    function MAX_GRACE() external view returns (uint8);
    function MAX_BOUNTY_BPS() external view returns (uint256);
    function NATIVE_PUSH_GAS() external view returns (uint256);
    function TOKEN_PUSH_GAS() external view returns (uint256);

    // --------------------------------------------------------------- creation

    /// @notice Create an ACCOUNT-mode vault owned by msg.sender. msg.value is deposited.
    function createVault(CreateParams calldata p) external payable returns (uint256 vaultId);

    /// @notice Create a vault for `owner` with a PQ signature; anyone may submit. msg.value is deposited.
    /// @param pubkey ACCOUNT mode: empty. DEVICE mode: the 2592-byte key to pin.
    function createVaultFor(
        address owner,
        KeyMode keyMode,
        CreateParams calldata p,
        uint256 expiry,
        bytes calldata sig,
        bytes calldata pubkey
    ) external payable returns (uint256 vaultId);

    // --------------------------------------------------------------- deposits

    function depositNative(uint256 vaultId) external payable;
    function depositToken(uint256 vaultId, address token, uint256 amount) external;

    // ---------------------------------------------- owner actions (PQ-signed)

    function checkIn(uint256 vaultId, Auth calldata auth) external;
    function withdraw(uint256 vaultId, address token, uint256 amount, address to, Auth calldata auth) external;
    function setHeirs(uint256 vaultId, Heir[] calldata heirs, Auth calldata auth) external;
    function setTiming(uint256 vaultId, uint64 interval, uint8 grace, uint256 bounty, Auth calldata auth) external;
    function setAgent(
        uint256 vaultId,
        address agent,
        address token,
        uint256 perTxLimit,
        uint256 dailyLimit,
        uint64 validUntil,
        address[] calldata payees,
        Auth calldata auth
    ) external;
    function revokeAgent(uint256 vaultId, Auth calldata auth) external;
    /// @param newPubkey 2592-byte new key. @param newSig PoP signature by the new key (ROTATE_KEY_POP digest).
    function rotateKey(uint256 vaultId, bytes calldata newPubkey, bytes calldata newSig, Auth calldata auth)
        external;
    function close(uint256 vaultId, address to, Auth calldata auth) external;

    // ------------------------------------------------------------------ agent

    /// @notice msg.sender must be the vault's agent. Policy refusals return false and emit AgentPayDenied.
    function agentPay(uint256 vaultId, address to, uint256 amount) external returns (bool paid);

    // ---------------------------------------------------- inheritance (anyone)

    function trigger(uint256 vaultId) external;
    function settle(uint256 vaultId) external;
    function claim(uint256 vaultId, uint256 heirIndex, address token) external;

    // --------------------------------------------- heir action (PQ-signed)

    function setPayout(
        uint256 vaultId,
        uint256 heirIndex,
        address newPayout,
        uint256 nonce,
        uint256 expiry,
        bytes calldata sig
    ) external;

    // ------------------------------------------------------------------ views

    function computeVaultId(address owner, KeyMode keyMode, bytes32 pubkeyHash, CreateParams calldata p)
        external
        pure
        returns (uint256);
    function actionDigest(uint256 vaultId, Action action, bytes32 argsHash, uint256 nonce, uint256 expiry)
        external
        view
        returns (bytes32);
    function getVault(uint256 vaultId) external view returns (Vault memory);
    function stateOf(uint256 vaultId) external view returns (State);
    /// @return warningAt lastCheckin + interval. @return deadline lastCheckin + interval * (grace + 1).
    function deadlines(uint256 vaultId) external view returns (uint64 warningAt, uint64 deadline);
    function getHeirs(uint256 vaultId) external view returns (Heir[] memory);
    function getTokens(uint256 vaultId) external view returns (address[] memory);
    function balanceOf(uint256 vaultId, address token) external view returns (uint256);
    function getAgent(uint256 vaultId) external view returns (Agent memory);
    function heirNonce(uint256 vaultId, address heir) external view returns (uint256);
    function claimable(uint256 vaultId, uint256 heirIndex, address token) external view returns (uint256);
}
