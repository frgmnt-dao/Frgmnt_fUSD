// SPDX-License-Identifier: MIT

pragma solidity ^0.8.24;

/// @title IWithdrawableBalanceGuard
/// @notice Marker interface for asset guards whose getBalance() values a position's full claim
///         against an external protocol, which may exceed what is immediately redeemable right
///         now (e.g. a lending market where borrowers have drawn down the underlying) — see
///         FNA-07. A guard that implements this interface exposes the liquidity-capped amount
///         actually withdrawable this block, so PoolLogic's immediate pro-rata withdrawal can
///         size a position's share against real availability instead of asking the external
///         protocol for more than it can return and reverting the *entire* withdrawal (every
///         other, fully-liquid asset included) as a result.
/// @dev getWithdrawableBalance() must use the same units/convention as this guard's own
///      getBalance() (e.g. USD-18 for a pre-valued guard). PoolLogic checks this marker via a
///      low-level staticcall, mirroring the existing IPreValuedAssetGuard /
///      IIncompleteValuationGuard pattern already used elsewhere in this codebase — a guard that
///      doesn't implement it is assumed fully liquid (today's behavior: getBalance() used as-is).
///      This only affects the *immediate* withdrawal path's NAV/portion sizing
///      (PoolLogic._withdrawableFundValue()); the queued finalize path does not redeem positions
///      at finalize time and is unaffected.
interface IWithdrawableBalanceGuard {
    function isWithdrawableBalanceGuard() external pure returns (bool);

    function getWithdrawableBalance(address pool, address asset) external view returns (uint256);
}
