// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Frgmnt — IHasAssetInfo
interface IHasAssetInfo {
	function validateAsset(address asset) external view returns (bool);

	function getAssetPrice(address asset) external view returns (uint256);

	function getAssetType(address asset) external view returns (uint16);

	function getMaximumSupportedAssetCount() external view returns (uint256);
}
