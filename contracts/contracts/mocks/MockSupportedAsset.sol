// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal mock for IHasSupportedAsset used for SlippageAccumulator tests.
contract MockSupportedAsset {
	mapping(address => bool) public supported;

	function setSupported(address asset, bool isSupported) external {
		supported[asset] = isSupported;
	}

	function isSupportedAsset(address asset) external view returns (bool) {
		return supported[asset];
	}
}
