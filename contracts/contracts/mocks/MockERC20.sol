// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC20 + decimals used to satisfy IERC20 and IERC20Extended in tests.
contract MockERC20 {
    string public name = "Mock";
    string public symbol = "MCK";
    uint8 public _decimals;
    mapping(address => uint256) public balances;

    constructor(uint8 decimals_) {
        _decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        balances[to] += amount;
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }
}
