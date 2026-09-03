// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IPreValuedAssetGuard } from "../interfaces/guards/IPreValuedAssetGuard.sol";

/// @notice Mock PoolManagerLogic exposing exactly the surface MorphoVaultV2ContractGuard and
///         MorphoVaultV2AssetGuard depend on: poolLogic(), isSupportedAsset(), getAssetPrice(),
///         and assetDecimal(). `setAssetGuard`'s `registered` flag lets tests simulate the real
///         PoolManagerLogic.assetDecimal() "no guard" revert for an asset with no registered
///         asset guard.
contract MockMorphoVaultV2PoolManagerLogic {
    address public poolLogic;
    mapping(address => bool) public supported;
    mapping(address => uint256) public price;
    mapping(address => uint256) public decimalsOf;
    mapping(address => bool) public hasGuard;
    mapping(address => bool) public brokenPrice;

    function setPoolLogic(address pl) external {
        poolLogic = pl;
    }

    function setSupportedAsset(address a, bool isSupported) external {
        supported[a] = isSupported;
    }

    function isSupportedAsset(address a) external view returns (bool) {
        return supported[a];
    }

    function setAssetPrice(address a, uint256 p) external {
        price[a] = p;
    }

    function getAssetPrice(address a) external view returns (uint256) {
        // Simulates AssetHandler.getUSDPrice() reverting on a stale Chainlink feed or a
        // down/just-recovered L2 sequencer, rather than returning a value.
        require(!brokenPrice[a], "MockMorphoVaultV2PoolManagerLogic: price broken");
        return price[a];
    }

    function setBrokenPrice(address a, bool broken) external {
        brokenPrice[a] = broken;
    }

    function setAssetGuard(address a, bool registered, uint256 decimals_) external {
        hasGuard[a] = registered;
        decimalsOf[a] = decimals_;
    }

    function assetDecimal(address a) external view returns (uint256) {
        require(hasGuard[a], "no guard");
        return decimalsOf[a];
    }

    /// @notice CertiK FNA-45 follow-up test helper: forwards to `guard.getUnitPrice(asset)` so
    ///         `msg.sender` inside the guard is *this* mock's own address, exactly reproducing
    ///         how the real PoolManagerLogic.getAssetPrice() calls it (a plain external call from
    ///         itself) — getUnitPrice() relies on `msg.sender` as its pricing context.
    function callGetUnitPrice(address guard, address asset) external view returns (uint256) {
        return IPreValuedAssetGuard(guard).getUnitPrice(asset);
    }
}
