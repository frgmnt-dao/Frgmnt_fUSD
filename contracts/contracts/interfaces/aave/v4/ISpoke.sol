// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Frgmnt — ISpoke (Aave V4)
/// @notice Minimal interface for an Aave V4 Spoke — the user-facing, risk-isolated lending
///         module that draws/restores liquidity from a shared Liquidity Hub.
/// @dev Only the read functions actually consumed by AaveV4SpokeAssetGuard are declared here.
///      The Spoke's `Reserve` struct has at least one field (`flags`) whose exact encoded shape
///      could not be confirmed against the live deployed ABI at design time. Rather than declare
///      and decode the full struct here (which would silently return wrong data — not revert —
///      if any field's layout were mis-specified), `getReserveUnderlying()` below is implemented
///      by the guard via a raw staticcall that reads only the first 32-byte word of
///      `getReserve(uint256)`'s return data. `underlying` is confirmed to be the first field of
///      the Reserve struct, so this is correct regardless of how later fields are actually laid
///      out. See AaveV4SpokeAssetGuard for that implementation.
interface ISpoke {
    /// @notice Returns the underlying asset amount currently supplied by `user` in `reserveId`.
    function getUserSuppliedAssets(uint256 reserveId, address user) external view returns (uint256);
}
