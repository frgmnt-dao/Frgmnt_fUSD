// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IPoolManagerLogic } from "../interfaces/IPoolManagerLogic.sol";
import { IHasSupportedAsset } from "../interfaces/IHasSupportedAsset.sol";
import { IPoolLogic } from "../interfaces/IPoolLogic.sol";
import { IGuard } from "../interfaces/guards/IGuard.sol";
import { ITxTrackingGuard } from "../interfaces/guards/ITxTrackingGuard.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { CallResultChecker } from "./CallResultChecker.sol";

library PoolTxExecutor {
    // ============================================================
    // =                         ERRORS                           =
    // ============================================================

    error InvalidGuard();
    error AssetDisabled();
    error InvalidTransaction();
    error OnlyManagerOrTrader();
    error InvalidReservedBalance();

    // ============================================================
    // =                         STRUCT                           =
    // ============================================================

    struct ExecContext {
        address pool;
        address poolManagerLogic;
        address manager;
        address trader;
    }

    // ============================================================
    // =                  TRANSACTION EXECUTION                      =
    // ============================================================

    function exec(
        ExecContext memory ctx,
        address to,
        bytes memory data
    ) external returns (bool, uint16) {
        if (to == address(0)) revert InvalidTransaction();

        (address guard, uint16 txType, bool isPublic) = _resolveGuard(
            ctx.poolManagerLogic,
            to,
            data
        );

        if (txType == 0) revert InvalidTransaction();

        if (!isPublic && msg.sender != ctx.manager && msg.sender != ctx.trader) {
            revert OnlyManagerOrTrader();
        }

        (bool success, bytes memory returndata) = to.call(data);
        CallResultChecker._checkCallResult(data, success, returndata);

        _afterTxGuard(ctx.poolManagerLogic, guard, to, data);

        _checkReservedBalancesIntact(ctx.pool, ctx.poolManagerLogic);

        return (true, txType);
    }

    // ============================================================
    // =                RESERVED BALANCE INVARIANT                 =
    // ============================================================

    /// @dev Guarantees the reserve invariant (balanceOf(pool) >= reservedAssetBalance[asset])
    ///      still holds for every supported asset after an arbitrary guarded call dispatched via
    ///      exec() above. This dispatch is protocol-agnostic and has no notion of reservations —
    ///      without this check, a manager/trader deploying a reserved asset elsewhere (e.g.
    ///      supplying it to Aave for yield, completely ordinary vault management) could silently
    ///      leave a finalized withdraw claim unbacked, with nothing surfacing the problem until
    ///      the claimant's own claimCashWithdraw() reverts. Checking only after the call (not
    ///      before) is sufficient: the invariant is restored by this same check after every prior
    ///      exec() call, and the queued-withdrawal functions on PoolLogic already maintain it
    ///      themselves, so nothing else in the pool's control could have broken it in between.
    function _checkReservedBalancesIntact(address pool, address poolManagerLogic) private view {
        IHasSupportedAsset.Asset[] memory assets = IHasSupportedAsset(poolManagerLogic)
            .getSupportedAssets();
        uint256 len = assets.length;
        for (uint256 i; i < len; ++i) {
            address asset = assets[i].asset;
            uint256 reserved = IPoolLogic(pool).reservedAssetBalance(asset);
            if (reserved > 0 && IERC20(asset).balanceOf(pool) < reserved) {
                revert InvalidReservedBalance();
            }
        }
    }

    // ============================================================
    // =                    GUARD RESOLUTION                      =
    // ============================================================

    function _resolveGuard(
        address poolManagerLogic,
        address to,
        bytes memory data
    ) private returns (address guard, uint16 txType, bool isPublic) {
        // 1) Contract guard
        address contractGuard = IPoolManagerLogic(poolManagerLogic).getContractGuard(to);

        if (contractGuard != address(0)) {
            guard = contractGuard;
            (txType, isPublic) = IGuard(guard).txGuard(poolManagerLogic, to, data);
        }

        // 2) Fallback to asset guard
        if (txType == 0) {
            address assetGuard = IPoolManagerLogic(poolManagerLogic).getAssetGuard(to);

            if (assetGuard == address(0)) revert InvalidGuard();

            if (!IHasSupportedAsset(poolManagerLogic).isSupportedAsset(to)) {
                revert AssetDisabled();
            }

            guard = assetGuard;
            (txType, isPublic) = IGuard(guard).txGuard(poolManagerLogic, to, data);
        }
    }

    function _afterTxGuard(
        address poolManagerLogic,
        address guard,
        address to,
        bytes memory data
    ) private {
        (bool hasFn, bytes memory ret) = guard.call(abi.encodeWithSignature("isTxTrackingGuard()"));

        if (!hasFn || ret.length != 32) return;

        bool tracking = abi.decode(ret, (bool));
        if (!tracking) return;

        ITxTrackingGuard(guard).afterTxGuard(poolManagerLogic, to, data);
    }
}
