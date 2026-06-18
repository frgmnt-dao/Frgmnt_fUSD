// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

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
        return price[a];
    }

    function setAssetGuard(address a, bool registered, uint256 decimals_) external {
        hasGuard[a] = registered;
        decimalsOf[a] = decimals_;
    }

    function assetDecimal(address a) external view returns (uint256) {
        require(hasGuard[a], "no guard");
        return decimalsOf[a];
    }
}
