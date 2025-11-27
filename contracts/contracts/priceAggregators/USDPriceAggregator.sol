// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IAggregatorV3Interface.sol";

/**
 * @title Frgmnt USD Price Aggregator (Stub)
 * @notice Chainlink-compatible USD oracle that always returns $1.00.
 * @dev Implements `IAggregatorV3Interface.latestRoundData` and `decimals()`.
 *      - Decimals: 8 (standard Chainlink USD feeds)
 *      - Answer: 1 * 10^8
 * @custom:project Frgmnt
 */
contract USDPriceAggregator is IAggregatorV3Interface {
	/// @inheritdoc IAggregatorV3Interface
	function decimals() external pure override returns (uint8) {
		return 8;
	}

	/**
	 * @inheritdoc IAggregatorV3Interface
	 * @dev Returns a fixed $1.00 price with current block timestamp as `updatedAt`.
	 */
	function latestRoundData()
		external
		view
		override
		returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
	{
		return (0, int256(1e8), 0, block.timestamp, 0);
	}
}
