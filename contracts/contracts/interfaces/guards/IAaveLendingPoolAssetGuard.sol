// SPDX-License-Identifier: MIT

pragma solidity ^0.8.24;

import {IAssetGuard} from "./IAssetGuard.sol";

interface IAaveLendingPoolAssetGuard {
  function flashloanProcessing(
    address pool,
    address repayAsset,
    uint256 repayAmount,
    uint256 premium,
    bytes calldata params
  ) external view returns (IAssetGuard.MultiTransaction[] memory transactions);

  function aaveLendingPool() external view returns (address lendingPool);
}
