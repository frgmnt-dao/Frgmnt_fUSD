// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Id}
  from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";

import { IAssetGuard } from "./IAssetGuard.sol";

/// @title IMorphoBlueLendingPoolAssetGuard
/// @notice Interface for Morpho Blue AssetGuard flashloan handling
/// @dev
///  - Mirrors the dHEDGE Aave asset guard interface pattern
///  - Used by PoolLogic / AssetHandler to execute flashloan unwinds
interface IMorphoBlueLendingPoolAssetGuard {
  /**
   * @notice Builds the execution plan after receiving a Morpho flashloan
   * @dev
   *  - Called by PoolLogic immediately after the flashloan is initiated
   *  - Must return a deterministic list of transactions
   *  - Must fully unwind debt, withdraw assets, and approve flashloan repayment
   *
   * @param pool The PoolLogic address that owns the position
   * @param repayAsset The asset borrowed via flashloan
   * @param repayAmount The amount borrowed via flashloan (principal)
   * @param params ABI-encoded FlashloanParams struct
   *
   * @return transactions List of transactions to be executed by PoolLogic
   */
  function flashloanProcessing(
    address pool,
    address repayAsset,
    uint256 repayAmount,
    bytes calldata params
  )
    external
    view
    returns (IAssetGuard.MultiTransaction[] memory transactions);

  /**
   * @notice Returns the Morpho Blue core contract used for flashloans
   * @dev
   *  - Equivalent to `aaveLendingPool()` in Aave asset guards
   *  - Used by the AssetHandler to identify the protocol endpoint
   *
   * @return morpho The Morpho Blue core contract address
   */
  function morpho() external view returns (address);

}
