// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Fixed supply minted once in the constructor. No mint, no owner, no admin.
contract TestToken is ERC20 {
    constructor(string memory name_, string memory symbol_, address recipient, uint256 supply)
        ERC20(name_, symbol_)
    {
        _mint(recipient, supply);
    }
}
