// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IQorePQCVerify, IQorePQCKeyStatus, QorePQCConstants} from "../interfaces/IQorePQC.sol";

/// @notice Fail-closed access to the QoreChain PQ precompiles (docs/SPEC.md section 9).
/// @dev Low-level staticcalls only. An inactive precompile answers success with empty data.
library PQC {
    error BadPubkeyLength(uint256 length);
    error BadSignatureLength(uint256 length);
    error PrecompileUnavailable(address precompile);
    error PQSignatureInvalid();
    error PQKeyNotRegistered(address account);
    error PQKeyWrongAlgorithm(uint8 algorithmId);
    error PQKeyPossessionNotProven(address account);

    function verify(bytes memory pubkey, bytes calldata sig, bytes32 digest) internal view {
        if (pubkey.length != QorePQCConstants.PUBKEY_LENGTH) revert BadPubkeyLength(pubkey.length);
        if (sig.length != QorePQCConstants.SIGNATURE_LENGTH) revert BadSignatureLength(sig.length);
        _verify(pubkey, sig, digest);
    }

    /// @dev Same as verify but for a signature held in memory (rotation proof is calldata too, kept for symmetry).
    function _verify(bytes memory pubkey, bytes memory sig, bytes32 digest) private view {
        (bool ok, bytes memory ret) = QorePQCConstants.PQC_VERIFY
            .staticcall(abi.encodeCall(IQorePQCVerify.pqcVerify, (pubkey, sig, abi.encodePacked(digest))));
        if (!ok || ret.length != 32) revert PrecompileUnavailable(QorePQCConstants.PQC_VERIFY);
        if (abi.decode(ret, (uint256)) != 1) revert PQSignatureInvalid();
    }

    /// @notice Registered ML-DSA-87 key of `account`. Accepts both answer shapes seen in the wild:
    ///         4 values (registered, algorithmId, pubkey, possessionProven; bytes offset 0x80) and
    ///         3 values (registered, algorithmId, pubkey; bytes offset 0x60, possession unknown).
    ///         A 4-value answer with possessionProven == false is rejected. Anything malformed fails closed.
    function accountKey(address account) internal view returns (bytes memory pubkey) {
        (pubkey,) = _keyStatus(account);
    }

    /// @notice Like accountKey but additionally requires the chain to REPORT possessionProven == true.
    ///         A 3-value answer cannot show that, so it is refused (used by createVault, which has no signature).
    function accountKeyProven(address account) internal view returns (bytes memory pubkey) {
        bool provenKnown;
        (pubkey, provenKnown) = _keyStatus(account);
        if (!provenKnown) revert PQKeyPossessionNotProven(account);
    }

    function _keyStatus(address account) private view returns (bytes memory pubkey, bool provenKnown) {
        (bool ok, bytes memory ret) = QorePQCConstants.PQC_KEY_STATUS
            .staticcall(abi.encodeCall(IQorePQCKeyStatus.pqcKeyStatus, (account)));
        uint256 len = ret.length;
        if (!ok || len < 96) revert PrecompileUnavailable(QorePQCConstants.PQC_KEY_STATUS);

        uint256 w0;
        uint256 w1;
        uint256 off;
        assembly ("memory-safe") {
            w0 := mload(add(ret, 0x20))
            w1 := mload(add(ret, 0x40))
            off := mload(add(ret, 0x60))
        }
        if (w0 > 1 || w1 > 255) revert PrecompileUnavailable(QorePQCConstants.PQC_KEY_STATUS);

        bool proven = true;
        if (off == 0x80) {
            if (len < 160) revert PrecompileUnavailable(QorePQCConstants.PQC_KEY_STATUS);
            uint256 w3;
            assembly ("memory-safe") {
                w3 := mload(add(ret, 0x80))
            }
            if (w3 > 1) revert PrecompileUnavailable(QorePQCConstants.PQC_KEY_STATUS);
            proven = w3 == 1;
            provenKnown = true;
        } else if (off != 0x60) {
            revert PrecompileUnavailable(QorePQCConstants.PQC_KEY_STATUS);
        }

        // bytes block: length word at `off`, data right after, all inside the returndata
        if (len < off + 32) revert PrecompileUnavailable(QorePQCConstants.PQC_KEY_STATUS);
        uint256 blen;
        assembly ("memory-safe") {
            blen := mload(add(add(ret, 0x20), off))
        }
        if (blen > len || off + 32 + blen > len) revert PrecompileUnavailable(QorePQCConstants.PQC_KEY_STATUS);

        if (w0 == 0) revert PQKeyNotRegistered(account);
        if (w1 != QorePQCConstants.ALG_ML_DSA_87) revert PQKeyWrongAlgorithm(uint8(w1));
        if (!proven) revert PQKeyPossessionNotProven(account);
        if (blen != QorePQCConstants.PUBKEY_LENGTH) revert BadPubkeyLength(blen);

        pubkey = new bytes(blen);
        for (uint256 i; i < blen; i += 32) {
            assembly ("memory-safe") {
                mstore(add(add(pubkey, 0x20), i), mload(add(add(ret, 0x40), add(off, i))))
            }
        }
    }
}
