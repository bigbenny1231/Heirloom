// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice TEST ONLY. One contract installed with setCode at both 0x...0a01 and 0x...0a02.
/// @dev Storage is written through the setStorageAt-free path: the harness calls the setters on the
///      installed address, so state lives at that address. Never deployed to a real network.
contract MockQorePQC {
    struct KeyInfo {
        bool registered;
        uint8 algorithmId;
        bytes pubkey;
        bool possessionProven;
    }

    /// @dev All registrations are keyed by `epoch`; reset() bumps it so a re-installed mock starts clean even though
    ///      setCode never clears the storage at the precompile address.
    uint256 public epoch;
    mapping(uint256 => mapping(bytes32 => bool)) private _accepted;
    mapping(uint256 => mapping(address => KeyInfo)) private _keys;
    /// @dev When true, both entry points answer success with empty returndata (inactive precompile).
    bool public inactive;
    /// @dev Raw bytes returned by pqcVerify when non-empty (for malformed-answer tests).
    bytes public rawVerifyReturn;
    bytes public rawStatusReturn;

    function reset() external {
        epoch++;
        inactive = false;
        delete rawVerifyReturn;
        delete rawStatusReturn;
    }

    function accepted(bytes32 k) external view returns (bool) {
        return _accepted[epoch][k];
    }

    function setInactive(bool v) external {
        inactive = v;
    }

    function setRawVerifyReturn(bytes calldata r) external {
        rawVerifyReturn = r;
    }

    function setRawStatusReturn(bytes calldata r) external {
        rawStatusReturn = r;
    }

    /// @notice Register a (pubkey, message, signature) triple that the harness verified for real.
    function accept(bytes32 pubkeyHash, bytes32 messageHash, bytes32 sigHash) external {
        _accepted[epoch][keccak256(abi.encode(pubkeyHash, messageHash, sigHash))] = true;
    }

    function setKeyStatus(address account, bool registered, uint8 algorithmId, bytes calldata pubkey, bool proven)
        external
    {
        _keys[epoch][account] = KeyInfo(registered, algorithmId, pubkey, proven);
    }

    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external
        view
        returns (bool)
    {
        if (inactive) {
            assembly { return(0, 0) }
        }
        bytes memory raw = rawVerifyReturn;
        if (raw.length > 0) {
            assembly { return(add(raw, 0x20), mload(raw)) }
        }
        return _accepted[epoch][keccak256(abi.encode(keccak256(pubkey), keccak256(message), keccak256(signature)))];
    }

    function pqcKeyStatus(address account)
        external
        view
        returns (bool registered, uint8 algorithmId, bytes memory pubkey, bool possessionProven)
    {
        if (inactive) {
            assembly { return(0, 0) }
        }
        bytes memory raw = rawStatusReturn;
        if (raw.length > 0) {
            assembly { return(add(raw, 0x20), mload(raw)) }
        }
        KeyInfo storage k = _keys[epoch][account];
        return (k.registered, k.algorithmId, k.pubkey, k.possessionProven);
    }
}
