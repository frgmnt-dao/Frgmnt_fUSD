// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IHasSupportedAsset } from "../interfaces/IHasSupportedAsset.sol";

contract MockAssetGuard {
	uint256 public dec;

	constructor(uint256 _dec) {
		dec = _dec;
	}

	// PoolManagerLogic checks for this via low-level call
	function isAddAssetCheckGuard() external pure returns (bool) {
		return true;
	}

	// Must match ABI: addAssetCheck(address,(address,bool))
	function addAssetCheck(address /*poolLogic*/, IHasSupportedAsset.Asset calldata /*asset*/) external {}

	// Used by PoolManagerLogic
	function getBalance(address /*poolLogic*/, address /*asset*/) external pure returns (uint256) {
		return 0;
	}
	function getDecimals(address /*asset*/) external view returns (uint256) {
		return dec;
	}
	function removeAssetCheck(address /*poolLogic*/, address /*asset*/) external pure {}
}
