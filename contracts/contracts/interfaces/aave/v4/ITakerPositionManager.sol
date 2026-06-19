// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Frgmnt — ITakerPositionManager (Aave V4)
/// @notice Minimal interface for Aave V4's TakerPositionManager — the singleton, shared entry
///         point for "taking" actions (withdraw, borrow) across every Spoke and reserve.
/// @dev Unlike Giver actions, Taker actions require the position owner's prior approval via
///      `approveWithdraw`/`approveBorrow` before anyone (including the owner acting as their own
///      spender) can withdraw or borrow on their behalf — there is no implicit self-approval.
///      CRITICAL: withdrawn funds are transferred to `msg.sender` (the caller), NOT to
///      `onBehalfOf` — `onBehalfOf` only identifies whose position is debited. This means the
///      `spender` approved via `approveWithdraw` is the address that actually receives withdrawn
///      funds when it later calls `withdrawOnBehalfOf`. See AaveV4SpokeContractGuard, which
///      enforces `spender == pool` unconditionally for exactly this reason.
interface ITakerPositionManager {
    /// @notice Grants `spender` an allowance to withdraw up to `amount` of `reserveId` on behalf
    ///         of the caller (the position owner).
    /// @dev `amount == type(uint256).max` is treated as an infinite allowance that never
    ///      decrements, mirroring standard ERC20 semantics.
    function approveWithdraw(
        address spoke,
        uint256 reserveId,
        address spender,
        uint256 amount
    ) external;

    /// @notice Withdraws `amount` of `reserveId`'s underlying asset from `onBehalfOf`'s position.
    /// @dev Requires the caller to hold a sufficient withdraw allowance from `onBehalfOf` for
    ///      this `(spoke, reserveId)`, set via `approveWithdraw`. Withdrawn funds are sent to
    ///      `msg.sender`, not to `onBehalfOf` — see the contract-level documentation above.
    /// @return withdrawnShares Shares debited from `onBehalfOf`'s position.
    /// @return withdrawnAmount Underlying asset amount actually withdrawn.
    function withdrawOnBehalfOf(
        address spoke,
        uint256 reserveId,
        uint256 amount,
        address onBehalfOf
    ) external returns (uint256 withdrawnShares, uint256 withdrawnAmount);
}
