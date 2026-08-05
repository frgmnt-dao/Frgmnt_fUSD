// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Frgmnt — ISpoke (Aave V4)
/// @notice Minimal interface for an Aave V4 Spoke — the user-facing, risk-isolated lending
///         module that draws/restores liquidity from a shared Liquidity Hub.
/// @dev Only the read functions actually consumed by AaveV4SpokeAssetGuard are declared here.
///      `Reserve`'s field order is confirmed against Aave V4's published source
///      (github.com/aave/aave-v4, src/spoke/interfaces/ISpoke.sol, as of 2026-08):
///      `{ address underlying; IHubBase hub; uint16 assetId; uint8 decimals;
///      uint24 collateralRisk; ReserveFlags flags; uint32 dynamicConfigKey; }`. All fields are
///      static value types, so `getReserve(uint256)`'s ABI-encoded return is a flat sequence of
///      32-byte words in that exact declaration order regardless of the struct's internal
///      storage packing. Rather than declare and decode the full struct here, the guard reads
///      just the first three words (`underlying`, `hub`, `assetId` — the ones it actually needs)
///      via a raw staticcall on `getReserve(uint256)`'s return data
///      (`_getReserveUnderlyingAndHub`), leaving the lower-confidence later fields (in particular
///      `flags`, whose bit layout isn't needed here) undecoded. See AaveV4SpokeAssetGuard for
///      that implementation.
interface ISpoke {
    /// @notice Returns the underlying asset amount currently supplied by `user` in `reserveId`.
    function getUserSuppliedAssets(uint256 reserveId, address user) external view returns (uint256);

    /// @notice Grants or revokes `positionManager`'s ability to act on `msg.sender`'s own
    ///         position (supply/withdraw/borrow/repay on `msg.sender`'s behalf).
    /// @dev FNA-08: every Spoke entry point (including Giver's supply/repay) is gated by
    ///      `onlyPositionManager(onBehalfOf)`, which — for any positionManager other than the
    ///      position owner itself — requires a prior call to this function made BY the position
    ///      owner (msg.sender here must be the pool). See AaveV4SpokeAssetGuard.txGuard.
    function setUserPositionManager(address positionManager, bool approve) external;
}
