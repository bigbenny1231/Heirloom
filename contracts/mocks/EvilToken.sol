// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice TEST ONLY adversarial ERC-20 with selectable misbehaviour.
contract EvilToken {
    enum Mode {
        NORMAL, //            behaves
        RETURN_FALSE, //      transfer returns false (no revert)
        REVERT, //            transfer reverts
        REENTER, //           transfer/transferFrom first calls reentryTarget.reentryData, then proceeds
        BURN_GAS, //          transfer spins until gas is gone
        FEE_ON_TRANSFER, //   1% of each transfer is burned
        RETURN_BOMB, //       transfer returns 1 MiB of data
        NO_RETURN //          transfer succeeds with empty returndata (USDT style)
    }

    string public name = "Evil";
    string public symbol = "EVIL";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    Mode public mode;
    address public reentryTarget;
    bytes public reentryData;
    bool public reentryAttempted;
    bool public reentrySucceeded;
    bytes public lastReentryReturn;
    /// @dev Only the transfer entry points listed here reenter.
    bool public reenterOnTransferFrom = true;
    bool public reenterOnTransfer = true;

    constructor(address recipient, uint256 supply) {
        balanceOf[recipient] = supply;
        totalSupply = supply;
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function setReentry(address target, bytes calldata data, bool onTransferFrom, bool onTransfer) external {
        reentryTarget = target;
        reentryData = data;
        reenterOnTransferFrom = onTransferFrom;
        reenterOnTransfer = onTransfer;
        reentryAttempted = false;
        reentrySucceeded = false;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _move(msg.sender, to, amount, reenterOnTransfer);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= amount, "allowance");
            allowance[from][msg.sender] = a - amount;
        }
        return _move(from, to, amount, reenterOnTransferFrom);
    }

    function _move(address from, address to, uint256 amount, bool reenter) private returns (bool) {
        Mode m = mode;
        if (m == Mode.REVERT) revert("EvilToken: revert");
        if (m == Mode.RETURN_FALSE) return false;
        if (m == Mode.BURN_GAS) {
            while (true) {}
        }
        if (m == Mode.REENTER && reenter && reentryTarget != address(0)) {
            reentryAttempted = true;
            (bool ok, bytes memory ret) = reentryTarget.call(reentryData);
            lastReentryReturn = ret;
            if (ok) reentrySucceeded = true;
        }
        require(balanceOf[from] >= amount, "balance");
        uint256 received = amount;
        if (m == Mode.FEE_ON_TRANSFER) {
            received = amount - amount / 100;
            totalSupply -= amount - received;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += received;
        if (m == Mode.RETURN_BOMB) {
            assembly {
                mstore(0, 1)
                return(0, 1048576)
            }
        }
        if (m == Mode.NO_RETURN) {
            assembly { return(0, 0) }
        }
        return true;
    }
}
