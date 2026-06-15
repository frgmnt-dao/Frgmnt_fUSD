// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAssetHandler } from "../interfaces/IAssetHandler.sol";

/// @notice Test mock implementing IAssetHandler.
contract MockAssetHandler is IAssetHandler {
    mapping(address => uint16) public override assetTypes;
    mapping(address => address) public override priceAggregators;
    mapping(address => uint256) private _prices;

    function setAssetType(address asset, uint16 assetType) external {
        assetTypes[asset] = assetType;
    }

    function setPrice(address asset, uint256 price) external {
        _prices[asset] = price;
    }

    function addAsset(address asset, uint16 assetType, address aggregator) external override {
        assetTypes[asset] = assetType;
        priceAggregators[asset] = aggregator;
    }

    function addAssets(Asset[] memory assets) external override {
        for (uint256 i = 0; i < assets.length; i++) {
            assetTypes[assets[i].asset] = assets[i].assetType;
            priceAggregators[assets[i].asset] = assets[i].aggregator;
        }
    }

    function removeAsset(address asset) external override {
        assetTypes[asset] = 0;
        priceAggregators[asset] = address(0);
        _prices[asset] = 0;
    }

    function getUSDPrice(address asset) external view override returns (uint256) {
        return _prices[asset];
    }
}
