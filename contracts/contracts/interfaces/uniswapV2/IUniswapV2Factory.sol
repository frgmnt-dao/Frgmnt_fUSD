// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IUniswapV2Factory
 * @notice Minimal interface for Uniswap V2 Factory — used to fetch LP pair addresses
 * @custom:project Frgmnt
 */
interface IUniswapV2Factory {
	/**
	 * @notice Returns the LP pair contract for a token pair, or address(0) if none exists
	 * @param tokenA First ERC20 token
	 * @param tokenB Second ERC20 token
	 * @return pair The address of the Uniswap V2 pair contract
	 */
	function getPair(address tokenA, address tokenB) external view returns (address pair);
}
