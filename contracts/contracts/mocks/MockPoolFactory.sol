// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Combined mock implementing IHasAssetInfo and IHasGuardInfo for SlippageAccumulator tests.
contract MockPoolFactory {
    mapping(address => uint256) public prices;
    mapping(address => address) public contractGuards;

    // ---- Asset Info ----
    function setPrice(address token, uint256 price) external {
        prices[token] = price;
    }

    function getAssetPrice(address token) external view returns (uint256) {
        return prices[token];
    }

    // ---- Guard Info ----
    function setContractGuard(address target, address guard) external {
        contractGuards[target] = guard;
    }

    function getContractGuard(address target) external view returns (address) {
        return contractGuards[target];
    }
}
