// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

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

    // Lets a test point poolLogic() at this contract itself (e.g. address(this)), so the same
    // mock can stand in for IPoolLogic.reservedAssetBalance() when exercising code paths that
    // resolve pool via managerLogic.poolLogic() rather than receiving it as a direct parameter.
    function setPoolLogic(address poolLogic_) external {
        _poolLogic = poolLogic_;
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

    // Lets a test set up a pre-existing allowance from this mock (acting as the pool, when
    // poolLogic() is pointed at itself via setPoolLogic) before exercising
    // ERC20Guard.txGuard()'s approve() handling, to test that reducing or matching an
    // already-outstanding allowance is never blocked by the reserved-balance check.
    function approveToken(address token_, address spender, uint256 amount) external {
        IERC20(token_).approve(spender, amount);
    }
}
