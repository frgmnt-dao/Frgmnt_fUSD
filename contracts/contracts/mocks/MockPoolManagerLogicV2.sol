// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Enhanced mock that satisfies:
///         - IPoolManagerLogic (factory, poolLogic)
///         - IManaged (manager)
///         - IHasSupportedAsset-like (isSupportedAsset)
/// Used in UniswapV3NonfungiblePositionGuard tests.
contract MockPoolManagerLogicV2 {
	address public _factory;
	address public _poolLogic;
	address public _manager;

	// Supported assets registry
	mapping(address => bool) public supportedAssets;

	/// @param factory_ Address that will be returned by factory()
	/// @param poolLogic_ Address that will be returned by poolLogic()
	/// @param manager_ Address that will be returned by manager()
	constructor(address factory_, address poolLogic_, address manager_) {
		_factory = factory_;
		_poolLogic = poolLogic_;
		_manager = manager_;
	}

	// ---------------------------
	// IPoolManagerLogic-like
	// ---------------------------

	function factory() external view returns (address) {
		return _factory;
	}

	function poolLogic() external view returns (address) {
		return _poolLogic;
	}

	// ---------------------------
	// IManaged-like
	// ---------------------------

	function manager() external view returns (address) {
		return _manager;
	}

	// ---------------------------
	// IHasSupportedAsset-like
	// ---------------------------

	/// @notice Returns true if an asset is marked as supported.
	function isSupportedAsset(address asset) external view returns (bool) {
		return supportedAssets[asset];
	}

	/// @notice Test helper: mark/unmark an asset as supported.
	function setSupportedAsset(address asset, bool isSupported) external {
		supportedAssets[asset] = isSupported;
	}
}
