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
contract AaveV4SpokeAssetGuard is ClosedAssetGuard, IAddAssetCheckGuard, IPreValuedAssetGuard {
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

    /// @dev USD-18 dust tolerance for `removeAssetCheck`, matching the tolerance
    ///      `PoolLogic._withdrawCashImmediateToSafe` already uses for its own value-conservation
    ///      check. `_appendReserveWithdrawTxs` computes a full withdrawal's `amount` from a
    ///      live-read `ISpoke.getUserSuppliedAssets` snapshot rather than a `type(uint256).max`
    ///      sentinel (Aave V4's `withdrawOnBehalfOf` does not document supporting one, unlike
    ///      `approveWithdraw`'s allowance — see ITakerPositionManager), because this guard
    ///      forwards a fixed, pre-computed amount via a direct `transfer(to, amount)` rather than
    ///      a balance-delta measurement (multiple reserves can share one Spoke with *different*
    ///      underlyings, so PoolLogic's single-`withdrawAsset` delta tracking doesn't apply here
    ///      — see the contract-level documentation above). If Aave V4's internal share<->asset rounding
    ///      ever leaves a tiny residual behind after withdrawing that exact snapshotted amount,
    ///      a strict `balance == 0` check would block removeAssetCheck() indefinitely, since
    ///      getBalance() re-reads live state and would keep reporting that same tiny nonzero
    ///      value forever — bricking the only recovery path over an amount with no realistic
    ///      economic significance.
    uint256 private constant DUST_TOLERANCE_USD18 = 1e15;

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
        address poolManagerLogic = IPoolLogic(pool).poolManagerLogic();
        uint256[] memory reserveIds = IAaveV4SpokeManager(aaveV4SpokeManager).getPoolReserves(
            pool,
            spoke
        );

        for (uint256 i = 0; i < reserveIds.length; ++i) {
            balanceUsd18 += _reserveValueUsd(pool, spoke, poolManagerLogic, reserveIds[i]);
        }
    }

    /// @dev Fault-isolated valuation of a single reserve. Any failure (Spoke call reverts,
    ///      underlying unresolved, underlying unpriced or unguarded) contributes 0 rather than
    ///      reverting the whole getBalance() call — see the contract-level documentation above.
    function _reserveValueUsd(
        address pool,
        address spoke,
        address poolManagerLogic,
        uint256 reserveId
    ) internal view returns (uint256) {
        uint256 suppliedAssets;
        try ISpoke(spoke).getUserSuppliedAssets(reserveId, pool) returns (uint256 a) {
            suppliedAssets = a;
        } catch {
            return 0;
        }
        if (suppliedAssets == 0) return 0;

        (address underlying, bool ok) = _getReserveUnderlying(spoke, reserveId);
        if (!ok || underlying == address(0)) return 0;

        uint256 price;
        try IPoolManagerLogic(poolManagerLogic).getAssetPrice(underlying) returns (uint256 p) {
            price = p;
        } catch {
            return 0;
        }
        if (price == 0) return 0;

        uint256 decimals;
        try IPoolManagerLogic(poolManagerLogic).assetDecimal(underlying) returns (uint256 d) {
            decimals = d;
        } catch {
            return 0;
        }
        return (suppliedAssets * price) / (10 ** decimals);
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

    /// @notice Allows removal once the position is closed to within DUST_TOLERANCE_USD18,
    ///         rather than requiring an exact zero balance.
    /// @dev See DUST_TOLERANCE_USD18 for why: a nominally-full withdrawal computes its amount
    ///      from a live snapshot rather than a max-balance sentinel, so a tiny rounding residual
    ///      on Aave V4's side is a realistic possibility this guard cannot rule out, and a
    ///      strict zero-check would have no recovery path if it ever occurred.
    function removeAssetCheck(address pool, address asset) public view override {
        uint256 balance = getBalance(pool, asset);
        require(balance <= DUST_TOLERANCE_USD18, "ClosedAssetGuard: non-empty asset");
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
