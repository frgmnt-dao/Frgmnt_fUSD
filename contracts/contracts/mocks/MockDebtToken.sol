// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal mock debt token used in AaveLendingPoolGuardV3 tests.
/// @dev Only balanceOf is needed. We don't need full ERC20 behavior.
contract MockDebtToken {
    mapping(address => uint256) public balanceOf;

    function setBalance(address user, uint256 amount) external {
        balanceOf[user] = amount;
    }
}
