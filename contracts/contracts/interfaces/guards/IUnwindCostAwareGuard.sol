// SPDX-License-Identifier: MIT

pragma solidity ^0.8.24;

/// @title IUnwindCostAwareGuard
/// @notice Marker interface for asset guards whose getBalance() values a leveraged position as
///         gross collateral minus gross debt, without deducting what it actually costs to realize
///         that equity — flashloan premium, swap fees, slippage, rounding, and configured buffers
///         required by the guard's own unwind route (see FNA-35). A withdrawal sized from that
///         gross figure authorizes more value than the position can actually deliver once
///         unwound, at other holders' expense — most acutely for a queued withdrawal, which fixes
///         its payout once at finalize time without ever executing the unwind to verify it.
/// @dev getNetRealizableBalance() must use the same units/convention as this guard's own
///      getBalance() (e.g. USD-18 for a pre-valued guard), and must be conservative rather than
///      exact — this is a valuation-time estimate, not a real quote, so it should round in favor
///      of understating realizable value. Checked via a low-level staticcall, mirroring the
///      existing IPreValuedAssetGuard / IWithdrawableBalanceGuard / IIncompleteValuationGuard
///      marker pattern already used elsewhere in this codebase — a guard that doesn't implement
///      it is assumed to already report net-realizable value (today's behavior: getBalance() used
///      as-is). Applied to both computeImmediateWithdrawPortion()'s solvency-haircut NAV and
///      computeFinalizeAssetAmount()'s NAV identically: an immediate withdrawal's own real unwind
///      execution already self-corrects its final delivered amount, but the *haircut ratio* it's
///      computed from should still reflect true realizable NAV, not an inflated one.
interface IUnwindCostAwareGuard {
    function isUnwindCostAwareGuard() external pure returns (bool);

    function getNetRealizableBalance(address pool, address asset) external view returns (uint256);
}
