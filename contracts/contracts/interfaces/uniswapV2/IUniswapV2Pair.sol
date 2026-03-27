// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

/**
 * @title IUniswapV2Pair
 * @notice Minimal interface for interacting with a Uniswap V2 liquidity pair
 * @dev Used by Frgmnt contracts to read LP token data & interact with pair mechanics
 * @custom:project Frgmnt
 */
interface IUniswapV2Pair {
    /// @notice Returns the first token in the LP pair
    function token0() external view returns (address);

    /// @notice Returns the second token in the LP pair
    function token1() external view returns (address);

    /// @notice Returns the total LP token supply
    function totalSupply() external view returns (uint256);

    /// @notice Returns reserves for both tokens and the last timestamp updated
    function getReserves()
        external
        view
        returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);

    /// @notice Cumulative price for token0 (used for TWAP calculations)
    function price0CumulativeLast() external view returns (uint256);

    /// @notice Cumulative price for token1 (used for TWAP calculations)
    function price1CumulativeLast() external view returns (uint256);

    /**
     * @notice Burns LP tokens and returns underlying token amounts to `to`
     * @param to Recipient of the withdrawn reserves
     * @return amount0 Amount of token0 returned
     * @return amount1 Amount of token1 returned
     */
    function burn(address to) external returns (uint256 amount0, uint256 amount1);
}
