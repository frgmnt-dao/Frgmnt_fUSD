// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal mock for IHasAssetInfo used by CLPriceLibrary tests.
contract MockAssetInfo {
    mapping(address => uint256) public prices;

    function setPrice(address token, uint256 price) external {
        prices[token] = price;
    }

    function getAssetPrice(address token) external view returns (uint256) {
        return prices[token];
    }
}
