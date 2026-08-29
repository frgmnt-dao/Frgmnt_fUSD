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
    ///      is meant to use. Omitting a previously-allowed vault revokes it from *new* deposits
    ///      only — see FNA-51 and trackedPoolVaults below.
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

    /// @notice Returns the list of TokenizationSpoke instances allowed for *new* deposits.
    function getPoolVaults(address pool) external view returns (address[] memory);

    /// @notice Returns the number of TokenizationSpoke instances allowed for *new* deposits.
    function getPoolVaultsLength(address pool) external view returns (uint256);

    /// @notice FNA-51: returns true if `vault` must still be exitable/withdrawable for `pool`,
    ///         regardless of whether it remains in the *active* allowlist above.
    function isTrackedPoolVault(address pool, address vault) external view returns (bool);

    /// @notice FNA-51: returns every vault that must still be exitable/withdrawable for a pool —
    ///         a superset of getPoolVaults() that also includes vaults the protocol owner has
    ///         since delisted but that may still hold pool shares. Unlike AaveV4SpokeManager,
    ///         AaveV4TokenizationAssetGuard.getBalance/withdrawProcessing/removeAssetCheck do not
    ///         consult this set — each TokenizationSpoke IS its own supportedAsset entry, so
    ///         those read the pool's on-chain share balance directly. AaveV4TokenizationContract-
    ///         Guard's exit-side handlers are the actual consumer: they check membership here
    ///         instead of getPoolVaults(), so delisting a vault can never trap an existing
    ///         position reachable only through that manual execTransaction path.
    function getTrackedPoolVaults(address pool) external view returns (address[] memory);

    /// @notice Returns the number of vaults in getTrackedPoolVaults().
    function getTrackedPoolVaultsLength(address pool) external view returns (uint256);
}
