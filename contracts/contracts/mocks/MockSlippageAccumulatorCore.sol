// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal mock of SlippageAccumulator used only by SlippageAccumulatorUser tests.
contract MockSlippageAccumulatorCore {
  struct SwapData {
    address srcAsset;
    address dstAsset;
    uint256 srcAmount;
    uint256 dstAmount;
  }

  event ImpactUpdated(
    address poolManagerLogic,
    address router,
    address srcAsset,
    address dstAsset,
    uint256 srcAmount,
    uint256 dstAmount
  );

  function updateSlippageImpact(
    address poolManagerLogic,
    address router,
    SwapData calldata swapData
  ) external {
    emit ImpactUpdated(
      poolManagerLogic,
      router,
      swapData.srcAsset,
      swapData.dstAsset,
      swapData.srcAmount,
      swapData.dstAmount
    );
  }
}
