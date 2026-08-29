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
    ///      strategy is meant to use. Omitting a previously-allowed vault revokes it from *new*
    ///      deposits only — see FNA-51 and trackedPoolVaults below.
    function setPoolVaults(address pool, address[] calldata vaults) external;

    /// @notice FNA-51: removes a delisted, fully-exited vault from trackedPoolVaults.
    /// @dev Permissionless — the on-chain zero-balance check is the real gate, not the caller.
    ///      Reverts unless the vault is currently tracked, no longer active
    ///      (isValidPoolVault == false — an active vault is never prunable, so a pool can never
    ///      lose exit coverage for a vault it may still deposit into), and its live pool-held
    ///      share balance is exactly zero.
    function pruneTrackedVault(address pool, address vault) external;

    /*//////////////////////////////////////////////////////////////
                                GETTERS
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns true if `vault` is allowed for *new* deposits by `pool`.
    function isValidPoolVault(address pool, address vault) external view returns (bool);

    /// @notice Returns the list of Morpho Vault V2 instances allowed for *new* deposits by a pool.
    function getPoolVaults(address pool) external view returns (address[] memory);

    /// @notice Returns the number of Morpho Vault V2 instances allowed for *new* deposits.
    function getPoolVaultsLength(address pool) external view returns (uint256);

    /// @notice FNA-51: returns true if `vault` must still be exitable/withdrawable for `pool`,
    ///         regardless of whether it remains in the *active* allowlist above.
    function isTrackedPoolVault(address pool, address vault) external view returns (bool);

    /// @notice FNA-51: returns every vault that must still be exitable/withdrawable for a pool —
    ///         a superset of getPoolVaults() that also includes vaults the protocol owner has
    ///         since delisted but that may still hold pool shares.
    /// @dev Unlike AaveV4SpokeManager (where one Spoke serves many reserveIds and its asset
    ///      guard must enumerate trackedPoolReserves to sum them), a Morpho Vault V2 instance IS
    ///      its own supportedAsset entry, so MorphoVaultV2AssetGuard.getBalance/
    ///      withdrawProcessing/removeAssetCheck read the pool's on-chain share balance directly
    ///      and never consult either allowlist. MorphoVaultV2ContractGuard's exit-side handlers
    ///      (manager-directed withdraw/redeem via execTransaction) are the actual consumer of
    ///      this set — they check membership here instead of getPoolVaults(), so delisting a
    ///      vault can never trap an existing position reachable only through that manual path.
    function getTrackedPoolVaults(address pool) external view returns (address[] memory);

    /// @notice Returns the number of vaults in getTrackedPoolVaults().
    function getTrackedPoolVaultsLength(address pool) external view returns (uint256);

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
