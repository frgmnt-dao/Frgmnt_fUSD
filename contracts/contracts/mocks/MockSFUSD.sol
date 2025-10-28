// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockSFUSD
 * @notice A simple mock contract used as a sink for stablecoin deposits.
 * @dev It just exists so that FUSDUpgradeable can forward tokens to it via safeTransferFrom.
 */
contract MockSFUSD {
    // Simple health-check helper
    function ping() external pure returns (bool) {
        return true;
    }
}
