// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Combined mock implementing IHasAssetInfo and IHasGuardInfo for SlippageAccumulator tests.
contract MockPoolFactory {
    mapping(address => uint256) public prices;
    mapping(address => address) public contractGuards;
    mapping(address => address) public assetGuards;

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

    // FNA-45: SlippageAccumulator.assetValue() now looks up an asset's guard the same way
    // PoolManagerLogic.assetValue() does, to detect the IPreValuedAssetGuard marker. Defaults to
    // address(0) for every asset, so existing tests that never call setAssetGuard() keep going
    // through the price-multiplication path unchanged.
    function setAssetGuard(address asset, address guard) external {
        assetGuards[asset] = guard;
    }

    function getAssetGuard(address asset) external view returns (address) {
        return assetGuards[asset];
    }
}
