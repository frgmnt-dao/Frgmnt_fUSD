// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////
                            IMPORTS
//////////////////////////////////////////////////////////////*/

import {IMorpho, Id, MarketParams, Position}  from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";

import {SharesMathLib}  from "@morpho-org/morpho-blue/src/libraries/SharesMathLib.sol";

import {MorphoBalancesLib}  from "@morpho-org/morpho-blue/src/libraries/periphery/MorphoBalancesLib.sol";

import {IMorphoBlueManager}  from "../interfaces/IMorphoBlueManager.sol";

import {IPoolLogic}  from "../interfaces/IPoolLogic.sol";

import {IHasAssetInfo} from "../interfaces/IHasAssetInfo.sol";

import {IERC20Extended} from "../interfaces/IERC20Extended.sol";

import {MorphoMathLib} from "./MorphoMathLib.sol";

/*//////////////////////////////////////////////////////////////
                        LIBRARY
//////////////////////////////////////////////////////////////*/

library MorphoCollectLib {

  /*//////////////////////////////////////////////////////////////
                            STRUCTS
  //////////////////////////////////////////////////////////////*/

  /// @notice Debt repayment plan for a single Morpho market
  struct DebtPlan {
    Id id;                         // Market id
    MarketParams mp;               // Market parameters
    uint256 repayBorrowShares;     // Borrow shares to repay (pro-rata)
    uint256 repayAssetsEst;        // Estimated asset amount required
  }

  /// @notice Supply withdrawal plan for a single Morpho market
  struct SupplyPlan {
    Id id;                           // Market id
    MarketParams mp;                 // Market parameters
    uint256 withdrawSupplyShares;    // Supply shares to withdraw
    uint256 withdrawAssetsEst;       // Estimated asset amount to receive
  }

  /// @notice Collateral plan for a single Morpho market
  struct CollateralPlan {
    Id id;                             // Market id
    MarketParams mp;                   // Market parameters
    uint256 withdrawCollateral;        // Amount of collateral to withdraw

  }

  struct MarketState {
    uint256  totalSupplyAssets;
    uint256  totalSupplyShares;
    uint256  totalBorrowAssets;
    uint256  totalBorrowShares;

  }

  

  /*//////////////////////////////////////////////////////////////
                    INTERNAL HELPERS
  //////////////////////////////////////////////////////////////*/

  function _getAccruedMarketTotals(
    address morpho,
    MarketParams memory mp
  )
    internal
    view
    returns (
      uint256 totalSupplyAssets,
      uint256 totalSupplyShares,
      uint256 totalBorrowAssets,
      uint256 totalBorrowShares
    )
  {
    (totalSupplyAssets,
      totalSupplyShares,
      totalBorrowAssets,
      totalBorrowShares) = MorphoBalancesLib.expectedMarketBalances(
      IMorpho(morpho),
      mp
    );
  }

  /*//////////////////////////////////////////////////////////////
                    COLLECT DEBTS
  //////////////////////////////////////////////////////////////*/

  
  /// @notice Builds pro-rata debt repayment plans
  function collectDebts(
    address morphoManager,
    address morpho,
    address pool,
    uint256 portion
  )
    external
    view
    returns (DebtPlan[] memory plans, bool hasDebt)
  {
    Id[] memory mids = IMorphoBlueManager(morphoManager).getPoolMarkets(pool);
    plans = new DebtPlan[](mids.length);

    uint256 n;
    uint256 totalBorrowAssets;
    uint256 totalBorrowShares; 
    Position memory p;
    MarketParams memory mp;
    address factory = IPoolLogic(pool).factory();

    for (uint256 i; i < mids.length; i++) {
      p = IMorpho(morpho).position(mids[i], pool);
      mp = IMorpho(morpho).idToMarketParams(mids[i]);

      if (
        p.borrowShares == 0 ||
        !IHasAssetInfo(factory).isSupportedAsset(mp.loanToken)
      ) continue;

      uint256 repayShares =
        MorphoMathLib.mulPortionRoundUp(p.borrowShares, portion);

      (, , totalBorrowAssets, totalBorrowShares) =
        _getAccruedMarketTotals(morpho, mp);

      uint256 repayAssets =
        SharesMathLib.toAssetsUp(
          repayShares,
          totalBorrowAssets,
          totalBorrowShares
        );

      plans[n++] = DebtPlan({
        id: mids[i],
        mp: mp,
        repayBorrowShares: repayShares,
        repayAssetsEst: repayAssets
      });

      hasDebt = true;
    }

    assembly { mstore(plans, n) }
  }

  /*//////////////////////////////////////////////////////////////
                    COLLECT SUPPLIES
  //////////////////////////////////////////////////////////////*/

  /// @notice Builds pro-rata supply withdrawal plans
  function collectSupplies(
    address morphoManager,
    address morpho,
    address pool,
    uint256 portion
  )
    external
    view
    returns (SupplyPlan[] memory plans)
  {
    Id[] memory mids = IMorphoBlueManager(morphoManager).getPoolMarkets(pool);
    plans = new SupplyPlan[](mids.length);

    uint256 n;
    uint256 totalSupplyAssets;
    uint256 totalSupplyShares;
    Position memory p;
    MarketParams memory mp;
    address factory = IPoolLogic(pool).factory();

    for (uint256 i; i < mids.length; i++) {
      p = IMorpho(morpho).position(mids[i], pool);
      mp = IMorpho(morpho).idToMarketParams(mids[i]);

      if (
        p.supplyShares == 0 ||
        !IHasAssetInfo(factory).isSupportedAsset(mp.loanToken)
      ) continue;

      uint256 shares =
        MorphoMathLib.mulPortionRoundDown(p.supplyShares, portion);

      (totalSupplyAssets, totalSupplyShares, , ) =
        _getAccruedMarketTotals(morpho, mp);

      uint256 assets =
        SharesMathLib.toAssetsDown(
          shares,
          totalSupplyAssets,
          totalSupplyShares
        );

      plans[n++] = SupplyPlan({
        id: mids[i],
        mp: mp,
        withdrawSupplyShares: shares,
        withdrawAssetsEst: assets
      });
    }

    assembly { mstore(plans, n) }
  }

  /*//////////////////////////////////////////////////////////////
                  COLLECT COLLATERALS
  //////////////////////////////////////////////////////////////*/


  /// @notice Builds pro-rata collateral plans
  function collectCollaterals(
    address morphoManager,
    address morpho,
    address pool,
    uint256 portion
  )
    external
    view
    returns (CollateralPlan[] memory plans)
  {
    Id[] memory mids = IMorphoBlueManager(morphoManager).getPoolMarkets(pool);
    plans = new CollateralPlan[](mids.length);

    uint256 n;
    Position memory p;
    MarketParams memory mp;
    uint256 amount;
    address factory = IPoolLogic(pool).factory();

    for (uint256 i; i < mids.length; i++) {
      p = IMorpho(morpho).position(mids[i], pool);
      mp = IMorpho(morpho).idToMarketParams(mids[i]);

      if (
        p.collateral == 0 ||
        !IHasAssetInfo(factory).isSupportedAsset(mp.collateralToken)
      ) continue;

      amount =
        MorphoMathLib.mulPortionRoundDown(p.collateral, portion);

      plans[n++] = CollateralPlan({
        id: mids[i],
        mp: mp,
        withdrawCollateral: amount
      });
    }

    assembly { mstore(plans, n) }
  }

  /// @notice Returns the pool's net USD exposure on Morpho
  /// @dev USD value is returned with 18 decimals
  function getBalance(address morphoManager, address morpho, address pool)
    internal
    view
    returns (uint256 balanceUsd18)
  {
    Id[] memory mids = IMorphoBlueManager(morphoManager).getPoolMarkets(pool);
    address factory = IPoolLogic(pool).factory();
    uint256 totalCollateralUsd18;
    uint256 totalDebtUsd18;
    MarketState memory marketState;
    Position memory p;
    MarketParams memory mp;
    for (uint256 i; i < mids.length; i++) {
      p = IMorpho(morpho).position(mids[i], pool);
      if (p.collateral == 0 && p.borrowShares == 0 && p.supplyShares == 0) continue;
      mp = IMorpho(morpho).idToMarketParams(mids[i]);
      (marketState.totalSupplyAssets,
      marketState.totalSupplyShares,
      marketState.totalBorrowAssets,
      marketState.totalBorrowShares) = _getAccruedMarketTotals(morpho,mp);
      totalCollateralUsd18 += _getCollateralValue(p, mp, factory);
      totalCollateralUsd18 += _getSupplyValue(p, mp, factory, marketState);
      totalDebtUsd18 += _getBorrowValue(p, mp, factory, marketState);
    }

    if (totalDebtUsd18 >= totalCollateralUsd18) {
      return 0;
    }

    balanceUsd18 = totalCollateralUsd18 - totalDebtUsd18;
  }

  
  function _getCollateralValue(
    Position memory p,
    MarketParams memory mp,
    address factory
    ) internal view returns (uint256 value) {
    if (p.collateral == 0 || !IHasAssetInfo(factory).isSupportedAsset(mp.collateralToken)) {
      return 0;
    }
    uint256 price = IHasAssetInfo(factory).getAssetPrice(mp.collateralToken);
    uint256 unit = 10 ** IERC20Extended(mp.collateralToken).decimals();
    return (uint256(p.collateral) * price) / unit;
  }


  function _getSupplyValue(
    Position memory p,
    MarketParams memory mp,
    address factory,
    MarketState memory ms
    ) internal view returns (uint256 value) {

    if (p.supplyShares == 0 || !IHasAssetInfo(factory).isSupportedAsset(mp.loanToken)) {
      return 0;
    }

    uint256 assets =
    SharesMathLib.toAssetsDown(p.supplyShares, ms.totalSupplyAssets, ms.totalSupplyShares);

    uint256 price = IHasAssetInfo(factory).getAssetPrice(mp.loanToken);
    uint256 unit = 10 ** IERC20Extended(mp.loanToken).decimals();

    return (assets * price) / unit;
  }


  function _getBorrowValue(
    Position memory p,
    MarketParams memory mp,
    address factory,
    MarketState memory ms
    ) internal view returns (uint256 value) {

    if (p.borrowShares == 0 || !IHasAssetInfo(factory).isSupportedAsset(mp.loanToken)) {
      return 0;
    }

    uint256 assets =
    SharesMathLib.toAssetsUp(p.borrowShares, ms.totalBorrowAssets, ms.totalBorrowShares);

    uint256 price = IHasAssetInfo(factory).getAssetPrice(mp.loanToken);
    uint256 unit = 10 ** IERC20Extended(mp.loanToken).decimals();

    return (assets * price) / unit;
  }


}



