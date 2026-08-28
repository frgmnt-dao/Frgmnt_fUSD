// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IPoolManagerLogic } from "../interfaces/IPoolManagerLogic.sol";
import { IHasSupportedAsset } from "../interfaces/IHasSupportedAsset.sol";
import { IPoolLogic } from "../interfaces/IPoolLogic.sol";
import { IAssetGuard } from "../interfaces/guards/IAssetGuard.sol";
import { IUnwindCostAwareGuard } from "../interfaces/guards/IUnwindCostAwareGuard.sol";
import { IWithdrawalEscrow } from "../interfaces/IWithdrawalEscrow.sol";

/**
 * @title FundCalculationLibrary
 * @dev Stateless utility library extracted from PoolLogic.
 */
library FundCalculationLibrary {
    using SafeERC20 for IERC20;

    error InvalidReservedBalance();
    error EscrowNotSet();

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
    /// @dev public (not external): also called directly, by-name, from
    ///      activeTotalValueWithCompleteness() below, within this same library — `external`
    ///      functions cannot be invoked internally by name, only via `this.foo()`, which for a
    ///      delegatecall-invoked library function would incorrectly resolve `this` to the
    ///      caller's (PoolLogic's) address rather than this library's own.
    function totalValueWithCompleteness(
        address poolManagerLogic
    ) public view returns (uint256 total, bool complete) {
        (bool ok, bytes memory data) = poolManagerLogic.staticcall(
            abi.encodeWithSignature("totalFundValueWithCompleteness()")
        );
        if (ok && data.length == 64) {
            return abi.decode(data, (uint256, bool));
        }
        return (IPoolManagerLogic(poolManagerLogic).totalFundValue(), true);
    }

    /// @notice FNA-17: reserved-value-excluding counterpart to totalValueWithCompleteness(),
    ///         used wherever fee/yield accrual must not treat liquidity already earmarked for a
    ///         finalized-but-unclaimed queued withdrawal (PoolLogic.reservedAssetBalance) as
    ///         part of the pool's active NAV.
    /// @dev A finalized queued withdrawal fixes `r.assetAmount` (a raw token amount) once, at
    ///      finalize time, and leaves it sitting in PoolLogic until claimed — any price movement
    ///      on that already-fixed amount between finalize and claim belongs to the withdrawing
    ///      user (who receives that exact token amount regardless of its price at claim time),
    ///      not to the remaining pool. `claimCashWithdraw()` runs accrual (via
    ///      `updateFeesAndRewards`) *before* releasing the reservation and transferring the
    ///      asset out, so accrual must already see the reserved leg as gone, or that price
    ///      movement gets misread as pool yield and inflates `accountedAssets` (and possibly
    ///      manager fees) against value that leaves the pool in the same transaction.
    ///
    ///      Deliberately builds on `totalValueWithCompleteness()`'s existing gross figure
    ///      (identical `total`/`complete` for a pool with no active reservations, since the
    ///      subtraction loop below then only touches assets with a nonzero
    ///      `reservedAssetBalance`) rather than independently re-summing every supported asset's
    ///      guard balance — the latter would silently diverge from whatever
    ///      `IPoolManagerLogic.totalFundValue()`'s real implementation actually returns (e.g. any
    ///      override or non-strictly-per-asset-guard computation), where this function must
    ///      match it exactly except for the reserved subtraction.
    function activeTotalValueWithCompleteness(
        address pool,
        address poolManagerLogic
    ) external view returns (uint256 total, bool complete) {
        (total, complete) = totalValueWithCompleteness(poolManagerLogic);

        IHasSupportedAsset.Asset[] memory assets = IHasSupportedAsset(poolManagerLogic)
            .getSupportedAssets();
        for (uint256 i = 0; i < assets.length; ++i) {
            address asset = assets[i].asset;
            uint256 reserved = IPoolLogic(pool).reservedAssetBalance(asset);
            if (reserved == 0) continue;

            uint256 reservedValue = IPoolManagerLogic(poolManagerLogic).assetValue(asset, reserved);
            total = total > reservedValue ? total - reservedValue : 0;
        }
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
    /// @dev FNA-07 follow-up (CertiK): the solvency haircut (_applyClaimsHaircut) is run against
    ///      a separately-derived, reserved-excluding NAV that is NOT capped by external liquidity
    ///      (see _withdrawableFundValue's capByLiquidity=false branch below) — not against
    ///      `withdrawableFundValue` itself. An earlier version of this function used the
    ///      liquidity-capped figure for both, so a single under-liquid lending position
    ///      (temporary, self-correcting) was indistinguishable from the pool actually being
    ///      underwater (permanent, requires loss socialization per FNA-05), and haircut every
    ///      immediate withdrawal for no solvency reason. Only the resulting fair share is then
    ///      capped to what's actually liquid right now, via `withdrawableFundValue`.
    /// @param withdrawableFundValue Liquidity-capped NAV (PoolLogic._withdrawableFundValue()) —
    ///        what can actually be paid out immediately, and the denominator `portion` is derived
    ///        against so that applying it to each asset's own liquidity-capped balance sums to
    ///        the returned fair share. Passed in rather than recomputed here since the caller
    ///        (PoolLogic._withdrawProRata) already needs it independently for its own EmptyFund
    ///        check and post-withdrawal accounting.
    /// @dev FNA-32: `_withdrawableFundValue()` below (unlike totalValueWithCompleteness()) returns
    ///      only a scalar — each per-asset guard that fails open to a balance of 0 (see FNA-04)
    ///      silently understates this function's NAV rather than signaling it. Sizing an
    ///      immediate withdrawal's payout, and specifically the solvency haircut, against that
    ///      understated figure could misread a fault-isolated position's transient valuation
    ///      failure as insolvency and haircut a genuinely solvent user's withdrawal for no real
    ///      reason. Unlike stake/unstake/harvest's yield *recognition* (which only defers, and
    ///      whose fail-open behavior is an intentional, accepted design tradeoff — see the
    ///      FNA-13 design note on _accrueYield()), a withdrawal's payout is computed and
    ///      delivered right now and can't be corrected retroactively once the failing guard
    ///      recovers — the same reasoning that makes checkpointFeesForDeposit() (FNA-04 follow-up)
    ///      fail closed on deposits applies here. Checked via the same totalValueWithCompleteness()
    ///      this function already effectively duplicates (see below), so this costs one extra call
    ///      rather than plumbing a completeness flag through _withdrawableFundValue()'s two
    ///      differently-capped call sites.
    function computeImmediateWithdrawPortion(
        address pool,
        uint256 netFusd,
        uint256 withdrawableFundValue
    ) external view returns (uint256 portion) {
        if (withdrawableFundValue == 0) return 0;
        address poolManagerLogic = IPoolLogic(pool).poolManagerLogic();
        (, bool navComplete) = totalValueWithCompleteness(poolManagerLogic);
        if (!navComplete) revert IPoolLogic.IncompleteNAV();
        uint256 completeFundValue = _withdrawableFundValue(pool, poolManagerLogic, false);
        uint256 totalClaims = _activeTotalClaims(pool) + netFusd;
        uint256 fairFusd = _applyClaimsHaircut(netFusd, completeFundValue, totalClaims);
        // The fair share can still exceed what's actually liquid right now (a temporary
        // liquidity gap, distinct from insolvency). netFusd has already been burned by the
        // caller before this runs, so under-delivering here instead of reverting would be an
        // unrecoverable user loss for what is, at worst, a self-correcting shortfall — return 0
        // (PoolLogic's existing WithdrawAmountTooSmall check reverts the whole, still-atomic
        // transaction, unwinding that burn) rather than silently paying out less than the fair
        // share.
        if (fairFusd > withdrawableFundValue) return 0;
        portion = (fairFusd * 1e18) / withdrawableFundValue;
    }

    /// @notice FNA-38: fUSD.totalSupply() plus the unharvested reward claim (FNA-34), minus
    ///         finalizedUnclaimedFusd — the shared "active claims" base both
    ///         computeImmediateWithdrawPortion() (which adds its own request's netFusd back on
    ///         top, since it was already burned by the time this runs) and
    ///         computeFinalizeAssetAmount() (used as-is: the request currently being finalized
    ///         hasn't been added to finalizedUnclaimedFusd yet, so it's still correctly counted
    ///         as active here) haircut a queued or immediate withdrawal against. See
    ///         finalizedUnclaimedFusd's own docs on PoolLogic for why it must be excluded.
    function _activeTotalClaims(address pool) private view returns (uint256) {
        uint256 claims = IERC20(IPoolLogic(pool).fusd()).totalSupply() +
            (IPoolLogic(pool).totalRewardAccrued() - IPoolLogic(pool).totalRewardHarvested());
        uint256 finalizedUnclaimed = IPoolLogic(pool).finalizedUnclaimedFusd();
        return claims > finalizedUnclaimed ? claims - finalizedUnclaimed : 0;
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
    /// @dev FNA-38: `totalClaims` excludes finalizedUnclaimedFusd (see _activeTotalClaims() and
    ///      finalizedUnclaimedFusd's own docs on PoolLogic) — any *other* request already
    ///      Finalized/FinalizedEscrowed but not yet Claimed has had its backing assets excluded
    ///      from `fundValue` via reservedAssetBalance/escrow since the moment it was finalized,
    ///      so its still-unburned FUSD must be excluded from the claims denominator the same way,
    ///      or it double-counts the same value and understates this (and every other still-
    ///      active) claim's fair share. An earlier version of this function left this asymmetry
    ///      unfixed here specifically, reasoning that computeImmediateWithdrawPortion() didn't
    ///      need the same fix since its extraction is re-multiplied by the AssetGuard's own
    ///      reservation-netted balance, "cancelling" the netting — that premise was wrong:
    ///      ERC20Guard.withdrawProcessing() nets by *subtracting* the reservation from balance,
    ///      not by using the raw balance, so no cancellation occurs and the same asymmetry hits
    ///      the immediate path too (fixed identically there — see its own docs).
    /// @param pool The PoolLogic address (for poolManagerLogic(), fusd(), and
    ///        reservedAssetBalance()).
    /// @param asset The asset this queued withdrawal will pay out in.
    /// @param grossFusd The FUSD amount (net of fees) this withdrawal is nominally sized against.
    /// @dev FNA-32: reverts IncompleteNAV rather than sizing (and then permanently fixing, in
    ///      r.assetAmount) this request's payout against an understated NAV — see the identical
    ///      reasoning on computeImmediateWithdrawPortion above. This is a materially bigger risk
    ///      here than for immediate withdrawal: a queued request's assetAmount is fixed once at
    ///      finalize and is never recalculated even after the failing guard recovers.
    function computeFinalizeAssetAmount(
        address pool,
        address asset,
        uint256 grossFusd
    ) external view returns (uint256 assetAmount) {
        address poolManagerLogic = IPoolLogic(pool).poolManagerLogic();
        (, bool navComplete) = totalValueWithCompleteness(poolManagerLogic);
        if (!navComplete) revert IPoolLogic.IncompleteNAV();
        uint256 effectiveFusd = _applyClaimsHaircut(
            grossFusd,
            _withdrawableFundValue(pool, poolManagerLogic, false),
            _activeTotalClaims(pool)
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

    /// @dev FNA-07: NAV for PoolLogic's *immediate* withdrawal path, capped per-asset by whatever
    ///      external liquidity a guard reports via IWithdrawableBalanceGuard (see that interface)
    ///      instead of its full claim — so one under-liquid lending position sizes its own share
    ///      down to what it can actually deliver, rather than the whole withdrawal reverting when
    ///      that position's guard call is later asked to redeem more than is available. Guards
    ///      that don't implement the marker are assumed fully liquid, identical to
    ///      computeFinalizeAssetAmount's NAV above (which intentionally does NOT apply this cap —
    ///      the queued finalize path doesn't redeem anything at finalize time, so there is no
    ///      liquidity constraint to reflect there; see IWithdrawableBalanceGuard).
    function computeWithdrawableFundValue(
        address pool,
        address poolManagerLogic
    ) external view returns (uint256) {
        return _withdrawableFundValue(pool, poolManagerLogic, true);
    }

    function _withdrawableFundValue(
        address pool,
        address poolManagerLogic,
        bool capByLiquidity
    ) private view returns (uint256 value) {
        IHasSupportedAsset.Asset[] memory assets = IHasSupportedAsset(poolManagerLogic)
            .getSupportedAssets();

        for (uint256 i = 0; i < assets.length; ++i) {
            address asset = assets[i].asset;
            address guard = IPoolManagerLogic(poolManagerLogic).getAssetGuard(asset);
            uint256 withdrawableBalance = capByLiquidity
                ? _guardWithdrawableBalance(pool, asset, guard)
                : guardNetRealizableBalance(pool, asset, guard);
            uint256 reserved = IPoolLogic(pool).reservedAssetBalance(asset);
            if (reserved > 0) {
                if (withdrawableBalance < reserved) revert InvalidReservedBalance();
                withdrawableBalance -= reserved;
            }
            value += IPoolManagerLogic(poolManagerLogic).assetValue(asset, withdrawableBalance);
        }
    }

    /// @notice FNA-35/FNA-36: checks the IUnwindCostAwareGuard marker via the same low-level-call
    ///      pattern already used elsewhere in this codebase (isPreValuedAssetGuard(),
    ///      isWithdrawableBalanceGuard()) — a guard without the marker is assumed to already
    ///      report net-realizable value from getBalance() (today's behavior, unaffected). Unlike
    ///      _guardWithdrawableBalance()'s liquidity cap, a marked guard's actual call here is not
    ///      wrapped in a further try/degrade: it's a plain valuation read, exactly as
    ///      unconditional as getBalance() itself already is.
    /// @dev public (not external, not private): also called directly by name from
    ///      _withdrawableFundValue() below within this same library (see
    ///      totalValueWithCompleteness()'s own doc comment for why `external` cannot be invoked
    ///      internally by name here), and separately called by PoolLogic._withdrawProcessing()
    ///      (FNA-36) to size a single asset's own portion against net-realizable rather than
    ///      gross balance, so a leveraged position whose gross equity looks positive but whose
    ///      net realizable value is fully consumed by unwind costs is skipped the same way a
    ///      genuinely zero-equity one already is — not just excluded from NAV sizing.
    function guardNetRealizableBalance(
        address pool,
        address asset,
        address guard
    ) public view returns (uint256) {
        (bool hasMarker, bytes memory markerData) = guard.staticcall(
            abi.encodeWithSignature("isUnwindCostAwareGuard()")
        );
        if (hasMarker && markerData.length == 32 && abi.decode(markerData, (bool))) {
            return IUnwindCostAwareGuard(guard).getNetRealizableBalance(pool, asset);
        }
        return IAssetGuard(guard).getBalance(pool, asset);
    }

    /// @dev Checks the IWithdrawableBalanceGuard marker via the same low-level-call-with-fallback
    ///      pattern already used elsewhere in this codebase (isPreValuedAssetGuard(),
    ///      isIncompleteValuationGuard()) — a guard without the marker, or whose marked call
    ///      itself unexpectedly fails, falls back to getBalance() and 0 respectively; see
    ///      IWithdrawableBalanceGuard for why a failed marked call degrades to 0 (conservative)
    ///      rather than the full getBalance() value.
    function _guardWithdrawableBalance(
        address pool,
        address asset,
        address guard
    ) private view returns (uint256) {
        (bool hasMarker, bytes memory markerData) = guard.staticcall(
            abi.encodeWithSignature("isWithdrawableBalanceGuard()")
        );
        if (hasMarker && markerData.length == 32 && abi.decode(markerData, (bool))) {
            (bool ok, bytes memory data) = guard.staticcall(
                abi.encodeWithSignature("getWithdrawableBalance(address,address)", pool, asset)
            );
            if (ok && data.length == 32) {
                return abi.decode(data, (uint256));
            }
            return 0;
        }
        return IAssetGuard(guard).getBalance(pool, asset);
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

    /// @notice FNA-03: releases a finalized queued withdrawal to its claimant, from whichever
    ///         of the two places it actually lives. `escrowed` is true for any request
    ///         finalized after WithdrawalEscrow was wired in (the normal case going forward);
    ///         false only for a request finalized before that (still part of the pool's own
    ///         balance under the pre-FNA-03 reservedAssetBalance-only bookkeeping) — see
    ///         PoolLogic's own RequestStatus.FinalizedEscrowed and claimCashWithdraw()'s docs.
    /// @dev Called via delegatecall from claimCashWithdraw(), so address(this) and msg.sender
    ///      here are already the pool and the claimant respectively — passing them as separate
    ///      parameters would be redundant; PoolLogic has essentially no bytecode headroom left
    ///      (see FNA-03/FNA-04 history) so every parameter here has a real size cost. The
    ///      escrowed branch calls into `escrow`, which for the same delegatecall reason sees
    ///      msg.sender == the pool, matching WithdrawalEscrow's onlyPool access control exactly
    ///      as if PoolLogic had called it directly. The non-escrowed (legacy) branch measures
    ///      what actually left the pool's own balance rather than trusting the nominal
    ///      `amount` (FNA-23 follow-up): a sender-fee/burn-on-transfer asset can drain more
    ///      than `amount`, and decrementing reservedAssetBalance by only the nominal amount
    ///      would leave it overstated relative to the real on-chain balance.
    function claimCashWithdrawRelease(
        address escrow,
        bool escrowed,
        address asset,
        uint256 amount,
        uint256 reserved
    ) external returns (uint256 newReserved, uint256 delivered) {
        if (escrowed) {
            delivered = IWithdrawalEscrow(escrow).release(asset, amount, msg.sender);
            return (reserved, delivered);
        }

        uint256 poolBalanceBefore = IERC20(asset).balanceOf(address(this));
        uint256 recipientBalanceBefore = IERC20(asset).balanceOf(msg.sender);

        IERC20(asset).safeTransfer(msg.sender, amount);

        uint256 actualOutflow = poolBalanceBefore - IERC20(asset).balanceOf(address(this));
        delivered = IERC20(asset).balanceOf(msg.sender) - recipientBalanceBefore;

        newReserved = reserved > actualOutflow ? reserved - actualOutflow : 0;
    }

    /// @notice FNA-03/FNA-26: does finalizeCashWithdraw()'s entire escrow-move-and-baseline
    ///         step in one library call — physically moves `assetAmount` of `asset` into
    ///         `escrow` and returns the correctly-adjusted accountedAssets — to minimize this
    ///         call site's own bytecode footprint in PoolLogic, which has essentially no
    ///         headroom left (see FNA-03/FNA-04 history).
    /// @dev Moving `assetAmount` out of the pool's own balance immediately removes that much
    ///      value from active NAV — the same NAV _accrueYield() compares accountedAssets
    ///      against — so that value is subtracted from accountedAssets now, exactly as
    ///      finalizeCashWithdraw() always has (see its own docs for why deferring this to
    ///      claimCashWithdraw() was wrong). Priced directly via assetValue(asset, assetAmount)
    ///      rather than by diffing activeTotalValueWithCompleteness() before/after the move:
    ///      that function's own reservation-netting only reacts to reservedAssetBalance (see its
    ///      docs), which an escrowed reservation deliberately never touches, and a
    ///      poolManagerLogic's totalFundValue is not guaranteed to be freshly re-derived from
    ///      this exact balance change either — pricing the known, fixed `assetAmount` directly
    ///      is both simpler and exact, mirroring how activeTotalValueWithCompleteness() itself
    ///      prices a legacy (non-escrowed) reservedAssetBalance amount. Reverts if the escrow
    ///      hasn't been wired yet, rather than silently no-op'ing through a call to an unset
    ///      address and recording a claim nothing actually backs.
    function finalizeReserveAndUpdateBaseline(
        address poolManagerLogic,
        address escrow,
        address asset,
        uint256 assetAmount,
        uint256 accountedAssetsBefore
    ) external returns (uint256 newAccountedAssets) {
        if (escrow == address(0)) revert EscrowNotSet();

        uint256 valueDelta = IPoolManagerLogic(poolManagerLogic).assetValue(asset, assetAmount);

        IERC20(asset).forceApprove(escrow, assetAmount);
        IWithdrawalEscrow(escrow).reserve(asset, assetAmount);

        newAccountedAssets = accountedAssetsBefore > valueDelta ? accountedAssetsBefore - valueDelta : 0;
    }
}
