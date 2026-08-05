// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////
                            IMPORTS
//////////////////////////////////////////////////////////////*/

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { ISpoke } from "../../interfaces/aave/v4/ISpoke.sol";
import { IHubBase } from "../../interfaces/aave/v4/IHubBase.sol";
import { IAaveV4SpokeManager } from "../../interfaces/IAaveV4SpokeManager.sol";
import { IPoolManagerLogic } from "../../interfaces/IPoolManagerLogic.sol";
import { IPoolLogic } from "../../interfaces/IPoolLogic.sol";
import { IHasSupportedAsset } from "../../interfaces/IHasSupportedAsset.sol";
import { IAddAssetCheckGuard } from "../../interfaces/guards/IAddAssetCheckGuard.sol";
import { IIncompleteValuationGuard } from "../../interfaces/guards/IIncompleteValuationGuard.sol";
import { IWithdrawableBalanceGuard } from "../../interfaces/guards/IWithdrawableBalanceGuard.sol";
import { ITransactionTypes } from "../../interfaces/ITransactionTypes.sol";
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
///  - `getBalance` resolves each reserve's underlying token (and, for FNA-07 liquidity capping,
///    its Hub and Hub-side assetId) via a raw `staticcall` reading the first three 32-byte words
///    of `ISpoke.getReserve(uint256)`'s return data, rather than decoding the full `Reserve`
///    struct — see ISpoke's own documentation for the confirmed field layout this relies on, and
///    _getReserveUnderlyingAndHub below.
///  - Every external call into the Spoke in `getBalance` is fault-isolated per reserve (skip and
///    continue, not revert-the-whole-function) — unlike Morpho Vault V2 (a single position per
///    guard call), a Spoke aggregates multiple reserves, so one bad reserve must not zero out
///    the valuation of the others.
///  - FNA-07: `getWithdrawableBalance`/`withdrawProcessing` cap each reserve's withdrawable
///    amount by `IHubBase.getAssetLiquidity`, so one under-liquid reserve sizes its own share
///    down instead of `withdraw` reverting and taking every other reserve (and every
///    other asset in the pool) down with it via PoolLogic's single atomic withdrawal transaction.
///  - FNA-15: `withdrawProcessing` calls `ISpoke.withdraw` directly rather than routing through
///    Aave's TakerPositionManager. PoolLogic always dispatches these calls from its own address,
///    so the position owner and the caller are the same address — Aave's own
///    `_isPositionManager` check short-circuits to true for `user == manager`, needing no
///    PositionManager delegation or allowance at all. This drops the per-reserve transaction
///    count from three (approveWithdraw, withdrawOnBehalfOf, transfer) to two (withdraw,
///    transfer). See `takerPositionManager`'s own doc comment for why that immutable is kept
///    regardless (still needed by the separate, Taker-mediated manual withdrawal path in
///    AaveV4SpokeContractGuard).
contract AaveV4SpokeAssetGuard is
    ClosedAssetGuard,
    IAddAssetCheckGuard,
    IIncompleteValuationGuard,
    IWithdrawableBalanceGuard,
    ITransactionTypes
{
    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error ManagerZero();
    error TakerPositionManagerZero();
    error GiverPositionManagerZero();
    error BadPortion();
    error InvalidRecipient();
    error InvalidUnderlying();
    error SpokeNotWhitelisted();
    error NotPoolLogic();
    error InvalidPositionManager();

    /*//////////////////////////////////////////////////////////////
                              CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @dev Raw-unit dust tolerance for `removeAssetCheck`. `_appendReserveWithdrawTxs` computes
    ///      a full withdrawal's `amount` from a live-read `ISpoke.getUserSuppliedAssets` snapshot
    ///      rather than a `type(uint256).max` sentinel (Aave V4's `withdraw` does not document
    ///      supporting one), because this guard forwards a fixed, pre-computed amount via
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

    /// @notice Aave V4's singleton TakerPositionManager.
    /// @dev FNA-15: automatic withdrawProcessing() no longer routes through Taker — it calls
    ///      ISpoke.withdraw() directly, since a pool withdrawing its own position needs no
    ///      PositionManager delegation at all (see _appendReserveWithdrawTxs). This immutable is
    ///      kept (not removed, despite the finding's literal suggestion) because txGuard above
    ///      (FNA-08) still needs it: the manager can still choose to withdraw manually via
    ///      AaveV4SpokeContractGuard's execTransaction path, which does route through Taker and
    ///      therefore still requires the pool to have approved Taker as a position manager.
    address public immutable takerPositionManager;

    /// @notice Aave V4's singleton GiverPositionManager.
    /// @dev FNA-08: the only other address (besides takerPositionManager) a pool is ever
    ///      authorized to approve via setUserPositionManager — see txGuard below.
    address public immutable giverPositionManager;

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(
        address aaveV4SpokeManager_,
        address takerPositionManager_,
        address giverPositionManager_
    ) {
        if (aaveV4SpokeManager_ == address(0)) revert ManagerZero();
        if (takerPositionManager_ == address(0)) revert TakerPositionManagerZero();
        if (giverPositionManager_ == address(0)) revert GiverPositionManagerZero();
        aaveV4SpokeManager = aaveV4SpokeManager_;
        takerPositionManager = takerPositionManager_;
        giverPositionManager = giverPositionManager_;
    }

    /*//////////////////////////////////////////////////////////////
                FNA-08: SPOKE POSITION-MANAGER AUTHORIZATION
    //////////////////////////////////////////////////////////////*/

    bytes4 private constant SEL_SET_USER_POSITION_MANAGER = ISpoke.setUserPositionManager.selector;

    event AaveV4SpokeSetPositionManagerEvt(
        address indexed pool,
        address indexed spoke,
        address indexed positionManager,
        bool approved,
        uint256 time
    );

    /// @notice Authorizes PoolLogic.execTransaction(spoke, setUserPositionManager(...)).
    /// @dev FNA-08: Aave V4 requires the position owner (the pool) to call
    ///      `ISpoke.setUserPositionManager(positionManager, approve)` before Giver/Taker
    ///      PositionManagers may act on its behalf — including the pool's very first supply, per
    ///      the (corrected) documentation on IGiverPositionManager. Before this override, no path
    ///      existed to make that call: `to` here is the Spoke, which has no dedicated
    ///      ContractGuard registered against it (only GiverPositionManager/TakerPositionManager
    ///      are — see AaveV4SpokeContractGuard), so PoolTxExecutor's guard-resolution falls back
    ///      to this asset guard, whose inherited ClosedAssetGuard.txGuard unconditionally
    ///      rejected everything. This override recognizes exactly one additional selector,
    ///      leaving every other call to the Spoke rejected exactly as before.
    ///
    ///      CRITICAL SECURITY PROPERTY (mirrors AaveV4SpokeContractGuard's own reasoning about
    ///      approveWithdraw's `spender` restriction): `positionManager` must be restricted to
    ///      exactly {giverPositionManager, takerPositionManager}. Aave V4's withdraw sends funds
    ///      to msg.sender, not onBehalfOf — approving an arbitrary address as position manager
    ///      would let that address call withdraw directly (bypassing every guard in this
    ///      repository) and receive the pool's entire supplied position.
    function txGuard(
        address poolManagerLogic,
        address spoke,
        bytes calldata data
    ) external override returns (uint16 txType, bool isPublic) {
        address poolLogic = IPoolManagerLogic(poolManagerLogic).poolLogic();
        if (msg.sender != poolLogic) revert NotPoolLogic();

        if (getMethod(data) != SEL_SET_USER_POSITION_MANAGER) {
            return (0, false);
        }

        bytes memory params = getParams(data);
        (address positionManager, bool approved) = abi.decode(params, (address, bool));

        if (positionManager != giverPositionManager && positionManager != takerPositionManager) {
            revert InvalidPositionManager();
        }

        emit AaveV4SpokeSetPositionManagerEvt(
            poolLogic,
            spoke,
            positionManager,
            approved,
            block.timestamp
        );
        return (uint16(TransactionType.AaveV4SpokeSetPositionManager), false);
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
    ///      across every TRACKED reserve (FNA-10 — not just the actively-allowed ones, so a
    ///      reserve the protocol owner has since delisted stays in the pool's reported NAV for
    ///      as long as it may still hold supply); `complete` is true only if every reserve valued
    ///      successfully (a reserve with suppliedAssets == 0 counts as successfully valued, not
    ///      incomplete — see _reserveValueUsd()).
    function _valuePosition(
        address pool,
        address spoke
    ) internal view returns (uint256 balanceUsd18, bool complete) {
        address poolManagerLogic = IPoolLogic(pool).poolManagerLogic();
        uint256[] memory reserveIds = IAaveV4SpokeManager(aaveV4SpokeManager).getTrackedPoolReserves(
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

        (address underlying, , , bool ok) = _getReserveUnderlyingAndHub(spoke, reserveId);
        if (!ok || underlying == address(0)) return (0, false);

        return _valueAmount(poolManagerLogic, underlying, suppliedAssets);
    }

    /// @notice Liquidity-capped counterpart to getBalance() — see IWithdrawableBalanceGuard.
    /// @dev Sums, per TRACKED reserve (FNA-10 — see _valuePosition), the USD value of
    ///      min(suppliedAssets, IHubBase.getAssetLiquidity(assetId)) — the amount this reserve
    ///      could actually deliver right now, not just the pool's full claim (FNA-07).
    ///      Fault-isolated identically to getBalance()/_reserveValueUsd: any failure at any step
    ///      degrades this one reserve's contribution to 0 rather than reverting the whole call.
    /// @param pool Pool holding the position.
    /// @param spoke Address of the Aave V4 Spoke.
    /// @return balanceUsd18 USD value of the pool's aggregate *withdrawable* position, 18 decimals.
    function getWithdrawableBalance(
        address pool,
        address spoke
    ) external view override returns (uint256 balanceUsd18) {
        address poolManagerLogic = IPoolLogic(pool).poolManagerLogic();
        uint256[] memory reserveIds = IAaveV4SpokeManager(aaveV4SpokeManager).getTrackedPoolReserves(
            pool,
            spoke
        );

        for (uint256 i = 0; i < reserveIds.length; ++i) {
            (uint256 value, ) = _reserveWithdrawableValueUsd(pool, spoke, poolManagerLogic, reserveIds[i]);
            balanceUsd18 += value;
        }
    }

    /// @notice See IWithdrawableBalanceGuard.
    function isWithdrawableBalanceGuard() external pure override returns (bool) {
        return true;
    }

    /// @dev Same fault-isolation contract as _reserveValueUsd, but values
    ///      min(suppliedAssets, availableLiquidity) instead of the full suppliedAssets claim.
    function _reserveWithdrawableValueUsd(
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

        (address underlying, uint256 withdrawableAssets) = _capByAvailableLiquidity(
            spoke,
            reserveId,
            suppliedAssets
        );
        if (underlying == address(0)) return (0, false);

        return _valueAmount(poolManagerLogic, underlying, withdrawableAssets);
    }

    /// @dev Shared USD-valuation tail for both _reserveValueUsd (full claim) and
    ///      _reserveWithdrawableValueUsd (liquidity-capped claim), so they can never disagree
    ///      about which pricing failures count as "incomplete". Fault-isolated: any failure or a
    ///      zero price is reported as `!ok` (via _tryPriceAndDecimals) rather than reverting.
    function _valueAmount(
        address poolManagerLogic,
        address underlying,
        uint256 amount
    ) internal view returns (uint256, bool) {
        if (amount == 0) return (0, true);

        (bool priced, uint256 price, uint256 decimals) = _tryPriceAndDecimals(
            poolManagerLogic,
            underlying
        );
        if (!priced) return (0, false);

        return ((amount * price) / (10 ** decimals), true);
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

    /// @notice See IIncompleteValuationGuard.
    function isIncompleteValuationGuard() external pure override returns (bool) {
        return true;
    }

    /// @notice See IIncompleteValuationGuard.
    function isValuationComplete(address pool, address spoke) external view override returns (bool complete) {
        (, complete) = _valuePosition(pool, spoke);
    }

    /// @notice Allows removal once every TRACKED reserve (FNA-10 — see _valuePosition) is closed
    ///         to within RAW_DUST_TOLERANCE raw units, rather than requiring an exact zero
    ///         balance.
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
        uint256[] memory reserveIds = IAaveV4SpokeManager(aaveV4SpokeManager).getTrackedPoolReserves(
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

    /// @notice Builds the pro-rata withdrawal transactions across every TRACKED reserveId
    ///         (FNA-10 — see _valuePosition; includes reserves the protocol owner has since
    ///         delisted but that may still hold pool supply, not just the actively-allowed ones).
    /// @dev Per reserve: withdraw directly from the Spoke (FNA-15 — lands at the pool, since
    ///      Aave V4 sends withdrawn funds to msg.sender regardless of `onBehalfOf`, and needs no
    ///      PositionManager delegation since the caller IS the position owner), then a
    ///      direct transfer to `to` — see contract-level @dev for why this differs from the
    ///      single-`withdrawAsset` pattern used by Morpho Vault V2's guard. Returns
    ///      `withdrawAsset = address(0)` so PoolLogic does not attempt to track or forward
    ///      anything itself.
    ///
    ///      This only calls `ISpoke.withdraw` — it does not fall back to any alternate
    ///      liquidity source. FNA-07: it also no longer needs one for an under-liquid reserve —
    ///      _appendReserveWithdrawTxs below caps each reserve's requested amount by
    ///      `IHubBase.getAssetLiquidity`, the same cap `getWithdrawableBalance` already applied
    ///      when the caller sized `withdrawPortion` against the NAV, so this call is never asked
    ///      for more than the Spoke/Hub can currently return.
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

        uint256[] memory reserveIds = IAaveV4SpokeManager(aaveV4SpokeManager).getTrackedPoolReserves(
            pool,
            spoke
        );

        txs = new MultiTransaction[](reserveIds.length * 2);
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

    /// @dev Appends the (withdraw, transfer) pair for one reserve to `txs` starting at index
    ///      `n`, if the pool holds a nonzero withdrawable amount there. Returns the updated `n`.
    ///      FNA-15: previously a (approveWithdraw, withdrawOnBehalfOf, transfer) trio routed
    ///      through TakerPositionManager — dropped to two transactions since PoolLogic calling
    ///      ISpoke.withdraw() for its own position needs no PositionManager approval step at all.
    ///
    ///      `withdrawPortion` is sized by the caller against `_withdrawableFundValue()`, which —
    ///      via getWithdrawableBalance()/_reserveWithdrawableValueUsd() — already floors each
    ///      reserve's contribution by both (a) whether it can currently be priced and (b) its
    ///      real available liquidity (FNA-07). Applying that same portion to the *full* supplied
    ///      amount here (rather than to the same liquidity-capped amount the NAV was sized from)
    ///      would reopen exactly the mismatch this guards against: a caller could redeem a
    ///      portion sized against a smaller NAV while still receiving the larger, uncapped share
    ///      — extracting more value than the fUSD burned pays for, or asking `withdraw` for more
    ///      than the Spoke/Hub can currently return and reverting the whole withdrawal. A reserve
    ///      that can't currently be priced or valued is skipped rather than withdrawn, exactly
    ///      mirroring its 0 contribution to the NAV the portion was computed from — it stays
    ///      reserved for its pre-failure holders until pricing recovers, rather than being
    ///      extractable by whoever withdraws next.
    function _appendReserveWithdrawTxs(
        WithdrawCtx memory ctx,
        uint256 reserveId,
        MultiTransaction[] memory txs,
        uint256 n
    ) internal view returns (uint256) {
        uint256 suppliedAssets = ISpoke(ctx.spoke).getUserSuppliedAssets(reserveId, ctx.pool);
        if (suppliedAssets == 0) return n;

        (address underlying, uint256 withdrawableAssets) = _capByAvailableLiquidity(
            ctx.spoke,
            reserveId,
            suppliedAssets
        );
        if (underlying == address(0)) revert InvalidUnderlying();

        uint256 amount = (withdrawableAssets * ctx.withdrawPortion) / 1e18;
        if (amount == 0) return n;

        if (!_reservePriceAvailable(ctx.pool, underlying)) return n;

        txs[n++] = MultiTransaction({
            to: ctx.spoke,
            txData: abi.encodeWithSelector(
                ISpoke.withdraw.selector,
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

    /// @dev FNA-07: resolves a reserve's underlying token and caps `suppliedAssets` by the Hub's
    ///      real available liquidity for it, in one call — keeps _appendReserveWithdrawTxs's own
    ///      live-local count low enough to compile without `--via-ir`. Returns
    ///      `underlying = address(0)` if the Reserve struct itself couldn't be resolved (the
    ///      caller reverts on that, matching the pre-existing behavior of the raw underlying
    ///      lookup this replaces); a Hub liquidity query that fails degrades to 0 available
    ///      liquidity (skip this reserve, don't block the rest of the withdrawal) rather than
    ///      reverting, consistent with this fix's whole purpose.
    function _capByAvailableLiquidity(
        address spoke,
        uint256 reserveId,
        uint256 suppliedAssets
    ) internal view returns (address underlying, uint256 withdrawableAssets) {
        address hub;
        uint256 assetId;
        bool ok;
        (underlying, hub, assetId, ok) = _getReserveUnderlyingAndHub(spoke, reserveId);
        if (!ok || underlying == address(0)) return (address(0), 0);

        uint256 availableLiquidity;
        try IHubBase(hub).getAssetLiquidity(assetId) returns (uint256 l) {
            availableLiquidity = l;
        } catch {
            availableLiquidity = 0;
        }
        withdrawableAssets = suppliedAssets < availableLiquidity ? suppliedAssets : availableLiquidity;
    }

    /// @dev Resolves a reserve's underlying token, Hub, and Hub-side assetId via a raw
    ///      staticcall, reading the first three 32-byte words of the returned Reserve struct
    ///      (`underlying`, `hub`, `assetId`, in that order) without decoding the full struct —
    ///      see ISpoke's documentation for the confirmed field layout this relies on.
    function _getReserveUnderlyingAndHub(
        address spoke,
        uint256 reserveId
    ) internal view returns (address underlying, address hub, uint256 assetId, bool ok) {
        (bool success, bytes memory data) = spoke.staticcall(
            abi.encodeWithSignature("getReserve(uint256)", reserveId)
        );
        if (!success || data.length < 96) {
            return (address(0), address(0), 0, false);
        }
        assembly {
            underlying := mload(add(data, 32))
            hub := mload(add(data, 64))
            assetId := mload(add(data, 96))
        }
        ok = true;
    }
}
