// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Id } from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";

/// @title Interface for MorphoBlueManager
interface IMorphoBlueManager {
    /*//////////////////////////////////////////////////////////////
                                SETTER
    //////////////////////////////////////////////////////////////*/

    /// @notice Sets the Morpho markets allowed for a pool
    /// @dev Must match exactly the markets used by the pool strategies. Omitting a
    ///      previously-allowed marketId revokes it from *new* exposure only — see FNA-52 and
    ///      trackedPoolMarkets below.
    function setPoolMarkets(address pool, Id[] calldata markets) external;

    /// @notice FNA-52: removes a delisted, fully-exited market from trackedPoolMarkets.
    /// @dev Permissionless — the on-chain zero-position check is the real gate, not the caller.
    ///      Reverts unless the market is currently tracked, no longer active
    ///      (isValidPoolMarket == false — an active market is never prunable, so a pool can
    ///      never lose valuation/withdrawal coverage for a market it may still supply/borrow
    ///      into), and the pool's live position on the real Morpho Blue core contract (an
    ///      immutable fixed at deploy time — CertiK's FNA-52 follow-up removed the earlier
    ///      caller-supplied `morpho` parameter, which let anyone spoof an empty position via a
    ///      stub contract and untrack a market that still held a live one) in this market has
    ///      zero collateral, supply shares, and borrow shares.
    function pruneTrackedMarket(address pool, Id market) external;

    /*//////////////////////////////////////////////////////////////
                                GETTERS
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns true if the market is allowed for *new* exposure by the pool
    function isValidPoolMarket(address pool, Id market) external view returns (bool);

    /// @notice Returns the list of Morpho markets allowed for *new* exposure by a pool
    function getPoolMarkets(address pool) external view returns (Id[] memory);

    /// @notice Returns the number of Morpho markets allowed for *new* exposure
    function getPoolMarketsLength(address pool) external view returns (uint256);

    /// @notice FNA-52: returns true if `market` must still be valued/withdrawable for `pool`,
    ///         regardless of whether it remains in the *active* allowlist above.
    function isTrackedPoolMarket(address pool, Id market) external view returns (bool);

    /// @notice FNA-52: returns every market that must still be valued/withdrawable for a pool —
    ///         a superset of getPoolMarkets() that also includes markets the protocol owner has
    ///         since delisted but that may still hold pool supply/collateral/debt.
    ///         MorphoCollectLib's getBalance/getDeficit/collectDebts/collectSupplies/
    ///         collectCollaterals and MorphoChecksLib's removeAssetCheck/removeTokenCheck
    ///         enumerate THIS list, not getPoolMarkets(), so delisting a market can never drop
    ///         it out of valuation, out of debt/withdrawal planning, or let pool-level asset
    ///         removal proceed while it still holds an open position.
    function getTrackedPoolMarkets(address pool) external view returns (Id[] memory);

    /// @notice Returns the number of markets in getTrackedPoolMarkets().
    function getTrackedPoolMarketsLength(address pool) external view returns (uint256);
}
