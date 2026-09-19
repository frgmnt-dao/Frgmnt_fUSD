// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAaveV4SpokeManager } from "../../interfaces/IAaveV4SpokeManager.sol";
import { ISubPositionGuard } from "../../interfaces/guards/ISubPositionGuard.sol";
import { IAssetGuard } from "../../interfaces/guards/IAssetGuard.sol";
import { AaveV4SpokeAssetGuard } from "./AaveV4SpokeAssetGuard.sol";

/// @title AaveV4SpokeSelectiveAssetGuard
/// @notice AaveV4SpokeAssetGuard plus reserve-level selection for attested selective withdrawals.
/// @dev Inherits the validated guard unchanged (no function of AaveV4SpokeAssetGuard is
///      overridden or edited) and only ADDS withdrawProcessingSubset(), which reuses the base
///      contract's own per-reserve helper. Every per-reserve safeguard therefore applies
///      identically to a selected reserve: Hub-liquidity capping (FNA-07), the shared
///      Hub-liquidity ledger, the unpriced-reserve skip, and the direct withdraw-then-transfer
///      pair. The only difference from withdrawProcessing() is the iteration set: the listed,
///      validated reserveIds instead of every tracked reserve, so the liquidity ledger only
///      accounts for selected reserves — an illiquid reserve the plan did not select can no
///      longer block a healthy one.
///      Position id = the reserveId (uint256 widened to bytes32).
contract AaveV4SpokeSelectiveAssetGuard is AaveV4SpokeAssetGuard, ISubPositionGuard {
    error InvalidPositionId();
    error PositionsNotAscending();

    constructor(
        address aaveV4SpokeManager_,
        address takerPositionManager_,
        address giverPositionManager_
    ) AaveV4SpokeAssetGuard(aaveV4SpokeManager_, takerPositionManager_, giverPositionManager_) {}

    function isSubPositionGuard() external pure override returns (bool) {
        return true;
    }

    function withdrawProcessingSubset(
        address pool,
        address spoke,
        uint256 portion,
        address to,
        bytes32[] calldata positionIds
    )
        external
        view
        override
        returns (
            address withdrawAsset,
            uint256 withdrawAmount,
            IAssetGuard.MultiTransaction[] memory txs
        )
    {
        if (portion > 1e18) revert BadPortion();
        if (to == address(0)) revert InvalidRecipient();

        uint256[] memory tracked = IAaveV4SpokeManager(aaveV4SpokeManager).getTrackedPoolReserves(
            pool,
            spoke
        );

        uint256 count = positionIds.length;
        txs = new MultiTransaction[](count * 2);
        uint256 n;
        WithdrawCtx memory ctx = WithdrawCtx({
            pool: pool,
            spoke: spoke,
            to: to,
            withdrawPortion: portion
        });
        HubLiquidityLedger memory ledger = _newHubLiquidityLedger(count);

        for (uint256 i = 0; i < count; ++i) {
            if (i > 0 && positionIds[i] <= positionIds[i - 1]) revert PositionsNotAscending();
            uint256 reserveId = uint256(positionIds[i]);
            if (!_isTracked(tracked, reserveId)) revert InvalidPositionId();
            n = _appendReserveWithdrawTxs(ctx, reserveId, txs, n, ledger);
        }

        assembly {
            mstore(txs, n)
        }
        return (address(0), 0, txs);
    }

    function _isTracked(uint256[] memory tracked, uint256 reserveId) private pure returns (bool) {
        for (uint256 i = 0; i < tracked.length; ++i) {
            if (tracked[i] == reserveId) return true;
        }
        return false;
    }
}
