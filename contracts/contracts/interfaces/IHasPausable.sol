// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Frgmnt — IHasPausable
interface IHasPausable {
  function isPaused() external view returns (bool);

  function pausedPools(address pool) external view returns (bool);

  function tradingPausedPools(address pool) external view returns (bool);
}