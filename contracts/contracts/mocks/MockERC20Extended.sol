// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal mock for IERC20Extended used for SlippageAccumulator tests.
contract MockERC20Extended {
    uint8 private _decimals;

    constructor(uint8 decimals_) {
        _decimals = decimals_;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function setDecimals(uint8 newDecimals) external {
        _decimals = newDecimals;
    }
}
