// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Frgmnt — IHubBase (Aave V4)
/// @notice Minimal interface for an Aave V4 Hub — the liquidity-management layer a Spoke draws
///         from/restores to (see ISpoke). Only the read function actually consumed by
///         AaveV4SpokeAssetGuard is declared here (FNA-07), matching the same "minimal interface,
///         only what we use" convention as ISpoke — see that file's own documentation for why.
/// @dev Confirmed against Aave V4's published source (github.com/aave/aave-v4,
///      src/hub/interfaces/IHubBase.sol).
interface IHubBase {
    /// @notice Returns the amount of available liquidity for the specified asset, in the asset's
    ///         own raw units (same units as ISpoke.getUserSuppliedAssets/getReserveSuppliedAssets).
    function getAssetLiquidity(uint256 assetId) external view returns (uint256);
}
