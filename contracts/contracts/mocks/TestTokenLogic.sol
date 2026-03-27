// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test token that mimics ITokenLogic for PoolLogic tests.
/// - Standard ERC20 with mint
/// - burn / burnFrom
/// - exit cooldown via getExitRemainingCooldown
contract TestTokenLogic is ERC20 {
    uint8 private _decimals;
    mapping(address => uint256) private _exitCooldown;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    // ---- Mint helper for tests ----
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    // ---- ITokenLogic-like functions ----

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    function burnFrom(address account, uint256 amount) external {
        uint256 currentAllowance = allowance(account, msg.sender);
        require(currentAllowance >= amount, "burn > allowance");
        _approve(account, msg.sender, currentAllowance - amount);
        _burn(account, amount);
    }

    function getExitRemainingCooldown(address user) external view returns (uint256) {
        return _exitCooldown[user];
    }

    /// @notice Test helper to simulate cooldown.
    function setExitCooldown(address user, uint256 value) external {
        _exitCooldown[user] = value;
    }
}
