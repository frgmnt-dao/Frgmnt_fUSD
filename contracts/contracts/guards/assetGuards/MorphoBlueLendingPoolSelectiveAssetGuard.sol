// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    IMorpho,
    Id,
    MarketParams,
    Position
} from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";
import { SharesMathLib } from "@morpho-org/morpho-blue/src/libraries/SharesMathLib.sol";
import { IMorphoBlueManager } from "../../interfaces/IMorphoBlueManager.sol";
import { ISubPositionGuard } from "../../interfaces/guards/ISubPositionGuard.sol";
import { IAssetGuard } from "../../interfaces/guards/IAssetGuard.sol";
import { MorphoMathLib } from "../../utils/MorphoMathLib.sol";
import { MorphoCollectLib } from "../../utils/MorphoCollectLib.sol";
import { MorphoBlueLendingPoolAssetGuard } from "./MorphoBlueLendingPoolAssetGuard.sol";

/// @title MorphoBlueLendingPoolSelectiveAssetGuard
/// @notice MorphoBlueLendingPoolAssetGuard plus market-level selection for attested selective
///         withdrawals.
/// @dev Inherits the validated guard unchanged (nothing in it is overridden or edited) and only
///      ADDS withdrawProcessingSubset(). It reuses the base contract's own collectors and its
///      no-debt transaction builder, so share/asset rounding and transaction shape are those of
///      the validated code; the additions are (a) validating the selected market ids, (b) sizing
///      the liquidity ceiling over the SELECTED markets only, and (c) filtering the collector
///      output to the selected ids.
///
///      Scope (v1): markets with an open borrow position are NOT selectable — the subset path
///      reverts on them rather than attempting a partial flash-loan unwind. Morpho Blue markets
///      are isolated, so withdrawing supply or collateral from a debt-free market cannot affect
///      the health of a different market that carries debt; a debt-carrying market is simply left
///      untouched (and stays in NAV). Unwinding leveraged markets remains the pro-rata path's job.
///
///      Liquidity ceiling: the base guard clamps EVERY leg by the minimum liquidity ratio across
///      ALL tracked markets, so one near-fully-utilised market throttles the entire guard. Here
///      the ceiling is the minimum across the selected markets only, which is the point of
///      selection: a plan drawing from a liquid market is not throttled by an illiquid one it did
///      not choose. Value delivered is still bounded on-chain by the plan's value-conservation
///      check regardless of this guard's arithmetic.
///
///      Position id = the market Id (bytes32).
contract MorphoBlueLendingPoolSelectiveAssetGuard is
    MorphoBlueLendingPoolAssetGuard,
    ISubPositionGuard
{
    error InvalidPositionId();
    error PositionsNotAscending();
    error SubsetDebtUnsupported();

    constructor(
        address morpho_,
        address morphoManager_,
        address swapRouter_,
        address preferredSettlementAsset_
    )
        MorphoBlueLendingPoolAssetGuard(
            morpho_,
            morphoManager_,
            swapRouter_,
            preferredSettlementAsset_
        )
    {}

    function isSubPositionGuard() external pure override returns (bool) {
        return true;
    }

    function withdrawProcessingSubset(
        address pool,
        address,
        uint256 portion,
        address to,
        bytes32[] calldata positionIds
    ) external view override returns (address, uint256, IAssetGuard.MultiTransaction[] memory txs) {
        if (portion > MorphoMathLib.PORTION_DENOMINATOR) revert BadPortion();
        if (to == address(0)) revert ToZero();

        uint256 ceiling = _validateAndSizeCeiling(pool, positionIds);
        uint256 effectivePortion = (portion * ceiling) / MorphoMathLib.PORTION_DENOMINATOR;

        txs = _withdrawNoDebt(
            pool,
            _filterSupplies(_collectSupplies(pool, effectivePortion), positionIds),
            _filterCollaterals(_collectCollaterals(pool, effectivePortion), positionIds),
            to
        );
        return (address(0), 0, txs);
    }

    /// @dev Validates every id (strictly ascending, currently tracked for `pool`, no open borrow)
    ///      and returns the minimum supply-liquidity ratio across the selected markets — the same
    ///      computation as the base _maxSafePortion, restricted to the selection.
    function _validateAndSizeCeiling(
        address pool,
        bytes32[] calldata positionIds
    ) private view returns (uint256 ceiling) {
        Id[] memory tracked = IMorphoBlueManager(morphoManager).getTrackedPoolMarkets(pool);
        ceiling = MorphoMathLib.PORTION_DENOMINATOR;

        for (uint256 i; i < positionIds.length; ++i) {
            bytes32 raw = positionIds[i];
            if (i > 0 && raw <= positionIds[i - 1]) revert PositionsNotAscending();
            if (!_isTracked(tracked, raw)) revert InvalidPositionId();

            Id id = Id.wrap(raw);
            Position memory p = IMorpho(morpho).position(id, pool);
            if (p.borrowShares != 0) revert SubsetDebtUnsupported();
            if (p.supplyShares == 0) continue;

            MarketParams memory mp = IMorpho(morpho).idToMarketParams(id);
            (
                uint256 totalSupplyAssets,
                uint256 totalSupplyShares,
                uint256 totalBorrowAssets,

            ) = MorphoCollectLib._getAccruedMarketTotals(morpho, mp);

            uint256 fullSupplyAssets = SharesMathLib.toAssetsDown(
                p.supplyShares,
                totalSupplyAssets,
                totalSupplyShares
            );
            if (fullSupplyAssets == 0) continue;

            uint256 available = totalSupplyAssets > totalBorrowAssets
                ? totalSupplyAssets - totalBorrowAssets
                : 0;
            if (available >= fullSupplyAssets) continue;

            uint256 maxForMarket = (available * MorphoMathLib.PORTION_DENOMINATOR) /
                fullSupplyAssets;
            if (maxForMarket < ceiling) ceiling = maxForMarket;
        }
    }

    function _isTracked(Id[] memory tracked, bytes32 raw) private pure returns (bool) {
        for (uint256 i; i < tracked.length; ++i) {
            if (Id.unwrap(tracked[i]) == raw) return true;
        }
        return false;
    }

    function _selected(bytes32[] calldata positionIds, Id id) private pure returns (bool) {
        bytes32 raw = Id.unwrap(id);
        for (uint256 i; i < positionIds.length; ++i) {
            if (positionIds[i] == raw) return true;
        }
        return false;
    }

    function _filterSupplies(
        MorphoCollectLib.SupplyPlan[] memory plans,
        bytes32[] calldata positionIds
    ) private pure returns (MorphoCollectLib.SupplyPlan[] memory out) {
        out = new MorphoCollectLib.SupplyPlan[](plans.length);
        uint256 n;
        for (uint256 i; i < plans.length; ++i) {
            if (_selected(positionIds, plans[i].id)) out[n++] = plans[i];
        }
        assembly {
            mstore(out, n)
        }
    }

    function _filterCollaterals(
        MorphoCollectLib.CollateralPlan[] memory plans,
        bytes32[] calldata positionIds
    ) private pure returns (MorphoCollectLib.CollateralPlan[] memory out) {
        out = new MorphoCollectLib.CollateralPlan[](plans.length);
        uint256 n;
        for (uint256 i; i < plans.length; ++i) {
            if (_selected(positionIds, plans[i].id)) out[n++] = plans[i];
        }
        assembly {
            mstore(out, n)
        }
    }
}
