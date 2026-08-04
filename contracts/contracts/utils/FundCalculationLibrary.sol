// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IPoolManagerLogic } from "../interfaces/IPoolManagerLogic.sol";
import { IHasSupportedAsset } from "../interfaces/IHasSupportedAsset.sol";
import { IPoolLogic } from "../interfaces/IPoolLogic.sol";
import { IAssetGuard } from "../interfaces/guards/IAssetGuard.sol";

/**
 * @title FundCalculationLibrary
 * @dev Stateless utility library extracted from PoolLogic.
 */
library FundCalculationLibrary {
    error InvalidReservedBalance();

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
    // =            LOSS SOCIALIZATION (FNA-05)                     =
    // ============================================================

    /// @dev Scales `grossFusd` down by the pool's collateralization ratio
    ///      (fundValue / totalClaims), capped so an over-collateralized pool never scales UP —
    ///      a withdrawer must never receive more than their `grossFusd` claim is worth, even if
    ///      live NAV has temporarily outrun recognized claims (e.g. unrecognized yield between
    ///      accrual calls). Returns `grossFusd` unchanged whenever `fundValue >= totalClaims`,
    ///      i.e. no behavioral change during normal, solvent operation.
    ///
    ///      Both PoolLogic._withdrawProRata (immediate withdrawal) and
    ///      PoolLogic.finalizeCashWithdraw (queued withdrawal) previously sized a redemption as
    ///      `grossFusd`'s value at today's prices, regardless of whether the pool actually held
    ///      enough collateral to back *every* outstanding fUSD claim, not just this one. That let
    ///      an early redeemer exit at par against a shortfall while later holders absorbed a
    ///      larger deficit — see FNA-05. Using `totalClaims` (outstanding fUSD, i.e.
    ///      `IERC20(fusd).totalSupply()`) as a second, floor-forming denominator makes every
    ///      redemption bear the same deficit ratio instead of racing to exit first.
    /// @param grossFusd The FUSD amount this redemption is nominally sized against (net of fees).
    /// @param fundValue Live, mark-to-market withdrawable NAV.
    /// @param totalClaims Outstanding fUSD claims this redemption's grossFusd is drawn from.
    function applyClaimsHaircut(
        uint256 grossFusd,
        uint256 fundValue,
        uint256 totalClaims
    ) external pure returns (uint256) {
        return _applyClaimsHaircut(grossFusd, fundValue, totalClaims);
    }

    /// @dev Combines the outstanding-claims lookup, the claims haircut, and the portion
    ///      derivation into a single external call for PoolLogic._withdrawProRata() — see
    ///      computeFinalizeAssetAmount's docs above for why this call site needs one library call
    ///      rather than sequencing several, and why `pool` is taken here instead of the fUSD
    ///      token address directly (cheaper for the caller to pass than a storage read, and the
    ///      fUSD address is then looked up via IPoolLogic.fusd()). `netFusd` has already been
    ///      burned from fUSD's totalSupply() by the caller before this runs, so it's added back
    ///      to recover outstanding claims as they stood immediately before this withdrawal.
    function computeImmediateWithdrawPortion(
        address pool,
        uint256 netFusd,
        uint256 fundValue
    ) external view returns (uint256 portion) {
        if (fundValue == 0) return 0;
        uint256 totalClaims = IERC20(IPoolLogic(pool).fusd()).totalSupply() + netFusd;
        uint256 effectiveFusd = _applyClaimsHaircut(netFusd, fundValue, totalClaims);
        portion = (effectiveFusd * 1e18) / fundValue;
    }

    function _applyClaimsHaircut(
        uint256 grossFusd,
        uint256 fundValue,
        uint256 totalClaims
    ) private pure returns (uint256) {
        uint256 denom = fundValue > totalClaims ? fundValue : totalClaims;
        if (denom == 0) return 0;
        return (grossFusd * fundValue) / denom;
    }

    /// @dev Combines withdrawable-NAV computation, the claims haircut, and the FUSD→asset price
    ///      conversion into a single external call for PoolLogic.finalizeCashWithdraw() —
    ///      PoolLogic.sol has essentially no bytecode headroom left (see FNA-03/FNA-04 history),
    ///      so this call site needs one library call rather than sequencing several, and both
    ///      poolManagerLogic and the fUSD token address are looked up from `pool` here rather
    ///      than also being passed in, to keep that call site's argument count (and the storage
    ///      reads it would otherwise need) down. The NAV computation mirrors PoolLogic's own
    ///      _withdrawableFundValue(), reading reservedAssetBalance via IPoolLogic's public getter
    ///      instead of direct storage access; the price conversion mirrors fusdToAssetAmount()
    ///      above.
    /// @dev KNOWN LIMITATION (tracked, not fixed — see FNA-05 follow-up): `totalClaims` here is
    ///      IERC20(fusd).totalSupply(), which still includes the FUSD locked by any *other*
    ///      request that has already been finalized but not yet claimed, even though that
    ///      request's backing assets are already excluded from `fundValue` via
    ///      reservedAssetBalance. That asymmetry under-pays later finalizers relative to their
    ///      true pro-rata share for as long as earlier reservations sit unclaimed — e.g. two equal
    ///      100-FUSD claims against a 100-value pool: the first finalizer correctly gets 50, but a
    ///      second finalize before the first is claimed gets only 25 instead of its true 50 share.
    ///      This is conservative (it can only under-pay, never over-pay, so it cannot reintroduce
    ///      FNA-05's first-redeemer bank-run), and self-corrects once outstanding reservations are
    ///      claimed. Note this does NOT apply to computeImmediateWithdrawPortion: its extraction is
    ///      re-multiplied by the *raw* (non-reservation-netted) asset balance inside the AssetGuard,
    ///      which cancels the netting and yields the true pro-rata share directly — do not "fix"
    ///      that path the same way, or it will start over-paying.
    /// @param pool The PoolLogic address (for poolManagerLogic(), fusd(), and
    ///        reservedAssetBalance()).
    /// @param asset The asset this queued withdrawal will pay out in.
    /// @param grossFusd The FUSD amount (net of fees) this withdrawal is nominally sized against.
    function computeFinalizeAssetAmount(
        address pool,
        address asset,
        uint256 grossFusd
    ) external view returns (uint256 assetAmount) {
        address poolManagerLogic = IPoolLogic(pool).poolManagerLogic();
        uint256 effectiveFusd = _applyClaimsHaircut(
            grossFusd,
            _withdrawableFundValue(pool, poolManagerLogic),
            IERC20(IPoolLogic(pool).fusd()).totalSupply()
        );
        if (effectiveFusd == 0) return 0;

        if (!IHasSupportedAsset(poolManagerLogic).isSupportedAsset(asset)) return 0;

        uint256 price = IPoolManagerLogic(poolManagerLogic).getAssetPrice(asset);
        if (price == 0) return 0;

        uint256 decimals = IPoolManagerLogic(poolManagerLogic).assetDecimal(asset);
        uint256 assetAmount18 = (effectiveFusd * 1e18) / price;

        if (decimals == 18) {
            assetAmount = assetAmount18;
        } else if (decimals < 18) {
            assetAmount = assetAmount18 / (10 ** (18 - decimals));
        } else {
            assetAmount = assetAmount18 * (10 ** (decimals - 18));
        }
    }

    function _withdrawableFundValue(
        address pool,
        address poolManagerLogic
    ) private view returns (uint256 value) {
        IHasSupportedAsset.Asset[] memory assets = IHasSupportedAsset(poolManagerLogic)
            .getSupportedAssets();

        for (uint256 i = 0; i < assets.length; ++i) {
            address asset = assets[i].asset;
            address guard = IPoolManagerLogic(poolManagerLogic).getAssetGuard(asset);
            uint256 withdrawableBalance = IAssetGuard(guard).getBalance(pool, asset);
            uint256 reserved = IPoolLogic(pool).reservedAssetBalance(asset);
            if (reserved > 0) {
                if (withdrawableBalance < reserved) revert InvalidReservedBalance();
                withdrawableBalance -= reserved;
            }
            value += IPoolManagerLogic(poolManagerLogic).assetValue(asset, withdrawableBalance);
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
