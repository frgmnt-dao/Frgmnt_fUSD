// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Minimal mock compatible with IAggregatorV3Interface.latestRoundData
contract MockAggregator {
	int256 public answer;
	uint256 public updatedAt;
	bool public shouldRevert;

	function setData(int256 _answer, uint256 _updatedAt, bool _shouldRevert) external {
		answer = _answer;
		updatedAt = _updatedAt;
		shouldRevert = _shouldRevert;
	}

	function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
		if (shouldRevert) {
			revert("forced revert");
		}
		return (1, answer, 0, updatedAt, 1);
	}
}
