// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Frgmnt — IMorphoVaultV2Manager
/// @notice Interface for the protocol-owned allowlist of Morpho Vault V2 instances.
interface IMorphoVaultV2Manager {
    /*//////////////////////////////////////////////////////////////
                                SETTER
    //////////////////////////////////////////////////////////////*/

    /// @notice Sets the Morpho Vault V2 instances allowed for a pool.
    /// @dev Replaces the full list for `pool`; must match exactly the vaults the pool
    ///      strategy is meant to use. Omitting a previously-allowed vault revokes it.
    function setPoolVaults(address pool, address[] calldata vaults) external;

    /*//////////////////////////////////////////////////////////////
                                GETTERS
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns true if `vault` is allowed for `pool`.
    function isValidPoolVault(address pool, address vault) external view returns (bool);

    /// @notice Returns the list of Morpho Vault V2 instances allowed for a pool.
    function getPoolVaults(address pool) external view returns (address[] memory);

    /// @notice Returns the number of Morpho Vault V2 instances allowed for a pool.
    function getPoolVaultsLength(address pool) external view returns (uint256);

    /// @notice Returns every adapter registered on `vault`, alongside the `forceDeallocate`
    ///         penalty rate (WAD-scaled) configured for each one.
    /// @dev Read-only governance/tooling helper: lets the protocol owner review a candidate
    ///      vault's per-adapter griefing exposure before calling `setPoolVaults` to whitelist
    ///      it. Purely informational — does not gate or enforce anything on its own; the actual
    ///      penalty cap is enforced on-chain by the vault itself.
    function getVaultAdapterPenalties(
        address vault
    ) external view returns (address[] memory adapters, uint256[] memory penalties);
}
