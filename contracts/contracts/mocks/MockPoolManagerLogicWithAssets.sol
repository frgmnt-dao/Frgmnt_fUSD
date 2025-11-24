// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Mock that mimics the parts of IPoolManagerLogic and IHasSupportedAsset
///         needed by AaveLendingPoolGuardV3.
/// @dev Your real IHasSupportedAsset.Asset struct may have more fields; if so,
///      adapt the struct below to match its exact layout.
contract MockPoolManagerLogicWithAssets {
    // --- IPoolManagerLogic-like bits ---
    address public _factory;
    address public _poolLogic;
    address public _manager;

    // --- IHasSupportedAsset-like bits ---

    struct Asset {
        address asset;
        // If your real IHasSupportedAsset.Asset struct has more fields,
        // add them here in the same order, e.g.:
        // bool isDeposit;
        // bool isWithdraw;
        // bool isBorrow;
        // bool isShort;
    }

    mapping(address => bool) public supported;
    Asset[] internal _assets;

    constructor(address factory_, address poolLogic_, address manager_) {
        _factory = factory_;
        _poolLogic = poolLogic_;
        _manager = manager_;
    }

    // ----------------- IPoolManagerLogic-like -----------------

    function factory() external view returns (address) {
        return _factory;
    }

    function poolLogic() external view returns (address) {
        return _poolLogic;
    }

    function manager() external view returns (address) {
        return _manager;
    }

    // ----------------- IHasSupportedAsset-like -----------------

    /// @notice Mark an asset as supported/unsupported.
    /// @dev When enabling an asset, we append it to the _assets list so that
    ///      getSupportedAssets() returns a non-empty set for the guard loops.
    function setSupportedAsset(address asset, bool isSupported) external {
        if (!supported[asset] && isSupported) {
            _assets.push(Asset({asset: asset}));
        }
        supported[asset] = isSupported;
    }

    /// @notice Query whether an asset is supported.
    function isSupportedAsset(address asset) external view returns (bool) {
        return supported[asset];
    }

    /// @notice Return all supported assets.
    /// @dev AaveLendingPoolGuardV3 uses this to iterate and check for
    ///      existing debt positions via the Aave data provider.
    function getSupportedAssets() external view returns (Asset[] memory) {
        return _assets;
    }
}
