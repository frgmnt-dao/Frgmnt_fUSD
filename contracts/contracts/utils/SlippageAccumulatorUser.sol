// SPDX-License-Identifier: MIT

pragma solidity ^0.8.24;
pragma abicoder v2;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { IPoolManagerLogic } from "../interfaces/IPoolManagerLogic.sol";
import { ITxTrackingGuard } from "../interfaces/guards/ITxTrackingGuard.sol";

import { SlippageAccumulator } from "./SlippageAccumulator.sol";

/// @title Frgmnt SlippageAccumulator User Guard
/// @notice Abstract helper used by swap guards to track pre/post swap deltas
///         and forward slippage data to SlippageAccumulator.
/// @dev
/// - Upgraded from Solidity 0.7.6 to ^0.8.24
/// - SafeMath removed (0.8+ performs checked arithmetic)
/// - `intermediateSwapData` must be set by the inheriting guard during txGuard()
/// @dev FNA-47: this guard's `txGuard()`/`afterTxGuard()` auth check (`msg.sender ==
///      IPoolManagerLogic(poolManagerLogic).poolLogic()`) is satisfiable by anyone who supplies
///      their own self-referential `poolManagerLogic` — there is no trusted pool-registry lookup
///      anywhere in this codebase's guard layer. Before this fix, `intermediateSwapData` was a
///      single contract-level slot shared by every caller, so such an attacker-forged call (or a
///      malicious intermediate-hop token that briefly gets control mid-swap, since the multi-hop
///      path decoder only validates the first/last token) could overwrite the *real* pool's
///      pending snapshot before its own `afterTxGuard` read it back — masking a real loss (past
///      the deployed 5% cumulative-slippage bound) or forcing an arithmetic underflow that
///      reverts the honest pool's swap. Keying the snapshot by `msg.sender` instead closes this
///      structurally, without needing a pool registry or per-hop validation: `msg.sender` can
///      never be forged, so an attacker's own forged-`poolManagerLogic` call (or a malicious
///      hop's callback) only ever writes to *their own* mapping entry — it can never collide
///      with, be read by, or clear the real pool's entry, which is always keyed by the real
///      pool's own `poolLogic` address (the same value `msg.sender` is already checked against
///      everywhere this is written or read). This repo's EVM target is paris (pre-Cancun, see
///      FNA-24), ruling out transient storage as an alternative.
/// @custom:project Frgmnt
abstract contract SlippageAccumulatorUser is ITxTrackingGuard {
    /// @notice Required by ITxTrackingGuard, indicates this guard uses afterTxGuard.
    bool public override isTxTrackingGuard = true;

    /// @notice Reference to the global SlippageAccumulator contract.
    SlippageAccumulator internal immutable slippageAccumulator;

    /// @dev Temporary swap metadata stored by guards during txGuard() before calling
    ///      afterTxGuard(), keyed by the calling pool's own poolLogic address (msg.sender at
    ///      both write and read time — see FNA-47's own docs above for why).
    /// @dev The dstAmount stored here BEFORE the swap is the *pre-swap* balance of the destination token.
    mapping(address => SlippageAccumulator.SwapData) internal intermediateSwapData;

    /**
     * @notice Constructor
     * @param _slippageAccumulator The address of the main SlippageAccumulator contract.
     */
    constructor(address _slippageAccumulator) {
        require(_slippageAccumulator != address(0), "invalid address");
        slippageAccumulator = SlippageAccumulator(_slippageAccumulator);
    }

    /**
     * @notice Called AFTER the swap has executed.
     * @dev Requirements:
     *  - Must be called by poolLogic (verified through IPoolManagerLogic)
     *  - Computes src/dst deltas and updates SlippageAccumulator
     *  - Clears intermediateSwapData for safety
     *
     * @param poolManagerLogic The pool manager logic contract
     * @param to               The swap router or contract that executed the swap
     * @param data             Encoded tx data (unused here, kept to satisfy interface)
     */
    function afterTxGuard(
        address poolManagerLogic,
        address to,
        bytes memory data
    ) public virtual override {
        // silence unused-variable warning (we keep data for interface compatibility)
        data;

        address poolLogic = IPoolManagerLogic(poolManagerLogic).poolLogic();
        require(msg.sender == poolLogic, "not pool logic");

        // FNA-47: reads/clears this caller's own entry only — msg.sender is unforgeable, so no
        // other caller's write can ever land here or be read back by this one.
        SlippageAccumulator.SwapData memory pending = intermediateSwapData[msg.sender];

        // Compute actual swap deltas based on pre-stored vs post-swap balances
        slippageAccumulator.updateSlippageImpact(
            poolManagerLogic,
            to,
            SlippageAccumulator.SwapData({
                srcAsset: pending.srcAsset,
                dstAsset: pending.dstAsset,
                // srcAmountDelta = previousSrcBalance - currentSrcBalance
                srcAmount: pending.srcAmount - _getBalance(pending.srcAsset, poolLogic),
                // dstAmountDelta = currentDstBalance - previousDstBalance
                dstAmount: _getBalance(pending.dstAsset, poolLogic) - pending.dstAmount
            })
        );

        // Clear temporary storage
        delete intermediateSwapData[msg.sender];
    }

    /**
     * @notice Retrieves token or native ETH balance of an address.
     * @dev 1inch uses a sentinel ETH address (0xEeee…) — treated as `holder.balance`.
     */
    function _getBalance(address token, address holder) internal view returns (uint256) {
        // Handle native ETH sentinel address
        if (token == 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE) {
            return holder.balance;
        }
        return IERC20(token).balanceOf(holder);
    }
}
