// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal factory/registry used by SFUSD tests.
/// Implements the tiny surface that SFUSD touches.
contract MockFactorySFUSD {
  address public owner;
  address public dao;
  address public fusdGuard;

  constructor(address _owner, address _dao, address _fusdGuard) {
    owner = _owner;
    dao = _dao;
    fusdGuard = _fusdGuard;
  }

  // ---- IHasPausable ----
  function isPaused() external pure returns (bool) { return false; }
  function pausedPools(address) external pure returns (bool) { return false; }
  function tradingPausedPools(address) external pure returns (bool) { return false; }

  // ---- IPoolFactory bits ----
  function receiverWhitelist(address) external pure returns (bool) { return false; }
  function governanceAddress() external pure returns (address) { return address(0); }
  function emitPoolEvent() external { /* noop */ }

  // ---- IHasGuardInfo ----
  function getContractGuard(address) external pure returns (address) { return address(0); }

  function getAssetGuard(address asset) external view returns (address) {
    // return the single guard for FUSD; other assets: none
    // tests only use FUSD
    asset; // silence warning
    return fusdGuard;
  }

  // ---- IHasDaoInfo ----
  function getDaoFee() external pure returns (uint256,uint256) {
    return (0, 1); // 0% fee
  }
  function daoAddress() external view returns (address) { return dao; }

  // ---- IHasFeeInfo ----
  function getExitCooldown() external pure returns (uint256) { return 0; }
}