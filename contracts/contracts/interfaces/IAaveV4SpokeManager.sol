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
    ///      strategy is meant to use. Omitting a previously-allowed reserveId revokes it.
    function setPoolReserves(address pool, address spoke, uint256[] calldata reserveIds) external;

    /*//////////////////////////////////////////////////////////////
                                GETTERS
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns true if `reserveId` on `spoke` is allowed for `pool`.
    function isValidPoolReserve(
        address pool,
        address spoke,
        uint256 reserveId
    ) external view returns (bool);

    /// @notice Returns the reserveIds allowed for a pool on a given Spoke.
    function getPoolReserves(address pool, address spoke) external view returns (uint256[] memory);

    /// @notice Returns the number of reserveIds allowed for a pool on a given Spoke.
    function getPoolReservesLength(address pool, address spoke) external view returns (uint256);
}
