// SPDX-License-Identifier: MIT

pragma solidity ^0.8.24;

/// @title IDeficitReportingGuard
/// @notice Marker interface for asset guards whose position can carry genuine negative economic
///         equity (debt exceeding collateral) that getBalance() cannot represent, since every
///         NAV consumer in this codebase sums non-negative uint256 balances. Without this,
///         getBalance() clamps an underwater position to zero — correctly excluding it from the
///         sum, but silently *omitting* its deficit rather than *subtracting* it, so the rest of
///         the pool's positive balances (including borrowed tokens the position itself produced)
///         are counted as if the debt did not exist (see FNA-54).
/// @dev getDeficit() must report the position's shortfall (debt minus collateral, floored at 0)
///      in the same units/convention as this guard's own getBalance() (e.g. USD-18 for a
///      pre-valued guard). Checked via a low-level staticcall, mirroring the existing
///      IPreValuedAssetGuard / IUnwindCostAwareGuard / IIncompleteValuationGuard marker pattern
///      already used elsewhere in this codebase — a guard that doesn't implement it is assumed
///      to never carry negative equity (correct for every other guard in this codebase, none of
///      which can go into debt). Every aggregate NAV consumer that sums supportedAssets'
///      balances (PoolManagerLogic.totalFundValue()/totalFundValueWithCompleteness(),
///      FundCalculationLibrary's withdrawal-sizing NAV) must sum every guard's reported deficit
///      alongside the gross positive sum and subtract it, floored at 0, so a shortfall on one
///      position reduces what the *rest* of the pool's positive balances are worth economically,
///      not just this one position's own contribution.
interface IDeficitReportingGuard {
    function isDeficitReportingGuard() external pure returns (bool);

    function getDeficit(address pool, address asset) external view returns (uint256 deficitUsd18);
}
