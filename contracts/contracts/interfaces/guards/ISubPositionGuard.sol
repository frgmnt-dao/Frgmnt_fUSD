// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAssetGuard } from "./IAssetGuard.sol";

/// @title ISubPositionGuard
/// @notice Optional capability for an asset guard that fronts several independent positions
///         behind one supported-asset address (a Morpho Blue singleton's markets, an Aave V4
///         Spoke's reserves, a Uniswap V3 position manager's NFTs, an Aave V3 pool's reserves) and
///         can withdraw from a chosen subset of them.
/// @dev Used only by the attested selective withdrawal path (WithdrawalPlanLib). A guard that
///      does not implement it is simply not selectable at position level: the plan is rejected
///      (fail closed) rather than silently widened to the whole asset. Implementations must:
///        - revert on any id that is not a currently-tracked position of `pool`;
///        - revert unless `positionIds` is strictly ascending (rules out duplicates);
///        - touch ONLY the listed positions, sizing every leg from `portion` of that position;
///        - never lower a safety check the guard's own withdrawProcessing() applies.
///      Position ids are guard-defined (Spoke: the reserveId; Morpho Blue: the market Id; Uniswap V3:
///      the NFT tokenId; Aave V3: the reserve's underlying token address). Guards whose positions can
///      carry debt must refuse selection while any debt exists (Aave V3, Morpho Blue).
interface ISubPositionGuard {
    function isSubPositionGuard() external view returns (bool);

    function withdrawProcessingSubset(
        address pool,
        address asset,
        uint256 portion,
        address to,
        bytes32[] calldata positionIds
    ) external view returns (address, uint256, IAssetGuard.MultiTransaction[] memory txs);
}
