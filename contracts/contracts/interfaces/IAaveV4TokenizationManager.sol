// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Frgmnt — IAaveV4TokenizationManager
/// @notice Interface for the protocol-owned allowlist of Aave V4 TokenizationSpoke instances.
/// @dev Each TokenizationSpoke is its own ERC-4626 vault address (one per underlying asset),
///      so this mirrors IMorphoVaultV2Manager's (pool) -> address[] shape exactly.
interface IAaveV4TokenizationManager {
    /*//////////////////////////////////////////////////////////////
                                SETTER
    //////////////////////////////////////////////////////////////*/

    /// @notice Sets the TokenizationSpoke instances allowed for a pool.
    /// @dev Replaces the full list for `pool`; must match exactly the vaults the pool strategy
    ///      is meant to use. Omitting a previously-allowed vault revokes it.
    function setPoolVaults(address pool, address[] calldata vaults) external;

    /*//////////////////////////////////////////////////////////////
                                GETTERS
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns true if `vault` is allowed for `pool`.
    function isValidPoolVault(address pool, address vault) external view returns (bool);

    /// @notice Returns the list of TokenizationSpoke instances allowed for a pool.
    function getPoolVaults(address pool) external view returns (address[] memory);

    /// @notice Returns the number of TokenizationSpoke instances allowed for a pool.
    function getPoolVaultsLength(address pool) external view returns (uint256);
}
