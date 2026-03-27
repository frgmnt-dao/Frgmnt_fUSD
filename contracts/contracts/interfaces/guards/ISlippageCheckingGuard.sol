// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ISlippageCheckingGuard
 * @notice Interface for guards that verify slippage on trades/actions.
 * @custom:project Frgmnt
 */
interface ISlippageCheckingGuard {
    /**
     * @return True if this guard enforces slippage checks
     */
    function isSlippageCheckingGuard() external view returns (bool);
}
