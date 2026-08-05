// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Frgmnt — IAaveV4SpokeManager
/// @notice Interface for the protocol-owned allowlist of Aave V4 Spoke reserves.
/// @dev Keyed by (pool, spoke) rather than just (pool), because — unlike a Morpho Vault V2
///      instance or an Aave V4 TokenizationSpoke — a single Spoke address serves many reserves
///      (assets), each identified by a numeric reserveId rather than its own contract address.
interface IAaveV4SpokeManager {
    /*//////////////////////////////////////////////////////////////
                                SETTER
    //////////////////////////////////////////////////////////////*/

    /// @notice Sets the reserveIds allowed for a pool on a given Spoke.
    /// @dev Replaces the full list for `(pool, spoke)`; must match exactly the reserves the pool
    ///      strategy is meant to use. Omitting a previously-allowed reserveId revokes it from
    ///      *new* exposure only — see FNA-10 and trackedPoolReserves below.
    function setPoolReserves(address pool, address spoke, uint256[] calldata reserveIds) external;

    /// @notice FNA-10: removes a delisted, fully-exited reserve from trackedPoolReserves.
    /// @dev Permissionless — the on-chain zero-supply check is the real gate, not the caller.
    ///      Reverts unless the reserve is currently tracked, no longer active
    ///      (isValidPoolReserve == false — an active reserve is never prunable, so a pool can
    ///      never lose valuation/withdrawal coverage for a reserve it may still supply into), and
    ///      its live Spoke-side supplied balance is exactly zero.
    function pruneTrackedReserve(address pool, address spoke, uint256 reserveId) external;

    /*//////////////////////////////////////////////////////////////
                                GETTERS
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns true if `reserveId` on `spoke` is allowed for *new* supply by `pool`.
    function isValidPoolReserve(
        address pool,
        address spoke,
        uint256 reserveId
    ) external view returns (bool);

    /// @notice Returns the reserveIds currently allowed for *new* supply for a pool on a Spoke.
    function getPoolReserves(address pool, address spoke) external view returns (uint256[] memory);

    /// @notice Returns the number of reserveIds currently allowed for *new* supply.
    function getPoolReservesLength(address pool, address spoke) external view returns (uint256);

    /// @notice FNA-10: returns true if `reserveId` must still be valued/withdrawable for `pool`
    ///         on `spoke`, regardless of whether it remains in the *active* allowlist above.
    function isTrackedPoolReserve(
        address pool,
        address spoke,
        uint256 reserveId
    ) external view returns (bool);

    /// @notice FNA-10: returns every reserveId that must still be valued/withdrawable for a pool
    ///         on a Spoke — a superset of getPoolReserves() that also includes reserves the
    ///         protocol owner has since delisted but that may still hold pool supply.
    ///         AaveV4SpokeAssetGuard.getBalance/getWithdrawableBalance/withdrawProcessing/
    ///         removeAssetCheck enumerate THIS list, not getPoolReserves(), so delisting a
    ///         reserve can never drop it out of valuation or trap an existing position.
    function getTrackedPoolReserves(
        address pool,
        address spoke
    ) external view returns (uint256[] memory);

    /// @notice Returns the number of reserveIds in getTrackedPoolReserves().
    function getTrackedPoolReservesLength(address pool, address spoke) external view returns (uint256);
}
