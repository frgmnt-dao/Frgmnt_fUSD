// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Frgmnt — ITokenizationSpoke (Aave V4)
/// @notice Minimal interface for an Aave V4 TokenizationSpoke — an ERC-4626 vault that deposits
///         directly into a Liquidity Hub, bypassing the main lending Spoke entirely.
/// @dev Only the functions actually consumed by AaveV4TokenizationAssetGuard are declared here,
///      matching the same "minimal interface, only what we use" convention as ISpoke/IHubBase.
///      `hub()`/`assetId()` confirmed against Aave V4's published source
///      (github.com/aave/aave-v4, src/spoke/interfaces/ITokenizationSpoke.sol, as of 2026-09):
///      both are plain public view getters over immutable state set at construction — no raw
///      struct decoding needed here, unlike ISpoke.getReserve().
interface ITokenizationSpoke {
    /// @notice Returns the address of the Hub this TokenizationSpoke draws liquidity from.
    function hub() external view returns (address);

    /// @notice Returns this TokenizationSpoke's asset identifier within its Hub.
    function assetId() external view returns (uint256);
}
