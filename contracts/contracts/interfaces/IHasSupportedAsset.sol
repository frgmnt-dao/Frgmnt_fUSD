// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Frgmnt — IHasSupportedAsset
interface IHasSupportedAsset {
  struct Asset {
    address asset;
    bool isDeposit;
  }

  function getSupportedAssets() external view returns (Asset[] memory);

  function isSupportedAsset(address asset) external view returns (bool);
}
