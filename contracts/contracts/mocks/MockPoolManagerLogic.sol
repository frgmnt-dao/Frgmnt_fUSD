// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal mock that satisfies both IPoolManagerLogic and IManaged
///         for the purposes of ERC20Guard.
contract MockPoolManagerLogic {
    struct Asset {
        address asset;
        bool isDeposit;
    }

    address public _factory;
    address public _poolLogic;
    address public _manager;
    uint256 public _reservedAssetBalance;
    Asset[] private _supportedAssets;
    mapping(address => address) private _assetGuards;

    constructor(address factory_, address poolLogic_, address manager_) {
        _factory = factory_;
        _poolLogic = poolLogic_;
        _manager = manager_;
    }

    // IPoolManagerLogic-like
    function factory() external view returns (address) {
        return _factory;
    }

    function poolLogic() external view returns (address) {
        return _poolLogic;
    }

    // IManaged-like
    function manager() external view returns (address) {
        return _manager;
    }

    // IPoolLogic-like: allows ERC20Guard.withdrawProcessing to call reservedAssetBalance
    function reservedAssetBalance(address) external view returns (uint256) {
        return _reservedAssetBalance;
    }

    function setReservedAssetBalance(uint256 reservedAssetBalance_) external {
        _reservedAssetBalance = reservedAssetBalance_;
    }

    // IPoolLogic-like: allows ERC20Guard.removeAssetCheck to find the poolManagerLogic
    function poolManagerLogic() external view returns (address) {
        return address(this);
    }

    // IHasSupportedAsset-like: required by ERC20Guard.removeAssetCheck
    function getSupportedAssets() external view returns (Asset[] memory) {
        return _supportedAssets;
    }

    // IPoolManagerLogic-like: required by ERC20Guard.removeAssetCheck iteration
    function getAssetGuard(address asset) external view returns (address) {
        return _assetGuards[asset];
    }

    function setSupportedAsset(address asset, bool isDeposit) external {
        _supportedAssets.push(Asset({ asset: asset, isDeposit: isDeposit }));
    }

    function setAssetGuard(address asset, address guard) external {
        _assetGuards[asset] = guard;
    }
}
