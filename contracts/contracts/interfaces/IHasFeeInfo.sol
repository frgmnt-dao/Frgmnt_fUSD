// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Frgmnt — IHasFeeInfo
interface IHasFeeInfo {
  // Manager fee
  function getMaximumFee() external view returns (uint256, uint256, uint256, uint256, uint256);

  function maximumPerformanceFeeNumeratorChange() external view returns (uint256);

  function performanceFeeNumeratorChangeDelay() external view returns (uint256);

  function getExitCooldown() external view returns (uint256);
}
