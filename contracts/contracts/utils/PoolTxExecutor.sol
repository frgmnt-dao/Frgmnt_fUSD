// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IPoolManagerLogic } from "../interfaces/IPoolManagerLogic.sol";
import { IHasSupportedAsset } from "../interfaces/IHasSupportedAsset.sol";
import { IGuard } from "../interfaces/guards/IGuard.sol";
import { ITxTrackingGuard } from "../interfaces/guards/ITxTrackingGuard.sol";
import { CallResultChecker } from "./CallResultChecker.sol";

library PoolTxExecutor {
    // ============================================================
    // =                         ERRORS                           =
    // ============================================================

    error InvalidGuard();
    error AssetDisabled();
    error InvalidTransaction();
    error OnlyManagerOrTrader();

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

        return (true, txType);
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
