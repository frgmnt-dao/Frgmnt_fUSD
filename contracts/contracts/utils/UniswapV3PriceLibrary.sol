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
    /// @dev CertiK FNA-58: this used to return the pool's own spot sqrtPriceX96 (gated by
    ///      `inRange`) for the caller to value a position at. But the oracle value of a
    ///      concentrated position is convex in spot price with its minimum at the fair price, so
    ///      any in-band spot displacement raised the computed NAV in both directions — a
    ///      permissionless swap-harvest-reverse-swap round trip could crystallize that transient
    ///      gain as unbacked fUSD yield before the spot moved back. Now returns the
    ///      Chainlink-derived fair price instead, so the accepted spot band is purely a sanity
    ///      gate (skip a position whose pool has moved further than the band tolerates — see
    ///      FNA-37) and never itself becomes the accounting input. assertFairPrice() above is
    ///      unaffected: it still gates manager mint/increaseLiquidity calls against the pool's own
    ///      spot, which is the correct check for "will this transaction execute at a fair price."
    /// @return inRange Whether the pool's current spot price is within the Chainlink-derived fair
    ///         band for `fee`.
    /// @return fairSqrtPriceX96 The Chainlink-derived fair price, returned regardless of
    ///         `inRange` (a caller that only wants the fair price value itself, independent of
    ///         this specific pool's band check, doesn't need a second call) — callers valuing a
    ///         position MUST still skip it when `inRange` is false, since a pool this far out of
    ///         band may not hold the liquidity the fair-priced amounts assume.
    function isFairPrice(
        address dhedgeFactory,
        address uniswapV3Factory,
        address token0,
        address token1,
        uint24 fee
    ) internal view returns (bool inRange, uint160 fairSqrtPriceX96) {
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
    ) internal view returns (bool inRange, uint160 fairSqrtPriceX96) {
        IUniswapV3Pool uniPool = IUniswapV3Pool(uniswapV3Pool);
        (uint160 sqrtPriceX96, , , , , , ) = uniPool.slot0();

        fairSqrtPriceX96 = getFairSqrtPriceX96(dhedgeFactory, uniPool.token0(), uniPool.token1());

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
