// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IHasAssetInfo } from "../interfaces/IHasAssetInfo.sol";
import { IHasGuardInfo } from "../interfaces/IHasGuardInfo.sol";

/// @notice Test mock that acts as both pool and factory for UniswapV3AssetGuard tests.
/// @dev Implements IPoolLogic.factory() (returns self), IHasAssetInfo, and IHasGuardInfo.
contract MockAssetHandlerAndPool is IHasAssetInfo, IHasGuardInfo {
    mapping(address => bool) private _supported;
    mapping(address => uint256) private _prices;
    mapping(address => uint16) private _assetTypes;
    mapping(address => address) private _contractGuards;
    mapping(address => address) private _assetGuards;
    uint256 private _maxSupportedAssetCount = 50;

    // --- Test helpers ---

    function setAsset(address asset, bool supported, uint256 price) external {
        _supported[asset] = supported;
        _prices[asset] = price;
    }

    function setContractGuard(address target, address guard) external {
        _contractGuards[target] = guard;
    }

    function setAssetGuardForType(uint16 assetType, address guard) external {
        _assetGuards[address(uint160(assetType))] = guard;
    }

    // --- IPoolLogic (partial) ---

    function factory() external view returns (address) {
        return address(this);
    }

    // --- IHasAssetInfo ---

    function isSupportedAsset(address asset) external view override returns (bool) {
        return _supported[asset];
    }

    function getAssetPrice(address asset) external view override returns (uint256) {
        return _prices[asset];
    }

    function getAssetType(address asset) external view override returns (uint16) {
        return _assetTypes[asset];
    }

    function getMaximumSupportedAssetCount() external view override returns (uint256) {
        return _maxSupportedAssetCount;
    }

    // --- IHasGuardInfo ---

    function getContractGuard(address extContract) external view override returns (address) {
        return _contractGuards[extContract];
    }

    function getAssetGuard(address extContract) external view override returns (address) {
        return _assetGuards[extContract];
    }
}
