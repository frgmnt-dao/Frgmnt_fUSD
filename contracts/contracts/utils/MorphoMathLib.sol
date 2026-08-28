// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20Extended } from "../interfaces/IERC20Extended.sol";
import { IHasAssetInfo } from "../interfaces/IHasAssetInfo.sol";

/// @title Morpho Blue Math & Oracle Helpers Library
/// @notice Reusable constants and helper functions for Frgmnt Morpho Blue integrations
library MorphoMathLib {
    /// @dev 100% = 10_000 bps
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    /// @dev 100% fee = 1,000,000
    uint256 internal constant FEE_DENOMINATOR = 1e6;

    /// @dev 100% withdraw/portion = 1e18
    uint256 internal constant PORTION_DENOMINATOR = 1e18;

    /*//////////////////////////////////////////////////////////////
                        ORACLE & MATH HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @notice Swaps tokens using Uniswap V3
    /// @dev Only **single-hop paths** are used for exactOutputSingle and exactInputSingle.
    /// Multi-hop exact-output paths (exactOutput with path array) are **not used** in this contract,
    /// so `_oracleMaxIn` and `_oracleMinOut` accounting for pool fee is sufficient for all swaps.

    function oracleMinOut(
        address factory,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 slippageBps,
        uint24 fee
    ) internal view returns (uint256) {
        uint256 pIn = IHasAssetInfo(factory).getAssetPrice(tokenIn);
        uint256 pOut = IHasAssetInfo(factory).getAssetPrice(tokenOut);
        uint256 uIn = 10 ** IERC20Extended(tokenIn).decimals();
        uint256 uOut = 10 ** IERC20Extended(tokenOut).decimals();

        uint256 usd = (amountIn * pIn) / uIn;
        uint256 out = (usd * uOut) / pOut;
        slippageBps = _effectiveSlippageExactIn(slippageBps, uint256(fee));

        return (out * (BPS_DENOMINATOR - slippageBps)) / BPS_DENOMINATOR;
    }

    function oracleMaxIn(
        address factory,
        address tokenIn,
        address tokenOut,
        uint256 amountOut,
        uint256 slippageBps,
        uint24 fee
    ) internal view returns (uint256) {
        uint256 pIn = IHasAssetInfo(factory).getAssetPrice(tokenIn);
        uint256 pOut = IHasAssetInfo(factory).getAssetPrice(tokenOut);
        uint256 uIn = 10 ** IERC20Extended(tokenIn).decimals();
        uint256 uOut = 10 ** IERC20Extended(tokenOut).decimals();

        uint256 usd = (amountOut * pOut) / uOut;
        uint256 inAmt = (usd * uIn) / pIn;
        slippageBps = _effectiveSlippageExactOut(slippageBps, uint256(fee));

        return (inAmt * (BPS_DENOMINATOR + slippageBps)) / BPS_DENOMINATOR;
    }

    /// @notice FNA-49: effective slippage bound for oracleMinOut (exact-input). The pool-fee
    ///         floor here is the direct fee fraction (fee / 1e6), not the exact-output gross-up
    ///         — receiving `out` after paying a `fee` cut on `usd` value costs `usd * fee`, not
    ///         `usd / (1 - fee)`. Composed (added) with the configured tolerance rather than
    ///         maxed against it, so the operator's own tolerance is never silently discarded by
    ///         a high-fee tier — the previous max()-based helper collapsed to just the fee floor
    ///         (~101bps at the 1% tier) whenever that floor exceeded the configured tolerance
    ///         (70bps by default), leaving ~1bps of real headroom on the forced settlement swap,
    ///         exactly where a legitimate settlement is most likely to revert.
    /// @param slippageBps Configured/requested slippage tolerance.
    /// @param fee Uniswap V3 pool fee (1e6 denominator).
    function _effectiveSlippageExactIn(
        uint256 slippageBps,
        uint256 fee
    ) internal pure returns (uint256) {
        uint256 feeBps = (fee * BPS_DENOMINATOR) / FEE_DENOMINATOR;
        return slippageBps + feeBps;
    }

    /// @notice FNA-49: effective slippage bound for oracleMaxIn (exact-output). The gross-up
    ///         form (fee / (1 - fee)) is correct here — receiving a fixed `out` after a `fee`
    ///         cut requires sending `out / (1 - fee)` in, not `out * (1 + fee)`. Composed
    ///         (added) with the configured tolerance rather than maxed against it — see
    ///         _effectiveSlippageExactIn's own docs for why.
    /// @param slippageBps Configured/requested slippage tolerance.
    /// @param fee Uniswap V3 pool fee (1e6 denominator).
    function _effectiveSlippageExactOut(
        uint256 slippageBps,
        uint256 fee
    ) internal pure returns (uint256) {
        uint256 feeGrossUpBps = (fee * BPS_DENOMINATOR) / (FEE_DENOMINATOR - fee);
        return slippageBps + feeGrossUpBps;
    }

    /// @notice Multiplies by a portion, rounding up
    function mulPortionRoundUp(uint256 x, uint256 p) internal pure returns (uint256) {
        return (x * p + PORTION_DENOMINATOR - 1) / PORTION_DENOMINATOR;
    }

    /// @notice Multiplies by a portion, rounding down
    function mulPortionRoundDown(uint256 x, uint256 p) internal pure returns (uint256) {
        return (x * p) / PORTION_DENOMINATOR;
    }
}
