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

        uint256 incrementalYield = _totalValue - _accountedAssets;

        // Performance fee computed in USD
        performanceFee = (incrementalYield * _performanceFeeNumerator) / _feeDenominator;

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
        if (_totalFusd == 0 || _managementFeeNumerator == 0) {
            return (0, lastFeeMintTime);
        }

        // Linear time-based management fee
        managementFee = (_totalFusd * _managementFeeNumerator * dt) / _feeDenominator / 365 days;
    }

    // ============================================================
    // =                  YIELD/FEE ACCRUAL (FNA-04)                =
    // ============================================================

    /// @dev PoolLogic and PoolManagerLogic are separately upgradeable proxies on an already-live,
    ///      mainnet-deployed protocol — a PoolLogic implementation carrying this fix can be
    ///      upgraded before, after, or independently of the PoolManagerLogic implementation that
    ///      adds totalFundValueWithCompleteness(). Calling it through a typed interface would
    ///      revert on any not-yet-upgraded PoolManagerLogic (no matching function selector),
    ///      turning every stake/unstake/harvest across the whole pool into an immediate,
    ///      unconditional revert the moment PoolLogic's upgrade lands, until PoolManagerLogic
    ///      happens to be upgraded too. A low-level staticcall with a fallback to the existing
    ///      totalFundValue() (treating the reading as complete, i.e. today's behavior) makes the
    ///      two upgrades order-independent — the same low-level-call-with-fallback pattern this
    ///      codebase already uses for cross-contract guard-marker detection
    ///      (isPreValuedAssetGuard(), isTxTrackingGuard(), isIncompleteValuationGuard()).
    function totalValueWithCompleteness(
        address poolManagerLogic
    ) external view returns (uint256 total, bool complete) {
        (bool ok, bytes memory data) = poolManagerLogic.staticcall(
            abi.encodeWithSignature("totalFundValueWithCompleteness()")
        );
        if (ok && data.length == 64) {
            return abi.decode(data, (uint256, bool));
        }
        return (IPoolManagerLogic(poolManagerLogic).totalFundValue(), true);
    }

    /// @dev Encapsulates both PoolLogic._accrueYield()'s totalValue-derived computation and
    ///      calculateAvailableManagerFee()'s advisory/display-only fee estimate — one shared
    ///      external function (same call-site shape at both use sites) rather than two, to keep
    ///      each call site's own bytecode footprint down.
    ///
    ///      Gated on `navComplete`: if the NAV reading is incomplete (see
    ///      IPoolManagerLogic.totalFundValueWithCompleteness()), every output degrades to a
    ///      no-op — zero fees, zero net yield, accountedAssets and lastFeeMintTime unchanged —
    ///      rather than recognizing performance/management fees or ratcheting accountedAssets up
    ///      against a total that may be silently understated by an asset guard's transient
    ///      valuation failure (a broken price feed, a reverting vault call, L2 sequencer
    ///      downtime — see IIncompleteValuationGuard). Understating totalValue would otherwise
    ///      make _accrueYield() recognize too little (or no) yield this call, then "catch up" in
    ///      one jump once the dependency recovers, distributing that catch-up pro-rata across
    ///      whatever share supply exists *at recovery time* — letting a staker who entered during
    ///      the outage capture yield that economically accrued before they joined, at the expense
    ///      of stakers who were already in. Deliberately does not revert: reverting here would
    ///      block stake/unstake/harvest for the entire pool over one guard's transient failure,
    ///      the exact freeze the fail-open guards were designed to avoid (see their own
    ///      documentation) — withholding *recognition* is enough to prevent the mis-distribution
    ///      without reintroducing that freeze. calculateAvailableManagerFee() always passes
    ///      navComplete=true — it doesn't mutate state, so there's nothing for an understated
    ///      reading to corrupt; it should just show what the fee would currently be.
    ///
    ///      `_applyClamp` toggles _accrueYield()'s "management fee capped at net yield" clamp,
    ///      which reflects how much of the management fee _accrueYield() actually mints in one
    ///      settlement — not the two fees' raw, independent sizes. calculateAvailableManagerFee()
    ///      passes false to preserve its original semantics (the uncapped sum of both).
    function computeYieldAccrual(
        uint256 _totalValue,
        bool _navComplete,
        uint256 _accountedAssets,
        uint256 _totalFusd,
        uint256 _lastFeeMintTime,
        uint256 _performanceFeeNumerator,
        uint256 _managementFeeNumerator,
        uint256 _feeDenominator,
        bool _applyClamp
    )
        external
        view
        returns (
            uint256 performanceFee,
            uint256 managementFee,
            uint256 netYield,
            uint256 newAccountedAssets,
            uint256 newLastFeeMintTime
        )
    {
        newAccountedAssets = _accountedAssets;
        newLastFeeMintTime = _lastFeeMintTime;

        if (!_navComplete) {
            return (0, 0, 0, newAccountedAssets, newLastFeeMintTime);
        }

        (performanceFee, netYield) = calculatePerformanceFee(
            _totalValue,
            _accountedAssets,
            _performanceFeeNumerator,
            _feeDenominator
        );

        (managementFee, newLastFeeMintTime) = calculateManagementFee(
            _totalFusd,
            _lastFeeMintTime,
            _managementFeeNumerator,
            _feeDenominator
        );

        if (_applyClamp) {
            if (managementFee > netYield) {
                managementFee = netYield;
            }
            netYield -= managementFee;
        }

        if (_totalValue > _accountedAssets) {
            newAccountedAssets = _totalValue;
        }
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
