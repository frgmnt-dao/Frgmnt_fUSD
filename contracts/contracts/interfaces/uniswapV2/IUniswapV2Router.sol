// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IUniswapV2Router
 * @notice Minimal Uniswap V2 Router interface used by Frgmnt guards/adapters.
 * @custom:project Frgmnt
 */
interface IUniswapV2Router {
	/// @notice Returns the factory address associated with this router
	function factory() external pure returns (address);

	// solhint-disable-next-line func-name-mixedcase
	/// @notice Returns the wrapped native token (e.g., WETH)
	function WETH() external view returns (address);

	/// @notice Quote required input amounts for a desired output along a path
	function getAmountsIn(uint256 amountOut, address[] memory path) external view returns (uint256[] memory amounts);

	/// @notice Quote expected output amounts for a given input along a path
	function getAmountsOut(uint256 amountIn, address[] memory path) external view returns (uint256[] memory amounts);

	/// @notice Swap an exact amount of input tokens for a min amount of output tokens
	function swapExactTokensForTokens(
		uint256 amountIn,
		uint256 amountOutMin,
		address[] calldata path,
		address to,
		uint256 deadline
	) external returns (uint256[] memory amounts);

	/// @notice Swap tokens for an exact amount of output tokens, spending up to amountInMax
	function swapTokensForExactTokens(
		uint256 amountOut,
		uint256 amountInMax,
		address[] calldata path,
		address to,
		uint256 deadline
	) external returns (uint256[] memory amounts);

	/// @notice Add liquidity to a token pair
	function addLiquidity(
		address tokenA,
		address tokenB,
		uint256 amountADesired,
		uint256 amountBDesired,
		uint256 amountAMin,
		uint256 amountBMin,
		address to,
		uint256 deadline
	) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);

	/// @notice Remove liquidity from a token pair
	function removeLiquidity(
		address tokenA,
		address tokenB,
		uint256 liquidity,
		uint256 amountAMin,
		uint256 amountBMin,
		address to,
		uint256 deadline
	) external returns (uint256 amountA, uint256 amountB);
}
