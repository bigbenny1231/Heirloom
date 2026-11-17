// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice TEST ONLY, for the gas report. No storage reads or writes: pqcVerify always says true and pqcKeyStatus returns a
///         constant registered ML-DSA-87 key. The setters the harness calls are no-ops so the normal test helpers still work.
///         The report adds the real precompile prices (25,000 + 8/byte; 2,500) on top of the gas measured against this stub.
contract StubQorePQC {
    function pqcVerify(bytes calldata, bytes calldata, bytes calldata) external pure returns (bool) {
        return true;
    }

    function pqcKeyStatus(address) external pure returns (bool, uint8, bytes memory, bool) {
        return (true, 1, new bytes(2592), true);
    }

    // harness no-ops
    function reset() external {}
    function accept(bytes32, bytes32, bytes32) external {}
    function setKeyStatus(address, bool, uint8, bytes calldata, bool) external {}
    function setInactive(bool) external {}
    function setRawVerifyReturn(bytes calldata) external {}
    function setRawStatusReturn(bytes calldata) external {}
}
