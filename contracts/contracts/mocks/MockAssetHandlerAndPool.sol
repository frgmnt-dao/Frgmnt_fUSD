// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IPoolLogic.sol";
import "../interfaces/IHasAssetInfo.sol";
import "../interfaces/IHasGuardInfo.sol";

/// @notice Test-only mock implementing IPoolLogic + IHasAssetInfo + IHasGuardInfo.
/// @dev Logic is deliberately minimal – just enough to satisfy the interfaces and your guards.
contract MockAssetHandlerAndPool is IPoolLogic, IHasAssetInfo, IHasGuardInfo {
	// --------- Asset info-style storage ---------
	mapping(address => bool) private _isValidAsset;
	mapping(address => uint256) private _assetPrices;

	// --------- Guard info-style storage ---------
	mapping(address => address) private _assetGuard;
	mapping(address => address) private _contractGuard;

	// --------- Pool logic-style storage ---------
	address private _poolManagerLogic;

	// ---------------------------------------------------------------------
	// IPoolLogic implementation (minimal stubs for testing)
	// ---------------------------------------------------------------------

	/// @notice In tests, the pool's factory is simply this contract.
	function factory() external view override returns (address) {
		return address(this);
	}

	function poolManagerLogic() external view override returns (address) {
		return _poolManagerLogic;
	}

	function setPoolManagerLogic(address poolManagerLogic_) external override {
		_poolManagerLogic = poolManagerLogic_;
	}

	function calculateAvailableManagerFee(uint256) external pure override returns (uint256 fee) {
		// Simplified: no fees in the mock.
		return 0;
	}

	function tokenPrice() external pure override returns (uint256 price) {
		// Arbitrary constant price (1e18) for tests.
		return 1e18;
	}

	function tokenPriceWithoutManagerFee() external pure override returns (uint256 price) {
		// Same as tokenPrice in this mock.
		return 1e18;
	}

	function mintManagerFee() external override {
		// No-op in mock.
	}

	function deposit(address, uint256) external pure override returns (uint256 liquidityMinted) {
		// No actual accounting – just return 0.
		return 0;
	}

	function depositFor(address, address, uint256) external pure override returns (uint256 liquidityMinted) {
		return 0;
	}

	function depositForWithCustomCooldown(
		address,
		address,
		uint256,
		uint256
	) external pure override returns (uint256 liquidityMinted) {
		return 0;
	}

	function withdraw(uint256) external pure override {
		// No-op.
	}

	function withdrawSafe(uint256, ComplexAsset[] memory) external pure override {
		// No-op.
	}

	function withdrawToSafe(address, uint256, ComplexAsset[] memory) external pure override {
		// No-op.
	}

	function transfer(address, uint256) external pure override returns (bool) {
		// Always succeed in mock.
		return true;
	}

	function balanceOf(address) external pure override returns (uint256) {
		// No real balances – always 0.
		return 0;
	}

	function approve(address, uint256) external pure override returns (bool) {
		// Always succeed.
		return true;
	}

	function symbol() external pure override returns (string memory) {
		return "MOCK";
	}

	function transferFrom(address, address, uint256) external pure override returns (bool) {
		// Always succeed.
		return true;
	}

	function getExitRemainingCooldown(address) external pure override returns (uint256 remaining) {
		return 0;
	}

	// ---------------------------------------------------------------------
	// IHasAssetInfo implementation
	// ---------------------------------------------------------------------

	/// @notice Test helper: configure an asset in one call.
	function setAsset(address asset, bool valid, uint256 price) external {
		_isValidAsset[asset] = valid;
		_assetPrices[asset] = price;
	}

	function isValidAsset(address asset) external view override returns (bool) {
		return _isValidAsset[asset];
	}

	function getAssetPrice(address asset) external view override returns (uint256) {
		return _assetPrices[asset];
	}

	function getAssetType(address) external pure override returns (uint16) {
		// Not used in your guard; return 0.
		return 0;
	}

	function getMaximumSupportedAssetCount() external pure override returns (uint256) {
		// Arbitrary large number.
		return type(uint256).max;
	}

	// ---------------------------------------------------------------------
	// IHasGuardInfo implementation
	// ---------------------------------------------------------------------

	/// @notice Test helper: set guard for a specific asset.
	function setAssetGuard(address asset, address guard) external {
		_assetGuard[asset] = guard;
	}

	/// @notice Test helper: set guard for a specific external contract.
	function setContractGuard(address extContract, address guard) external {
		_contractGuard[extContract] = guard;
	}

	function getAssetGuard(address asset) external view override returns (address) {
		return _assetGuard[asset];
	}

	function getContractGuard(address extContract) external view override returns (address) {
		return _contractGuard[extContract];
	}
}
