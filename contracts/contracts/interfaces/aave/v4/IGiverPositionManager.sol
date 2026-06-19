// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Frgmnt — IGiverPositionManager (Aave V4)
/// @notice Minimal interface for Aave V4's GiverPositionManager — the singleton, shared entry
///         point for "giving" actions (supply, repay) across every Spoke and reserve.
/// @dev Giver actions never require the position owner's prior approval — anyone can top up a
///      position's supply or pay down its debt on behalf of another address.
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
