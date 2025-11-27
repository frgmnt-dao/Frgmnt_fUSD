// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Simple target contract used for guarded tx execution tests.
contract TestTarget {
	uint256 public lastValue;

	function doSomething(uint256 v) external {
		lastValue = v;
	}
}
