// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal Uniswap V3 pool mock used by UniswapV3PriceLibrary tests.
contract MockUniswapV3Pool {
	address private _token0;
	address private _token1;
	uint160 private _sqrtPriceX96;

	constructor(address token0_, address token1_, uint160 sqrtPriceX96_) {
		_token0 = token0_;
		_token1 = token1_;
		_sqrtPriceX96 = sqrtPriceX96_;
	}

	function token0() external view returns (address) {
		return _token0;
	}

	function token1() external view returns (address) {
		return _token1;
	}

	/// @notice Mimic Uniswap V3 slot0() signature.
	function slot0()
		external
		view
		returns (
			uint160 sqrtPriceX96,
			int24 tick,
			uint16 observationIndex,
			uint16 observationCardinality,
			uint16 observationCardinalityNext,
			uint8 feeProtocol,
			bool unlocked
		)
	{
		// We only care about sqrtPriceX96 for our tests, others can be zero.
		sqrtPriceX96 = _sqrtPriceX96;
		tick = 0;
		observationIndex = 0;
		observationCardinality = 0;
		observationCardinalityNext = 0;
		feeProtocol = 0;
		unlocked = true;
	}

	function setSqrtPriceX96(uint160 newSqrtPriceX96) external {
		_sqrtPriceX96 = newSqrtPriceX96;
	}
}
