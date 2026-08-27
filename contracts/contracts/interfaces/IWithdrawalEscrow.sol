// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Frgmnt — IWithdrawalEscrow
interface IWithdrawalEscrow {
    /// @notice The single PoolLogic instance this escrow is dedicated to.
    function pool() external view returns (address);

    /// @notice Pulls `amount` of `asset` from the bound pool into escrow. Callable only by
    ///         that pool, which must have approved this contract for at least `amount` first.
    function reserve(address asset, uint256 amount) external;

    /// @notice Releases `amount` of `asset` held in escrow directly to `recipient`. Callable
    ///         only by the bound pool.
    /// @return delivered What `recipient`'s own balance actually increased by (can be less
    ///         than `amount` for a recipient-fee asset).
    function release(
        address asset,
        uint256 amount,
        address recipient
    ) external returns (uint256 delivered);
}
