// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockUniswapV3PositionGuard {
	mapping(address => uint256[]) private _ownedTokenIds;

	function setOwnedTokenIds(address pool, uint256[] calldata ids) external {
		_ownedTokenIds[pool] = ids;
	}

	function getOwnedTokenIds(address pool) external view returns (uint256[] memory) {
		return _ownedTokenIds[pool];
	}
}
