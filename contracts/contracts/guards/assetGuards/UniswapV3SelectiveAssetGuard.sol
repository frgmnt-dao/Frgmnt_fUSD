// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    INonfungiblePositionManager
} from "@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol";
import { IPoolLogic } from "../../interfaces/IPoolLogic.sol";
import { IHasGuardInfo } from "../../interfaces/guards/IHasGuardInfo.sol";
import { ISubPositionGuard } from "../../interfaces/guards/ISubPositionGuard.sol";
import { IAssetGuard } from "../../interfaces/guards/IAssetGuard.sol";
import {
    UniswapV3NonfungiblePositionGuard
} from "../contractGuards/uniswapV3/UniswapV3NonfungiblePositionGuard.sol";
import { UniswapV3AssetGuard } from "./UniswapV3AssetGuard.sol";

/// @title UniswapV3SelectiveAssetGuard
/// @notice UniswapV3AssetGuard plus NFT-level selection for attested selective withdrawals.
/// @dev Inherits the validated guard unchanged and only ADDS withdrawProcessingSubset(). It does
///      NOT reimplement any Uniswap math: it asks the validated withdrawProcessing() for the
///      full plan (every owned NFT) and keeps only the transactions that act on the selected
///      NFTs. The validated per-NFT logic — TWAP-priced slippage minimums, the fee-only collect
///      caps, the token-support skip — therefore applies unchanged to every selected NFT.
///
///      Selection is by NFT tokenId (position id = tokenId widened to bytes32). Ids must be
///      strictly ascending and currently owned by the pool. The filter is fail-closed: a
///      transaction that is not a decreaseLiquidity/collect on the position manager with a
///      tokenId in the first argument word reverts instead of being passed through or dropped.
///      Uniswap V3 LP positions carry no debt, so withdrawing some NFTs cannot affect the health
///      of any other position.
///
///      Known limit (inherited from reusing the validated function): the plan is computed for
///      ALL owned NFTs before filtering, so an unselected NFT whose pricing reverts still reverts
///      the call, and gas grows with the number of owned NFTs, not with the selection.
contract UniswapV3SelectiveAssetGuard is UniswapV3AssetGuard, ISubPositionGuard {
    error InvalidPositionId();
    error PositionsNotAscending();
    error SubsetBadPortion();
    error SubsetToZero();
    error UnexpectedTransaction();

    function isSubPositionGuard() external pure override returns (bool) {
        return true;
    }

    function withdrawProcessingSubset(
        address pool,
        address asset,
        uint256 portion,
        address to,
        bytes32[] calldata positionIds
    ) external view override returns (address, uint256, IAssetGuard.MultiTransaction[] memory txs) {
        if (portion > 1e18) revert SubsetBadPortion();
        if (to == address(0)) revert SubsetToZero();
        _validateIds(pool, asset, positionIds);

        (, , MultiTransaction[] memory all) = this.withdrawProcessing(pool, asset, portion, to);

        txs = new IAssetGuard.MultiTransaction[](all.length);
        uint256 n;
        for (uint256 i; i < all.length; ++i) {
            bytes memory data = all[i].txData;
            if (all[i].to != asset || data.length < 36) revert UnexpectedTransaction();
            bytes4 selector = bytes4(data);
            if (
                selector != INonfungiblePositionManager.decreaseLiquidity.selector &&
                selector != INonfungiblePositionManager.collect.selector
            ) revert UnexpectedTransaction();

            uint256 tokenId;
            assembly {
                tokenId := mload(add(data, 36))
            }
            if (_isSelected(positionIds, tokenId)) {
                txs[n++] = IAssetGuard.MultiTransaction({ to: all[i].to, txData: data });
            }
        }
        assembly {
            mstore(txs, n)
        }
        return (address(0), 0, txs);
    }

    function _validateIds(
        address pool,
        address asset,
        bytes32[] calldata positionIds
    ) private view {
        address factory = IPoolLogic(pool).factory();
        uint256[] memory owned = UniswapV3NonfungiblePositionGuard(
            IHasGuardInfo(factory).getContractGuard(asset)
        ).getOwnedTokenIds(pool);

        for (uint256 i; i < positionIds.length; ++i) {
            if (i > 0 && positionIds[i] <= positionIds[i - 1]) revert PositionsNotAscending();
            bool found;
            for (uint256 j; j < owned.length; ++j) {
                if (bytes32(owned[j]) == positionIds[i]) {
                    found = true;
                    break;
                }
            }
            if (!found) revert InvalidPositionId();
        }
    }

    function _isSelected(
        bytes32[] calldata positionIds,
        uint256 tokenId
    ) private pure returns (bool) {
        for (uint256 i; i < positionIds.length; ++i) {
            if (uint256(positionIds[i]) == tokenId) return true;
        }
        return false;
    }
}
