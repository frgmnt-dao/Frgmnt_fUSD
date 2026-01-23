// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IPoolManagerLogic } from "../interfaces/IPoolManagerLogic.sol";
import { IHasSupportedAsset } from "../interfaces/IHasSupportedAsset.sol";

/**
 * @title FundCalculationLibrary
 * @dev Stateless utility library extracted from PoolLogic.
 */
library FundCalculationLibrary {

  
    function calculatePerformanceFee(
        uint256 _totalValue,
        uint256 _accountedAssets,
        uint256 _performanceFeeNumerator,
        uint256 _feeDenominator
    ) internal pure returns (uint256 performanceFee, uint256 netYield) {

        if (_totalValue <= _accountedAssets) {
            return (0, 0);
        }

        uint256 incrementalYield  = _totalValue - _accountedAssets;

        // Performance fee computed in USD
        performanceFee =
            (incrementalYield * _performanceFeeNumerator) / _feeDenominator;

        netYield = incrementalYield - performanceFee;
    }


    function calculateManagementFee(
        uint256 _totalFusd,
        uint256 _lastFeeMintTime,
        uint256 _managementFeeNumerator,
        uint256 _feeDenominator
    ) internal view returns (uint256 managementFee, uint256 lastFeeMintTime) {

        uint256 ts = block.timestamp;
        uint256 dt = ts - _lastFeeMintTime;

        // Default values
        lastFeeMintTime = ts;

        if (dt == 0) return (0, lastFeeMintTime);

        // No supply or zero fee rate → no management fee
        if (_totalFusd == 0 || _managementFeeNumerator == 0){
            return (0, lastFeeMintTime);
        }

        // Linear time-based management fee
        managementFee =
        (_totalFusd * _managementFeeNumerator * dt)
        / _feeDenominator
        / 365 days;
    }


    // ============================================================
    // =            FUSD → ASSET CONVERSION HELPERS                =
    // ============================================================

    /**
     * @dev Converts a FUSD amount to the corresponding asset amount using PoolManagerLogic prices.
     *
     * SAME LOGIC AS PoolLogic._fusdToAssetAmount
     */
    function fusdToAssetAmount(
        address poolManagerLogic,
        uint256 fusdAmount,
        address asset
    ) external view returns (uint256 assetAmount) {
        if (fusdAmount == 0) return 0;

        // Asset must be explicitly supported by the pool
        if (!IHasSupportedAsset(poolManagerLogic).isSupportedAsset(asset)) {
            return 0;
        }

        uint256 price = IPoolManagerLogic(poolManagerLogic).getAssetPrice(asset);
        if (price == 0) return 0;

        uint256 decimals = IPoolManagerLogic(poolManagerLogic).assetDecimal(asset);

        // FUSD is USD-18
        uint256 assetAmount18 = (fusdAmount * 1e18) / price;

        if (decimals == 18) {
            assetAmount = assetAmount18;
        } else if (decimals < 18) {
            assetAmount = assetAmount18 / (10 ** (18 - decimals));
        } else {
            assetAmount = assetAmount18 * (10 ** (decimals - 18));
        }
    }
}
