// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Full-featured mock for IPoolManagerLogic / IManaged / IHasSupportedAsset
/// implementing only what PoolLogic uses.
contract TestPoolManagerLogic {
	address public manager;
	address public trader;
	string public managerName;

	struct Fees {
		uint256 performance;
		uint256 management;
		uint256 entry;
		uint256 exit;
		uint256 denominator;
	}

	Fees public fees;

	uint256 private _totalFundValue;

	mapping(address => bool) public supportedAssets;
	mapping(address => uint256) public assetPrice; // price in 1e18 (FUSD units)
	mapping(address => uint8) public assetDecimals; // asset decimals
	mapping(address => address) public assetGuard;
	mapping(address => address) public contractGuard;

	address public pool; // optional reference (not used by PoolLogic, but handy in tests)

	constructor(address _manager, address _trader, string memory _managerName, address /* baseAsset */) {
		manager = _manager;
		trader = _trader;
		managerName = _managerName;
	}

	// ---- IManaged-like ----
	function managerNameFn() external view returns (string memory) {
		return managerName;
	}

	// ---- Fee config ----

	function setFees(
		uint256 performance,
		uint256 management,
		uint256 entry,
		uint256 exit,
		uint256 denominator
	) external {
		fees = Fees(performance, management, entry, exit, denominator);
	}

	function getFee()
		external
		view
		returns (uint256 performance, uint256 management, uint256 entry, uint256 exit, uint256 denominator)
	{
		return (fees.performance, fees.management, fees.entry, fees.exit, fees.denominator);
	}

	// ---- Fund value ----

	function totalFundValue() external view returns (uint256) {
		return _totalFundValue;
	}

	function setTotalFundValue(uint256 v) external {
		_totalFundValue = v;
	}

	// ---- Supported assets / pricing ----

	function isSupportedAsset(address asset) external view returns (bool) {
		return supportedAssets[asset];
	}

	function setSupportedAsset(address asset, bool isSupported, uint256 price, uint8 decimals_) external {
		supportedAssets[asset] = isSupported;
		assetPrice[asset] = price;
		assetDecimals[asset] = decimals_;
	}

	function getAssetPrice(address asset) external view returns (uint256) {
		return assetPrice[asset];
	}

	function assetDecimal(address asset) external view returns (uint256) {
		return assetDecimals[asset];
	}

	/// @notice Returns value in 1e18 FUSD units: amount * price / 10**decimals
	function assetValue(address asset, uint256 amount) external view returns (uint256) {
		uint256 price = assetPrice[asset];
		uint256 dec = assetDecimals[asset];
		if (price == 0 || amount == 0) return 0;

		return (amount * price) / (10 ** dec);
	}

	// ---- Guards ----

	function setAssetGuard(address asset, address guard) external {
		assetGuard[asset] = guard;
	}

	function getAssetGuard(address asset) external view returns (address) {
		return assetGuard[asset];
	}

	function setContractGuard(address target, address guard) external {
		contractGuard[target] = guard;
	}

	function getContractGuard(address target) external view returns (address) {
		return contractGuard[target];
	}

	// ---- Optional pool backref ----

	function setPool(address _pool) external {
		pool = _pool;
	}

	// ---- trader (used in PoolLogic access control) ----

	function traderFn() external view returns (address) {
		return trader;
	}
}
