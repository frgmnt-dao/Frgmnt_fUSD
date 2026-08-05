// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Frgmnt — IGiverPositionManager (Aave V4)
/// @notice Minimal interface for Aave V4's GiverPositionManager — the singleton, shared entry
///         point for "giving" actions (supply, repay) across every Spoke and reserve.
/// @dev FNA-08: Giver actions DO require the position owner's prior approval — confirmed against
///      Aave V4's published source (github.com/aave/aave-v4, src/spoke/Spoke.sol, as of 2026-08):
///      `supply`/`repay` carry the same `onlyPositionManager(onBehalfOf)` modifier as every other
///      Spoke entry point, checked as `_isPositionManager({user: onBehalfOf, manager:
///      msg.sender})` — since GiverPositionManager itself is `msg.sender` from the Spoke's
///      perspective when it calls in on a pool's behalf, `onBehalfOf` (the pool) must have first
///      called `ISpoke.setUserPositionManager(giverPositionManager, true)` directly (msg.sender ==
///      the pool itself), or every Giver action reverts — including the very first supply into a
///      fresh pool. See AaveV4SpokeAssetGuard.txGuard for the guard that authorizes pools to make
///      that approval call.
interface IGiverPositionManager {
    /// @notice Supplies `amount` of `reserveId`'s underlying asset on behalf of `onBehalfOf`.
    /// @dev Pulls the underlying asset via transferFrom(msg.sender, ...) — msg.sender must have
    ///      approved this contract on the underlying token beforehand.
    /// @return suppliedShares Shares credited to `onBehalfOf`'s position.
    /// @return suppliedAmount Underlying asset amount actually supplied.
    function supplyOnBehalfOf(
        address spoke,
        uint256 reserveId,
        uint256 amount,
        address onBehalfOf
    ) external returns (uint256 suppliedShares, uint256 suppliedAmount);
}
