// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////
                            IMPORTS
//////////////////////////////////////////////////////////////*/

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { ISpoke } from "../../interfaces/aave/v4/ISpoke.sol";
import { ITakerPositionManager } from "../../interfaces/aave/v4/ITakerPositionManager.sol";
import { IAaveV4SpokeManager } from "../../interfaces/IAaveV4SpokeManager.sol";
import { IPoolManagerLogic } from "../../interfaces/IPoolManagerLogic.sol";
import { IPoolLogic } from "../../interfaces/IPoolLogic.sol";
import { IHasSupportedAsset } from "../../interfaces/IHasSupportedAsset.sol";
import { IAddAssetCheckGuard } from "../../interfaces/guards/IAddAssetCheckGuard.sol";
import { IPreValuedAssetGuard } from "../../interfaces/guards/IPreValuedAssetGuard.sol";
import { IIncompleteValuationGuard } from "../../interfaces/guards/IIncompleteValuationGuard.sol";
import { ClosedAssetGuard } from "./ClosedAssetGuard.sol";

/*//////////////////////////////////////////////////////////////
                  AAVE V4 SPOKE ASSET GUARD
//////////////////////////////////////////////////////////////*/

/// @title Aave V4 Spoke Asset Guard
/// @notice AssetGuard for a pool's supply-only position across one or more reserves of a single
///         Aave V4 Spoke. The registered "supported asset" is the Spoke address itself — one
///         guard instance services any number of Spokes, with the AaveV4SpokeManager allowlist
///         (not this contract) deciding which reserveIds within each Spoke a pool may use.
/// @dev
///  - The pool's position carries no debt by design (see AaveV4SpokeContractGuard — borrowing
///    selectors are simply not handled there), so there is no flashloan-based unwind path and no
///    health factor to protect.
///  - A Spoke can host reserves with *different* underlying tokens under one registered asset.
///    `withdrawProcessing` therefore cannot rely on PoolLogic's single-`withdrawAsset` balance
///    tracking the way Morpho Vault V2's guard does — instead it mirrors
///    AaveLendingPoolAssetGuard's no-debt withdrawal pattern: each reserve's withdrawal includes
///    its own direct `transfer(to, amount)`, and the guard returns `withdrawAsset = address(0)`
///    to signal that funds have already been delivered and PoolLogic should not track/forward
///    anything itself.
///  - `getBalance` resolves each reserve's underlying token via a raw `staticcall` reading only
///    the first 32-byte word of `ISpoke.getReserve(uint256)`'s return data, rather than decoding
///    the full `Reserve` struct. The struct's later fields (in particular a `flags` field of
///    uncertain encoded shape) could not be confirmed against a live deployed ABI at design
///    time, and a wrong struct layout would silently return incorrect data rather than revert —
///    `underlying` is confirmed to be the struct's first field, so reading only that word is
///    correct regardless of how the rest of the struct is actually laid out.
///  - Every external call into the Spoke in `getBalance` is fault-isolated per reserve (skip and
///    continue, not revert-the-whole-function) — unlike Morpho Vault V2 (a single position per
///    guard call), a Spoke aggregates multiple reserves, so one bad reserve must not zero out
///    the valuation of the others.
contract AaveV4SpokeAssetGuard is
    ClosedAssetGuard,
    IAddAssetCheckGuard,
    IPreValuedAssetGuard,
    IIncompleteValuationGuard
{
    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error ManagerZero();
    error TakerPositionManagerZero();
    error BadPortion();
    error InvalidRecipient();
    error InvalidUnderlying();
    error SpokeNotWhitelisted();

    /*//////////////////////////////////////////////////////////////
                              CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @dev Raw-unit dust tolerance for `removeAssetCheck`. `_appendReserveWithdrawTxs` computes
    ///      a full withdrawal's `amount` from a live-read `ISpoke.getUserSuppliedAssets` snapshot
    ///      rather than a `type(uint256).max` sentinel (Aave V4's `withdrawOnBehalfOf` does not
    ///      document supporting one, unlike `approveWithdraw`'s allowance — see
    ///      ITakerPositionManager), because this guard forwards a fixed, pre-computed amount via
    ///      a direct `transfer(to, amount)` rather than a balance-delta measurement (multiple
    ///      reserves can share one Spoke with *different* underlyings, so PoolLogic's single-
    ///      `withdrawAsset` delta tracking doesn't apply here — see the contract-level
    ///      documentation above). If Aave V4's internal share<->asset rounding ever leaves a tiny
    ///      residual behind after withdrawing that exact snapshotted amount, a strict
    ///      `suppliedAssets == 0` check would block removeAssetCheck() indefinitely, since it
    ///      re-reads live state and would keep reporting that same tiny nonzero value forever —
    ///      bricking the only recovery path over an amount with no realistic economic
    ///      significance. Expressed in raw token units rather than USD-18 (unlike this guard's
    ///      previous dust tolerance) because removeAssetCheck below deliberately avoids
    ///      price/decimals lookups, so a per-reserve tolerance can't be priced without
    ///      reintroducing the exact failure mode being removed. 100 raw units comfortably covers
    ///      realistic share<->asset rounding (typically a handful of wei) while staying small in
    ///      USD terms even for a low-decimal, high-value reserve — e.g. 100 units of an
    ///      8-decimal, $100k-valued reserve is $0.10, versus $0.0001 for a 6-decimal stablecoin
    ///      at the same raw tolerance. Not perfectly uniform across decimals the way the previous
    ///      USD-18 tolerance was, but bounded and small regardless.
    uint256 private constant RAW_DUST_TOLERANCE = 100;

    /*//////////////////////////////////////////////////////////////
                                STRUCTS
    //////////////////////////////////////////////////////////////*/

    /// @dev Bundles withdrawProcessing's fixed parameters to keep the per-reserve helper's
    ///      argument count low enough to avoid a stack-too-deep compile error.
    struct WithdrawCtx {
        address pool;
        address spoke;
        address to;
        uint256 withdrawPortion;
    }

    /*//////////////////////////////////////////////////////////////
                              IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice Protocol-owned allowlist of Aave V4 Spoke reserves permitted per pool.
    address public immutable aaveV4SpokeManager;

    /// @notice Aave V4's singleton TakerPositionManager, used to encode withdrawal transactions.
    address public immutable takerPositionManager;

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(address aaveV4SpokeManager_, address takerPositionManager_) {
        if (aaveV4SpokeManager_ == address(0)) revert ManagerZero();
        if (takerPositionManager_ == address(0)) revert TakerPositionManagerZero();
        aaveV4SpokeManager = aaveV4SpokeManager_;
        takerPositionManager = takerPositionManager_;
    }

    /*//////////////////////////////////////////////////////////////
                      ADD-ASSET REGISTRATION CHECK
    //////////////////////////////////////////////////////////////*/

    /// @notice Required by IAddAssetCheckGuard — signals that PoolManagerLogic._addAsset must
    ///         call `addAssetCheck` before registering an asset of this type.
    function isAddAssetCheckGuard() external pure returns (bool) {
        return true;
    }

    /// @notice Validates a candidate Spoke before it can be registered as a supported asset.
    /// @dev Requires the protocol owner to have already whitelisted at least one reserveId for
    ///      this (pool, spoke) pair in AaveV4SpokeManager — this is the actual enforcement point
    ///      that makes the whitelist meaningful; without it, a pool manager could register any
    ///      address as a "Spoke" on their own authority via changeAssets().
    /// @param poolLogic Address of the pool the asset is being added to.
    /// @param asset Candidate asset being registered; `asset.asset` is the Spoke address.
    function addAssetCheck(
        address poolLogic,
        IHasSupportedAsset.Asset calldata asset
    ) external view override {
        address spoke = asset.asset;
        if (IAaveV4SpokeManager(aaveV4SpokeManager).getPoolReservesLength(poolLogic, spoke) == 0) {
            revert SpokeNotWhitelisted();
        }
    }

    /*//////////////////////////////////////////////////////////////
                            BALANCE LOGIC
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns the pool's USD-denominated value of its supplied position across every
    ///         reserveId allowlisted for this (pool, spoke) pair.
    /// @param pool Pool holding the position.
    /// @param spoke Address of the Aave V4 Spoke.
    /// @return balanceUsd18 USD value of the pool's aggregate supplied position, 18 decimals.
    function getBalance(
        address pool,
        address spoke
    ) public view override returns (uint256 balanceUsd18) {
        (balanceUsd18, ) = _valuePosition(pool, spoke);
    }

    /// @dev Shared by getBalance() and isValuationComplete() below, so the two can never
    ///      disagree about which failure paths count as "incomplete". Sums _reserveValueUsd()
    ///      across every allowlisted reserve; `complete` is true only if every reserve valued
    ///      successfully (a reserve with suppliedAssets == 0 counts as successfully valued, not
    ///      incomplete — see _reserveValueUsd()).
    function _valuePosition(
        address pool,
        address spoke
    ) internal view returns (uint256 balanceUsd18, bool complete) {
        address poolManagerLogic = IPoolLogic(pool).poolManagerLogic();
        uint256[] memory reserveIds = IAaveV4SpokeManager(aaveV4SpokeManager).getPoolReserves(
            pool,
            spoke
        );

        complete = true;
        for (uint256 i = 0; i < reserveIds.length; ++i) {
            (uint256 value, bool reserveComplete) = _reserveValueUsd(
                pool,
                spoke,
                poolManagerLogic,
                reserveIds[i]
            );
            balanceUsd18 += value;
            if (!reserveComplete) complete = false;
        }
    }

    /// @dev Fault-isolated valuation of a single reserve. Any failure (Spoke call reverts,
    ///      underlying unresolved, underlying unpriced or unguarded) contributes 0 and reports
    ///      `complete = false`, rather than reverting the whole getBalance() call — see the
    ///      contract-level documentation above.
    function _reserveValueUsd(
        address pool,
        address spoke,
        address poolManagerLogic,
        uint256 reserveId
    ) internal view returns (uint256, bool) {
        uint256 suppliedAssets;
        try ISpoke(spoke).getUserSuppliedAssets(reserveId, pool) returns (uint256 a) {
            suppliedAssets = a;
        } catch {
            return (0, false);
        }
        if (suppliedAssets == 0) return (0, true);

        (address underlying, bool ok) = _getReserveUnderlying(spoke, reserveId);
        if (!ok || underlying == address(0)) return (0, false);

        (bool priced, uint256 price, uint256 decimals) = _tryPriceAndDecimals(
            poolManagerLogic,
            underlying
        );
        if (!priced) return (0, false);

        return ((suppliedAssets * price) / (10 ** decimals), true);
    }

    /// @dev Shared by _reserveValueUsd (getBalance's per-reserve valuation) and
    ///      _reservePriceAvailable below (used by _appendReserveWithdrawTxs, which must skip
    ///      rather than withdraw a reserve it cannot value). Fault-isolated: any failure or a
    ///      zero price is reported as `!ok` rather than reverting.
    function _tryPriceAndDecimals(
        address poolManagerLogic,
        address underlying
    ) internal view returns (bool ok, uint256 price, uint256 decimals) {
        try IPoolManagerLogic(poolManagerLogic).getAssetPrice(underlying) returns (uint256 p) {
            price = p;
        } catch {
            return (false, 0, 0);
        }
        if (price == 0) return (false, 0, 0);

        try IPoolManagerLogic(poolManagerLogic).assetDecimal(underlying) returns (uint256 d) {
            decimals = d;
        } catch {
            return (false, 0, 0);
        }
        ok = true;
    }

    /// @dev Thin wrapper around _tryPriceAndDecimals for _appendReserveWithdrawTxs, which only
    ///      needs to know whether this reserve can currently be valued, not the price/decimals
    ///      themselves — kept as a separate function (rather than inlined) to keep that already
    ///      variable-heavy function's stack shallow enough to compile.
    function _reservePriceAvailable(address pool, address underlying) internal view returns (bool) {
        address poolManagerLogic = IPoolLogic(pool).poolManagerLogic();
        (bool priced, , ) = _tryPriceAndDecimals(poolManagerLogic, underlying);
        return priced;
    }

    /// @notice AssetGuard balances are always expressed in USD (18 decimals).
    /// @dev Paired in AssetHandler with the fixed $1.00 USDPriceAggregator for this asset's
    ///      registered price feed, so PoolManagerLogic.assetValue() resolves to exactly
    ///      `getBalance()` (price=1e18, decimals=18).
    function getDecimals(address) external pure override returns (uint256) {
        return 18;
    }

    /// @notice getBalance() already returns a fully priced base-currency value; see
    ///         IPreValuedAssetGuard and PoolManagerLogic.assetValue().
    function isPreValuedAssetGuard() external pure override returns (bool) {
        return true;
    }

    /// @notice See IIncompleteValuationGuard.
    function isIncompleteValuationGuard() external pure override returns (bool) {
        return true;
    }

    /// @notice See IIncompleteValuationGuard.
    function isValuationComplete(address pool, address spoke) external view override returns (bool complete) {
        (, complete) = _valuePosition(pool, spoke);
    }

    /// @notice Allows removal once every allowlisted reserve is closed to within
    ///         RAW_DUST_TOLERANCE raw units, rather than requiring an exact zero balance.
    /// @dev Deliberately checks each reserve's raw `getUserSuppliedAssets` directly, without
    ///      try/catch, rather than the USD-valued getBalance() the inherited
    ///      ClosedAssetGuard.removeAssetCheck() (and this guard's own previous implementation)
    ///      used. getBalance() / _reserveValueUsd() degrade a reserve to 0 on a transient Spoke
    ///      or pricing failure (see their documentation above) so that stake/unstake/harvest keep working for
    ///      the rest of the pool — but that same fail-open behavior would let removeAssetCheck()
    ///      treat a live, nonzero reserve as empty and permit removing the Spoke from
    ///      supportedAssets, orphaning that reserve (excluded from NAV, unreachable by
    ///      withdrawals) until manually re-added. Reading the raw supplied amount directly has no
    ///      such failure mode: either it succeeds and is trustworthy, or it reverts and blocks
    ///      removal — the correct, conservative outcome when emptiness can't be proven. See
    ///      RAW_DUST_TOLERANCE for why the tolerance itself is in raw units rather than USD.
    function removeAssetCheck(address pool, address spoke) public view override {
        uint256[] memory reserveIds = IAaveV4SpokeManager(aaveV4SpokeManager).getPoolReserves(
            pool,
            spoke
        );
        for (uint256 i = 0; i < reserveIds.length; ++i) {
            uint256 suppliedAssets = ISpoke(spoke).getUserSuppliedAssets(reserveIds[i], pool);
            require(suppliedAssets <= RAW_DUST_TOLERANCE, "ClosedAssetGuard: non-empty asset");
        }
    }

    /*//////////////////////////////////////////////////////////////
                      WITHDRAW PROCESSING
    //////////////////////////////////////////////////////////////*/

    /// @notice Builds the pro-rata withdrawal transactions across every allowlisted reserveId.
    /// @dev Per reserve: approve-self-as-withdraw-spender, withdraw (lands at the pool, since
    ///      Aave V4 sends withdrawn funds to msg.sender regardless of `onBehalfOf`), then a
    ///      direct transfer to `to` — see contract-level @dev for why this differs from the
    ///      single-`withdrawAsset` pattern used by Morpho Vault V2's guard. Returns
    ///      `withdrawAsset = address(0)` so PoolLogic does not attempt to track or forward
    ///      anything itself.
    ///
    ///      This only calls `withdrawOnBehalfOf` — it does not fall back to any alternate
    ///      liquidity source if a reserve's withdrawal would revert (e.g. the Spoke/Hub being
    ///      short on liquidity). If that happens, the withdrawal reverts; this is the same risk
    ///      class as an Aave V3/Morpho Blue market being fully utilized today.
    /// @param pool Pool address.
    /// @param spoke Address of the Aave V4 Spoke.
    /// @param withdrawPortion Portion to withdraw, 1e18 = 100%.
    /// @param to Recipient of the withdrawn underlying assets.
    function withdrawProcessing(
        address pool,
        address spoke,
        uint256 withdrawPortion,
        address to
    )
        external
        view
        override
        returns (address withdrawAsset, uint256 withdrawAmount, MultiTransaction[] memory txs)
    {
        if (withdrawPortion > 1e18) revert BadPortion();
        if (to == address(0)) revert InvalidRecipient();

        uint256[] memory reserveIds = IAaveV4SpokeManager(aaveV4SpokeManager).getPoolReserves(
            pool,
            spoke
        );

        txs = new MultiTransaction[](reserveIds.length * 3);
        uint256 n;
        WithdrawCtx memory ctx = WithdrawCtx({
            pool: pool,
            spoke: spoke,
            to: to,
            withdrawPortion: withdrawPortion
        });

        for (uint256 i = 0; i < reserveIds.length; ++i) {
            n = _appendReserveWithdrawTxs(ctx, reserveIds[i], txs, n);
        }

        assembly {
            mstore(txs, n)
        }

        withdrawAsset = address(0);
        withdrawAmount = 0;
    }

    /// @dev Appends the (approveWithdraw, withdrawOnBehalfOf, transfer) trio for one reserve to
    ///      `txs` starting at index `n`, if the pool holds a nonzero withdrawable amount there.
    ///      Returns the updated `n`.
    ///
    ///      `withdrawPortion` is sized by the caller against `_withdrawableFundValue()`, which
    ///      sums `_reserveValueUsd()` across reserves and — by design — contributes 0 for a
    ///      reserve it cannot price. If this function withdrew such a reserve's full raw supplied
    ///      amount at that same portion anyway, a caller could redeem a portion sized against a
    ///      NAV that excluded the reserve while still receiving it, extracting more value than
    ///      the fUSD burned pays for. So a reserve that _reserveValueUsd() cannot price here is
    ///      skipped rather than withdrawn, exactly mirroring its 0 contribution to the NAV the
    ///      portion was computed from — it stays reserved for its pre-failure holders until
    ///      pricing recovers, rather than being extractable by whoever withdraws next.
    function _appendReserveWithdrawTxs(
        WithdrawCtx memory ctx,
        uint256 reserveId,
        MultiTransaction[] memory txs,
        uint256 n
    ) internal view returns (uint256) {
        uint256 suppliedAssets = ISpoke(ctx.spoke).getUserSuppliedAssets(reserveId, ctx.pool);
        if (suppliedAssets == 0) return n;

        uint256 amount = (suppliedAssets * ctx.withdrawPortion) / 1e18;
        if (amount == 0) return n;

        (address underlying, bool ok) = _getReserveUnderlying(ctx.spoke, reserveId);
        if (!ok || underlying == address(0)) revert InvalidUnderlying();

        if (!_reservePriceAvailable(ctx.pool, underlying)) return n;

        txs[n++] = MultiTransaction({
            to: takerPositionManager,
            txData: abi.encodeWithSelector(
                ITakerPositionManager.approveWithdraw.selector,
                ctx.spoke,
                reserveId,
                ctx.pool,
                type(uint256).max
            )
        });

        txs[n++] = MultiTransaction({
            to: takerPositionManager,
            txData: abi.encodeWithSelector(
                ITakerPositionManager.withdrawOnBehalfOf.selector,
                ctx.spoke,
                reserveId,
                amount,
                ctx.pool
            )
        });

        txs[n++] = MultiTransaction({
            to: underlying,
            txData: abi.encodeWithSelector(IERC20.transfer.selector, ctx.to, amount)
        });

        return n;
    }

    /*//////////////////////////////////////////////////////////////
                            INTERNAL HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Resolves a reserve's underlying token address via a raw staticcall, reading only the
    ///      first 32-byte word of the returned Reserve struct. See contract-level @dev for why
    ///      this avoids depending on the full struct's exact encoded layout.
    function _getReserveUnderlying(
        address spoke,
        uint256 reserveId
    ) internal view returns (address underlying, bool ok) {
        (bool success, bytes memory data) = spoke.staticcall(
            abi.encodeWithSignature("getReserve(uint256)", reserveId)
        );
        if (!success || data.length < 32) {
            return (address(0), false);
        }
        assembly {
            underlying := mload(add(data, 32))
        }
        ok = true;
    }
}
