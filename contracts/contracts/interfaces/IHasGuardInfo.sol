// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Frgmnt — IHasGuardInfo
interface IHasGuardInfo {
  // Get guard
  function getContractGuard(address extContract) external view returns (address);

  // Get asset guard
  function getAssetGuard(address extContract) external view returns (address);
}
