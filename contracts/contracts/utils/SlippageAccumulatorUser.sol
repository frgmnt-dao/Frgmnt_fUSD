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
/// - No change to logic, storage layout or function signatures
/// - `intermediateSwapData` must be set by the inheriting guard during txGuard()
/// @custom:project Frgmnt
abstract contract SlippageAccumulatorUser is ITxTrackingGuard {
    /// @notice Required by ITxTrackingGuard, indicates this guard uses afterTxGuard.
    bool public override isTxTrackingGuard = true;

    /// @notice Reference to the global SlippageAccumulator contract.
    SlippageAccumulator internal immutable slippageAccumulator;

    /// @dev Temporary swap metadata stored by guards during txGuard() before calling afterTxGuard().
    /// @dev The dstAmount stored here BEFORE the swap is the *pre-swap* balance of the destination token.
    SlippageAccumulator.SwapData internal intermediateSwapData;

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

        // Compute actual swap deltas based on pre-stored vs post-swap balances
        slippageAccumulator.updateSlippageImpact(
            poolManagerLogic,
            to,
            SlippageAccumulator.SwapData({
                srcAsset: intermediateSwapData.srcAsset,
                dstAsset: intermediateSwapData.dstAsset,
                // srcAmountDelta = previousSrcBalance - currentSrcBalance
                srcAmount: intermediateSwapData.srcAmount -
                    _getBalance(intermediateSwapData.srcAsset, poolLogic),
                // dstAmountDelta = currentDstBalance - previousDstBalance
                dstAmount: _getBalance(intermediateSwapData.dstAsset, poolLogic) -
                    intermediateSwapData.dstAmount
            })
        );

        // Clear temporary storage
        intermediateSwapData = SlippageAccumulator.SwapData(address(0), address(0), 0, 0);
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
