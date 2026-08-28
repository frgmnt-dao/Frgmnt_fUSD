// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../utils/SlippageAccumulatorUser.sol";
import "../utils/SlippageAccumulator.sol";

/// @notice Concrete helper to test SlippageAccumulatorUser behaviour.
contract MockSlippageAccumulatorUser is SlippageAccumulatorUser {
    constructor(address accumulator) SlippageAccumulatorUser(accumulator) {}

    /// @notice Dummy txGuard implementation to satisfy IGuard / ITxTrackingGuard.
    /// @dev Not used in these tests, just returns zeros.
    function txGuard(
        address /* poolManagerLogic */,
        address /* to */,
        bytes calldata /* data */
    ) external override returns (uint16 txType, bool isPublic) {
        return (0, false);
    }

    /// @notice Allow tests to seed intermediateSwapData for a given caller before calling
    ///         afterTxGuard() as that same caller — FNA-47: keyed by caller, not a shared slot.
    function setIntermediateSwapData(
        address caller,
        address srcAsset,
        address dstAsset,
        uint256 srcAmount,
        uint256 dstAmount
    ) external {
        intermediateSwapData[caller] = SlippageAccumulator.SwapData({
            srcAsset: srcAsset,
            dstAsset: dstAsset,
            srcAmount: srcAmount,
            dstAmount: dstAmount
        });
    }

    /// @notice Exposes internal storage for assertions.
    function getIntermediateSwapData(
        address caller
    ) external view returns (SlippageAccumulator.SwapData memory) {
        return intermediateSwapData[caller];
    }

    /// @notice Exposes internal _getBalance for unit tests.
    function exposedGetBalance(address token, address holder) external view returns (uint256) {
        return _getBalance(token, holder);
    }
}
