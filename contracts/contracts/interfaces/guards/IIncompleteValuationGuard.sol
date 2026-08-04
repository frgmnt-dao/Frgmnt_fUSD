// SPDX-License-Identifier: MIT

pragma solidity ^0.8.24;

/// @title IIncompleteValuationGuard
/// @notice Marker interface for asset guards whose getBalance() can silently degrade to a value
///         lower than the position's true worth on a transient external failure (a broken price
///         feed, a reverting vault/protocol call, L2 sequencer downtime) rather than reverting —
///         a deliberate resilience choice so a single misbehaving position doesn't freeze
///         stake/unstake/harvest/withdraw for the entire pool (see each implementing guard's
///         getBalance() documentation).
/// @dev isValuationComplete() reports whether getBalance(), evaluated for this (pool, asset) at
///      the same block, would have taken one of those degrade paths. PoolManagerLogic checks this
///      marker via a low-level staticcall, mirroring the existing IPreValuedAssetGuard /
///      IAddAssetCheckGuard / ITxTrackingGuard pattern already used elsewhere in this codebase —
///      guards that don't implement it are treated as always complete (correct for every other
///      guard in this codebase, which either reverts on failure or has no external dependency
///      that can silently degrade a nonzero position to zero).
interface IIncompleteValuationGuard {
    function isIncompleteValuationGuard() external pure returns (bool);

    function isValuationComplete(address pool, address asset) external view returns (bool);
}
