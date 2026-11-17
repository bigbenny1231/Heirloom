// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice TEST ONLY native-value receiver with selectable misbehaviour.
contract EvilReceiver {
    enum Mode {
        ACCEPT,
        REVERT,
        BURN_GAS,
        REENTER,
        NEED_GAS // succeeds only if at least requiredGas is available on entry
    }

    Mode public mode;
    address public target;
    bytes public data;
    bool public reentryAttempted;
    bool public reentrySucceeded;
    bytes public lastReentryReturn;
    uint256 public received;
    uint256 public requiredGas = 49_000;

    function setRequiredGas(uint256 g) external {
        requiredGas = g;
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function setReentry(address t, bytes calldata d) external {
        target = t;
        data = d;
        reentryAttempted = false;
        reentrySucceeded = false;
    }

    /// @dev Lets the harness call an arbitrary function (e.g. vault.trigger) from this contract.
    function exec(address t, bytes calldata d) external returns (bool ok, bytes memory ret) {
        (ok, ret) = t.call(d);
    }

    receive() external payable {
        Mode m = mode;
        if (m == Mode.REVERT) revert("EvilReceiver: no");
        if (m == Mode.NEED_GAS) {
            if (gasleft() < requiredGas) revert("EvilReceiver: gas");
            return;
        }
        if (m == Mode.BURN_GAS) {
            while (true) {}
        }
        if (m == Mode.REENTER && target != address(0)) {
            reentryAttempted = true;
            (bool ok, bytes memory ret) = target.call(data);
            lastReentryReturn = ret;
            if (ok) reentrySucceeded = true;
        }
        received += msg.value;
    }
}
