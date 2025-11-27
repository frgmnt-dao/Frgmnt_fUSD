// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Frgmnt — IPoolManagerLogic
interface IPoolManagerLogic {
	function poolLogic() external view returns (address);

	function isDepositAsset(address asset) external view returns (bool);

	function validateAsset(address asset) external view returns (bool);

	function assetValue(address asset) external view returns (uint256);

	function assetValue(address asset, uint256 amount) external view returns (uint256);

	function assetBalance(address asset) external view returns (uint256 balance);

	function assetDecimal(address _asset) external view returns (uint256);

	function factory() external view returns (address);

	function setPoolLogic(address fundAddress) external returns (bool);

	function totalFundValue() external view returns (uint256);

	function isMemberAllowed(address member) external view returns (bool);

	function getFee() external view returns (uint256, uint256, uint256, uint256, uint256);

	function minDepositUSD() external view returns (uint256);

	function getAssetPrice(address _asset) external view returns (uint256);

	function getAssetType(address _asset) external view returns (uint16);

	function getAssetGuard(address _asset) external view returns (address);

	function getContractGuard(address _contract) external view returns (address);
}
