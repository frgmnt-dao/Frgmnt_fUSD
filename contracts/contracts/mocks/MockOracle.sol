// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPriceOracleLike {
	function setPrice(address asset, uint256 priceUSD18) external;
	function getUSDPrice(address asset) external view returns (uint256 priceUSD18);
}

contract MockOracle is IPriceOracleLike {
	mapping(address => uint256) private _price;

	function setPrice(address asset, uint256 priceUSD18) external {
		_price[asset] = priceUSD18;
	}

	function getUSDPrice(address asset) external view returns (uint256) {
		uint256 p = _price[asset];
		require(p > 0, "Oracle: price not set");
		return p;
	}
}
