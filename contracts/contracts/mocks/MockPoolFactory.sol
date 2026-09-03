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

    // CertiK FNA-45 follow-up: SlippageAccumulator.assetValue() no longer consults an asset's
    // guard at all (the IPreValuedAssetGuard short-circuit was removed — see that function's own
    // docs). Kept here only so SlippageAccumulator.test.ts can register a pre-valued-marked guard
    // and assert pricing proceeds identically to any other asset, proving the guard is genuinely
    // no longer consulted.
    function setAssetGuard(address asset, address guard) external {
        assetGuards[asset] = guard;
    }

    function getAssetGuard(address asset) external view returns (address) {
        return assetGuards[asset];
    }
}
