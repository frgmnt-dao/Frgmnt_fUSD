// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../utils/UniswapV3PriceLibrary.sol";
import "@uniswap/v3-periphery/contracts/libraries/LiquidityAmounts.sol";
import "@uniswap/v3-core/contracts/libraries/TickMath.sol";

/// @notice Wrapper exposing UniswapV3PriceLibrary functions for testing.
contract UniswapV3PriceLibraryTest {
    /// @notice SoftStack M-14 test helper: exposes the exact LiquidityAmounts/TickMath call
    ///         UniswapV3NonfungiblePositionGuard._checkMintLossWithinTolerance() uses, so a test
    ///         can precisely compute the fair-price-equivalent amounts for a chosen
    ///         liquidity/tick range and construct "actual consumption" relative to it.
    function getAmountsForLiquidityWrapper(
        uint160 sqrtRatioX96,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity
    ) external pure returns (uint256 amount0, uint256 amount1) {
        return
            LiquidityAmounts.getAmountsForLiquidity(
                sqrtRatioX96,
                TickMath.getSqrtRatioAtTick(tickLower),
                TickMath.getSqrtRatioAtTick(tickUpper),
                liquidity
            );
    }
    // Factory-based overload
    function assertFairPriceWithFactory(
        address dhedgeFactory,
        address uniswapV3Factory,
        address token0,
        address token1,
        uint24 fee
    ) external view returns (uint160 sqrtPriceX96) {
        return
            UniswapV3PriceLibrary.assertFairPrice(
                dhedgeFactory,
                uniswapV3Factory,
                token0,
                token1,
                fee
            );
    }

    // Pool-based overload
    function assertFairPriceWithPool(
        address dhedgeFactory,
        address uniswapV3Pool,
        uint24 fee
    ) external view returns (uint160 sqrtPriceX96) {
        return UniswapV3PriceLibrary.assertFairPrice(dhedgeFactory, uniswapV3Pool, fee);
    }

    function getFairSqrtPriceX96Wrapper(
        address dhedgeFactory,
        address token0,
        address token1
    ) external view returns (uint160) {
        return UniswapV3PriceLibrary.getFairSqrtPriceX96(dhedgeFactory, token0, token1);
    }

    function calculateSqrtPriceWrapper(
        uint256 token0Price,
        uint256 token1Price,
        uint8 token0Decimals,
        uint8 token1Decimals
    ) external pure returns (uint160) {
        return
            UniswapV3PriceLibrary.calculateSqrtPrice(
                token0Price,
                token1Price,
                token0Decimals,
                token1Decimals
            );
    }
}
