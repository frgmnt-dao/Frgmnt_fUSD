// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IUniswapV3Factory } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { CLPriceLibrary } from "./CLPriceLibrary.sol";

// library with helper methods for oracles that are concerned with computing average prices
library UniswapV3PriceLibrary {
    /// @notice Assets the v3 pool price for the assets given is within the threshold of oracle price
    /// @param dhedgeFactory dHEDGE Factory address
    /// @param uniswapV3Factory UniswapV3 Factory
    /// @param token0 Uni pool token0
    /// @param token1 Uni pool token1
    /// @param fee fee of the target pool
    /// @return sqrtPriceX96 square root price as a Q64.96
    function assertFairPrice(
        address dhedgeFactory,
        address uniswapV3Factory,
        address token0,
        address token1,
        uint24 fee
    ) internal view returns (uint160 sqrtPriceX96) {
        return
            assertFairPrice(
                dhedgeFactory,
                IUniswapV3Factory(uniswapV3Factory).getPool(token0, token1, fee),
                fee
            );
    }

    function assertFairPrice(
        address dhedgeFactory,
        address uniswapV3Pool,
        uint24 fee
    ) internal view returns (uint160 sqrtPriceX96) {
        IUniswapV3Pool uniPool = IUniswapV3Pool(uniswapV3Pool);
        (sqrtPriceX96, , , , , , ) = uniPool.slot0();

        // Get a fair sqrtPriceX96 from asset price oracles
        // We pass the tokens in the same order as the pool is configured
        uint160 fairSqrtPriceX96 = getFairSqrtPriceX96(
            dhedgeFactory,
            uniPool.token0(),
            uniPool.token1()
        );

        bool isPriceInRange = CLPriceLibrary.isSqrtPriceDeviationInRange(
            fee,
            sqrtPriceX96,
            fairSqrtPriceX96
        );

        require(isPriceInRange, "Uni v3 LP price mismatch");
    }

    /// @notice FNA-37: non-reverting counterpart to assertFairPrice(), for a valuation path that
    ///         must degrade a single out-of-band position rather than reverting the whole NAV
    ///         read. Deliberately a separate function rather than a shared internal with a
    ///         "revert or not" flag: assertFairPrice() guards manager transactions (minting/
    ///         increasing liquidity at a manipulated price), where reverting is exactly the
    ///         intended behavior and must not change.
    /// @return inRange Whether the pool's current spot price is within the Chainlink-derived fair
    ///         band for `fee`.
    /// @return sqrtPriceX96 The pool's current spot price, returned regardless of `inRange` so a
    ///         caller that wants it anyway (e.g. for logging) doesn't need a second slot0() call;
    ///         callers valuing a position MUST NOT use it unless `inRange` is true.
    function isFairPrice(
        address dhedgeFactory,
        address uniswapV3Factory,
        address token0,
        address token1,
        uint24 fee
    ) internal view returns (bool inRange, uint160 sqrtPriceX96) {
        return
            isFairPrice(
                dhedgeFactory,
                IUniswapV3Factory(uniswapV3Factory).getPool(token0, token1, fee),
                fee
            );
    }

    function isFairPrice(
        address dhedgeFactory,
        address uniswapV3Pool,
        uint24 fee
    ) internal view returns (bool inRange, uint160 sqrtPriceX96) {
        IUniswapV3Pool uniPool = IUniswapV3Pool(uniswapV3Pool);
        (sqrtPriceX96, , , , , , ) = uniPool.slot0();

        uint160 fairSqrtPriceX96 = getFairSqrtPriceX96(
            dhedgeFactory,
            uniPool.token0(),
            uniPool.token1()
        );

        inRange = CLPriceLibrary.isSqrtPriceDeviationInRange(fee, sqrtPriceX96, fairSqrtPriceX96);
    }

    /// @notice Returns the Uni pool square root price based on underlying oracle prices
    /// @dev note token0 and token1 must be in the same order as the uni pool we're comparing too
    /// @param factory dHEDGE Factory address
    /// @param token0 Uni pool token0
    /// @param token1 Uni pool token1
    /// @return sqrtPriceX96 square root price as a Q64.96
    function getFairSqrtPriceX96(
        address factory,
        address token0,
        address token1
    ) internal view returns (uint160 sqrtPriceX96) {
        sqrtPriceX96 = CLPriceLibrary.getFairSqrtPriceX96(factory, token0, token1);
    }

    /// @notice Returns the Uni pool square root price based on prices and token decimals
    /// @dev note token0 and token1 must be in the same order as the uni pool we're comparing too
    /// @param token0Price Chainlink Price of token0
    /// @param token1Price Chainlink Price of token1
    /// @param token0Decimals The erc20 tokens decimals
    /// @param token1Decimals The erc20 tokens decimals
    /// @return sqrtPriceX96 square root price as a Q64.96
    function calculateSqrtPrice(
        uint256 token0Price,
        uint256 token1Price,
        uint8 token0Decimals,
        uint8 token1Decimals
    ) internal pure returns (uint160 sqrtPriceX96) {
        sqrtPriceX96 = CLPriceLibrary.calculateSqrtPrice(
            token0Price,
            token1Price,
            token0Decimals,
            token1Decimals
        );
    }
}
