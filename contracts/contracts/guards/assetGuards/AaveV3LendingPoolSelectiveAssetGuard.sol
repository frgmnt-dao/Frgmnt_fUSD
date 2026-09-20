// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAaveV3Pool } from "../../interfaces/aave/v3/IAaveV3Pool.sol";
import { IHasSupportedAsset } from "../../interfaces/IHasSupportedAsset.sol";
import { IPoolLogic } from "../../interfaces/IPoolLogic.sol";
import { IERC20Extended } from "../../interfaces/IERC20Extended.sol";
import { ISubPositionGuard } from "../../interfaces/guards/ISubPositionGuard.sol";
import { IAssetGuard } from "../../interfaces/guards/IAssetGuard.sol";
import { AaveV3LendingPoolAssetGuard } from "./AaveLendingPoolAssetGuard.sol";

/// @title AaveV3LendingPoolSelectiveAssetGuard
/// @notice AaveV3LendingPoolAssetGuard plus reserve-level selection for attested selective
///         withdrawals, available ONLY while the pool carries no Aave V3 debt.
/// @dev Inherits the validated guard unchanged and only ADDS withdrawProcessingSubset().
///
///      Why debt-free only. With debt, every reserve backs one shared account: the validated
///      guard scales collateral withdrawal and debt repayment by the SAME portion so the health
///      factor is unchanged, and repays through one flash loan funded by the withdrawn
///      collateral. Taking only some reserves would change the health factor and could leave the
///      flash loan under-funded, so any open debt anywhere in the account reverts
///      SubsetDebtUnsupported (leveraged unwinds stay on the whole-asset path). With no debt each
///      reserve is an independent Pool.withdraw followed by a transfer, so drawing some reserves
///      cannot affect any other.
///
///      What it reuses. The validated internal _withdrawCollateralAndTransfer() builds the
///      (withdraw, transfer) pair for every reserve; this contract calls it and keeps only the
///      pairs of the selected reserves, so the transaction shape and amount arithmetic are the
///      validated ones. The only new arithmetic is the liquidity ceiling, which the validated
///      _maxSafePortion() takes as the minimum across ALL reserves (one near-fully-utilised
///      reserve throttles everything); here it is the minimum across the SELECTED reserves, the
///      point of selection. The filter is fail-closed: a transaction that is not a Pool.withdraw
///      or a token transfer reverts UnexpectedTransaction. The plan's value-conservation bound,
///      not this arithmetic, is the security boundary.
///
///      Position id = the reserve's underlying token address widened to bytes32. Ids must be
///      strictly ascending, must be supported assets of the pool, and must be Aave reserves.
///
///      Known limit: as in the validated guard, the plan is built over every supported asset
///      before filtering, so an unselected reserve whose data calls revert still reverts the call.
contract AaveV3LendingPoolSelectiveAssetGuard is AaveV3LendingPoolAssetGuard, ISubPositionGuard {
    error InvalidPositionId();
    error PositionsNotAscending();
    error SubsetDebtUnsupported();
    error SubsetBadPortion();
    error SubsetToZero();
    error UnexpectedTransaction();

    uint256 private constant ONE = 1e18;

    constructor(
        address aaveProtocolDataProvider_,
        address aaveLendingPool_,
        address preferredSettlementAsset_,
        address swapRouter_
    )
        AaveV3LendingPoolAssetGuard(
            aaveProtocolDataProvider_,
            aaveLendingPool_,
            preferredSettlementAsset_,
            swapRouter_
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
        if (portion > ONE) revert SubsetBadPortion();
        if (to == address(0)) revert SubsetToZero();

        (, uint256 debtAssets) = _collectDebtPlans(pool, ONE);
        if (debtAssets != 0) revert SubsetDebtUnsupported();

        uint256 ceiling = _validateAndSizeCeiling(pool, positionIds);
        MultiTransaction[] memory all = _withdrawCollateralAndTransfer(
            pool,
            (portion * ceiling) / ONE,
            to
        );

        txs = new IAssetGuard.MultiTransaction[](all.length);
        uint256 n;
        for (uint256 i; i < all.length; ++i) {
            bytes memory data = all[i].txData;
            address reserve;
            if (all[i].to == aaveLendingPool) {
                if (data.length < 36 || bytes4(data) != IAaveV3Pool.withdraw.selector) {
                    revert UnexpectedTransaction();
                }
                assembly {
                    reserve := mload(add(data, 36))
                }
            } else {
                if (data.length < 4 || bytes4(data) != IERC20Extended.transfer.selector) {
                    revert UnexpectedTransaction();
                }
                reserve = all[i].to;
            }
            if (_isSelected(positionIds, reserve)) {
                txs[n++] = IAssetGuard.MultiTransaction({ to: all[i].to, txData: data });
            }
        }
        assembly {
            mstore(txs, n)
        }
        return (address(0), 0, txs);
    }

    /// @dev Validates every id and returns the minimum liquidity ratio across the selected
    ///      reserves — the validated _maxSafePortion() computation restricted to the selection.
    function _validateAndSizeCeiling(
        address pool,
        bytes32[] calldata positionIds
    ) private view returns (uint256 ceiling) {
        IHasSupportedAsset.Asset[] memory supported = IHasSupportedAsset(
            IPoolLogic(pool).poolManagerLogic()
        ).getSupportedAssets();
        ceiling = ONE;

        for (uint256 i; i < positionIds.length; ++i) {
            bytes32 raw = positionIds[i];
            if (i > 0 && raw <= positionIds[i - 1]) revert PositionsNotAscending();
            if (uint256(raw) > type(uint160).max) revert InvalidPositionId();
            address underlying = address(uint160(uint256(raw)));
            if (!_isSupported(supported, underlying)) revert InvalidPositionId();

            address aToken = IAaveV3Pool(aaveLendingPool).getReserveAToken(underlying);
            if (aToken == address(0)) revert InvalidPositionId();

            uint256 aTokenBalance = IERC20Extended(aToken).balanceOf(pool);
            if (aTokenBalance == 0) continue;
            uint256 available = IERC20Extended(underlying).balanceOf(aToken);
            if (available >= aTokenBalance) continue;
            uint256 maxForReserve = (available * ONE) / aTokenBalance;
            if (maxForReserve < ceiling) ceiling = maxForReserve;
        }
    }

    function _isSupported(
        IHasSupportedAsset.Asset[] memory supported,
        address asset
    ) private pure returns (bool) {
        for (uint256 i; i < supported.length; ++i) {
            if (supported[i].asset == asset) return true;
        }
        return false;
    }

    function _isSelected(
        bytes32[] calldata positionIds,
        address reserve
    ) private pure returns (bool) {
        bytes32 raw = bytes32(uint256(uint160(reserve)));
        for (uint256 i; i < positionIds.length; ++i) {
            if (positionIds[i] == raw) return true;
        }
        return false;
    }
}
