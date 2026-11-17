// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title QoreChain post-quantum precompile interfaces
/// @notice Signatures exactly as published in the QoreChain docs / @qorechain/evm 0.14.0.
/// @dev IMPORTANT: never call these through the interface with a plain high-level call.
///      On a chain where the precompile is inactive (e.g. mainnet today) the call returns
///      SUCCESS with EMPTY returndata. Callers MUST use a low-level staticcall and check
///      `success`, the returndata length, and the decoded value (see docs/SPEC.md section 9).
///      The interfaces exist for selectors and for mocks.

/// @dev Lives at 0x0000000000000000000000000000000000000A01.
interface IQorePQCVerify {
    /// @param pubkey    ML-DSA-87 public key (2592 bytes)
    /// @param signature ML-DSA-87 signature (4627 bytes)
    /// @param message   the signed message bytes (QDMV always passes a 32-byte digest)
    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external
        view
        returns (bool valid);
}

/// @dev Lives at 0x0000000000000000000000000000000000000A02.
interface IQorePQCKeyStatus {
    /// @return registered        the account has a registered PQ key
    /// @return algorithmId       1 = ML-DSA-87 ("dilithium5")
    /// @return pubkey            the registered public key bytes
    /// @return possessionProven  the account proved possession of the key at registration
    function pqcKeyStatus(address account)
        external
        view
        returns (bool registered, uint8 algorithmId, bytes memory pubkey, bool possessionProven);
}

/// @notice Shared constants. Solidity interfaces cannot hold constants, so they live in a library.
library QorePQCConstants {
    address internal constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address internal constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;
    uint8 internal constant ALG_ML_DSA_87 = 1;
    uint256 internal constant PUBKEY_LENGTH = 2592;
    uint256 internal constant SIGNATURE_LENGTH = 4627;
}
