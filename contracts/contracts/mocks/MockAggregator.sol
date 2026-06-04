// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Minimal mock compatible with IAggregatorV3Interface.latestRoundData
contract MockAggregator {
    int256 public answer;
    uint256 public startedAt;
    uint256 public updatedAt;
    bool public shouldRevert;
    uint8 public decimals_ = 8;

    function setData(int256 _answer, uint256 _updatedAt, bool _shouldRevert) external {
        answer = _answer;
        startedAt = _updatedAt;
        updatedAt = _updatedAt;
        shouldRevert = _shouldRevert;
    }

    function setDecimals(uint8 _decimals) external {
        decimals_ = _decimals;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        if (shouldRevert) {
            revert("forced revert");
        }
        return (1, answer, startedAt, updatedAt, 1);
    }

    function decimals() external view returns (uint8) {
        return decimals_;
    }
}
