// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { ERC721Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";

import { IPoolLogic } from "./interfaces/IPoolLogic.sol";
import { IPoolManagerLogic } from "./interfaces/IPoolManagerLogic.sol";
import { IHasSupportedAsset } from "./interfaces/IHasSupportedAsset.sol";
import { IAssetGuard } from "./interfaces/guards/IAssetGuard.sol";
import { IAddAssetCheckGuard } from "./interfaces/guards/IAddAssetCheckGuard.sol";
import { IAssetHandler } from "./interfaces/IAssetHandler.sol";
import { Managed } from "./Managed.sol";

contract PoolManagerLogic is Initializable, IPoolManagerLogic, IHasSupportedAsset, Managed {
	event AssetAdded(address indexed fundAddress, address manager, address asset, bool isDeposit);
	event AssetRemoved(address fundAddress, address manager, address asset);
	event ManagerFeeSet(
		address fundAddress,
		address manager,
		uint256 performanceFeeNumerator,
		uint256 managerFeeNumerator,
		uint256 entryFeeNumerator,
		uint256 exitFeeNumerator,
		uint256 denominator
	);
	event ManagerFeeIncreaseAnnounced(
		uint256 performanceFeeNumerator,
		uint256 managerFeeNumerator,
		uint256 entryFeeNumerator,
		uint256 exitFeeNumerator,
		uint256 announcedFeeActivationTime
	);
	event ManagerFeeIncreaseRenounced();
	event PoolLogicSet(address poolLogic, address from);
	event MinDepositUpdated(uint256 minDepositUSD);

	// FRG-24: Events for access-control / governance state changes
	event ContractGuardSet(address indexed contractAddress, address indexed guard);
	event AssetGuardSet(address indexed asset, address indexed guard);
	event PoolStatusSet(address indexed pool, bool value);
	event FactoryOwnerUpdated(address indexed previousOwner, address indexed newOwner);
	event AssetHandlerUpdated(address indexed previousAssetHandler, address indexed newAssetHandler);
	event FactoryConfigUpdated(
		uint256 maximumSupportedAssetCount,
		uint256 maxPerf,
		uint256 maxMgr,
		uint256 maxEntry,
		uint256 maxExit,
		uint256 feeDenominator,
		uint256 maxPerfChange,
		uint256 perfChangeDelay
	);
	event TraderAssetChangeDisabledSet(bool disabled);
	event NftMembershipCollectionAddressSet(address indexed previous, address indexed current);
	event PoolPrivacyUpdated(bool isPoolPrivate);
	event AllowedCallbackSenderSet(address indexed caller, bool allowed);
    event ManagerFeeIncreaseCommitted(uint256 performanceFeeNumerator,
    uint256 managerFeeNumerator,
    uint256 entryFeeNumerator,
    uint256 exitFeeNumerator);

	// Core
	address public override poolLogic;

	Asset[] public supportedAssets;
	mapping(address => uint256) public assetPosition;
	mapping(address => bool) private allowedCallbackSenders; 

	uint256 public announcedPerformanceFeeNumerator;
	uint256 public announcedFeeIncreaseTimestamp;
	uint256 public performanceFeeNumerator;
	uint256 public announcedManagerFeeNumerator;
	uint256 public managerFeeNumerator;

	address public nftMembershipCollectionAddress;

	uint256 public announcedEntryFeeNumerator;
	uint256 public entryFeeNumerator;
	uint256 public announcedExitFeeNumerator;
	uint256 public exitFeeNumerator;

	bool public traderAssetChangeDisabled;
	bool public privatePool;

	// Governance
	address public factoryOwner;

	// Asset info
	uint256 private _maximumSupportedAssetCount;

	// Guards (Option 3)
	mapping(address => address) private _assetGuard;
	mapping(address => address) private _contractGuard;

	// Fee caps
	uint256 private _maximumPerformanceFeeNumerator;
	uint256 private _maximumManagerFeeNumerator;
	uint256 private _maximumEntryFeeNumerator;
	uint256 private _maximumExitFeeNumerator;
	uint256 private _managerFeeDenominator;
	uint256 private _maximumPerformanceFeeNumeratorChange;
	uint256 private _performanceFeeNumeratorChangeDelay;

	mapping(address => bool) private _isPool;

	address public assetHandler;

	uint256[20] private __gap;

	error InvalidFactory();
	error InvalidPoolLogic();
	error CannotAddPoolAsset();
	error InvalidAsset();
	error AssetNotSupported();

	modifier onlyFactoryOwner() {
		require(msg.sender == factoryOwner, "only factoryOwner allowed");
		_;
	}

	function initialize(
		address _factoryOwner,
		address _manager,
		string calldata _managerName,
		address _poolLogic,
		address _assetHandler,
		uint256 _performanceFeeNumerator,
		uint256 _managerFeeNumerator
	) external initializer {
		if (_factoryOwner == address(0)) revert InvalidFactory();
		if (_manager == address(0)) revert InvalidManager();
		if (_poolLogic == address(0)) revert InvalidPoolLogic();
		_initialize(_manager, _managerName);
		factoryOwner = _factoryOwner;
		poolLogic = _poolLogic;
		require(_assetHandler != address(0), "invalid assetHandler");
		assetHandler = _assetHandler;
		_setFactoryConfig(50, 5000, 300, 100, 100, 10000, 0, 3 days); // Default factory config
		_setFeeNumerator(_performanceFeeNumerator, _managerFeeNumerator, 0, 0);
	}

	// -----------------------------------------------------------------------
	// Factory-compatible view
	// -----------------------------------------------------------------------

	function factory() external view override returns (address) {
		return address(this);
	}

	function getMaximumSupportedAssetCount() external view returns (uint256) {
		return _maximumSupportedAssetCount;
	}

	/// @notice Return the latest price of a given asset
	/// @param _asset The address of the asset
	/// @return price The latest price of a given asset
	function getAssetPrice(address _asset) external view override returns (uint256 price) {
		price = IAssetHandler(assetHandler).getUSDPrice(_asset);
	}

	/// @notice Return type of the asset
	/// @param _asset The address of the asset
	/// @return assetType The type of the asset
	function getAssetType(address _asset) external view override returns (uint16 assetType) {
		assetType = IAssetHandler(assetHandler).assetTypes(_asset);
	}

	function getAssetGuard(address _asset) external view returns (address) {
		return _assetGuard[_asset];
	}

	// NEW FOR OPTION 3
	function getContractGuard(address _contract) external view returns (address) {
		return _contractGuard[_contract];
	}

	function setContractGuard(address _contract, address _guard) external onlyFactoryOwner {
		require(_contract != address(0), "Frgmnt: invalid contract");
		require(_guard != address(0), "Frgmnt: invalid _guard");
		_contractGuard[_contract] = _guard;
		emit ContractGuardSet(_contract, _guard);
	}

	function getMaximumFee() public view returns (uint256, uint256, uint256, uint256, uint256) {
		return (
			_maximumPerformanceFeeNumerator,
			_maximumManagerFeeNumerator,
			_maximumEntryFeeNumerator,
			_maximumExitFeeNumerator,
			_managerFeeDenominator
		);
	}

	function owner() external view returns (address) {
		return factoryOwner;
	}

	function isPool(address _pool) external view returns (bool) {
		return _isPool[_pool];
	}

	// -----------------------------------------------------------------------
	// Admin config
	// -----------------------------------------------------------------------

	function setFactoryConfig(
		uint256 maximumSupportedAssetCount_,
		uint256 maxPerf_,
		uint256 maxMgr_,
		uint256 maxEntry_,
		uint256 maxExit_,
		uint256 feeDenominator_,
		uint256 maxPerfChange_,
		uint256 perfChangeDelay_
	) external onlyFactoryOwner {
		_setFactoryConfig(
			maximumSupportedAssetCount_,
			maxPerf_,
			maxMgr_,
			maxEntry_,
			maxExit_,
			feeDenominator_,
			maxPerfChange_,
			perfChangeDelay_
		);

		emit FactoryConfigUpdated(
			maximumSupportedAssetCount_,
			maxPerf_,
			maxMgr_,
			maxEntry_,
			maxExit_,
			feeDenominator_,
			maxPerfChange_,
			perfChangeDelay_
		);
	}

	function _setFactoryConfig(
		uint256 maximumSupportedAssetCount_,
		uint256 maxPerf_,
		uint256 maxMgr_,
		uint256 maxEntry_,
		uint256 maxExit_,
		uint256 feeDenominator_,
		uint256 maxPerfChange_,
		uint256 perfChangeDelay_
	) internal {
		_maximumSupportedAssetCount = maximumSupportedAssetCount_;
		_maximumPerformanceFeeNumerator = maxPerf_;
		_maximumManagerFeeNumerator = maxMgr_;
		_maximumEntryFeeNumerator = maxEntry_;
		_maximumExitFeeNumerator = maxExit_;
		_managerFeeDenominator = feeDenominator_;
		_maximumPerformanceFeeNumeratorChange = maxPerfChange_;
		_performanceFeeNumeratorChangeDelay = perfChangeDelay_;
	}

	function setAssetGuard(address _asset, address _guard) external onlyFactoryOwner {
		require(_guard != address(0), "Frgmnt: invalid _guard");
		_assetGuard[_asset] = _guard;
		emit AssetGuardSet(_asset, _guard);
	}

	function setIsPool(address _pool, bool value) external onlyFactoryOwner {
		_isPool[_pool] = value;
		emit PoolStatusSet(_pool, value);
	}

	function setFactoryOwner(address _newOwner) external onlyFactoryOwner {
		require(_newOwner != address(0), "zero owner");
		address previousOwner = factoryOwner;
		factoryOwner = _newOwner;
		emit FactoryOwnerUpdated(previousOwner, _newOwner);
	}

	function setAssetHandler(address _assetHandler) external onlyFactoryOwner {
		require(_assetHandler != address(0), "invalid assetHandler");
		address previousAssetHandler = assetHandler;
		assetHandler = _assetHandler;
		emit AssetHandlerUpdated(previousAssetHandler, _assetHandler);
	}

	// -----------------------------------------------------------------------
	// Supported assets
	// -----------------------------------------------------------------------

	function isSupportedAsset(address _asset) public view override returns (bool) {
		return assetPosition[_asset] != 0;
	}

	function isDepositAsset(address _asset) external view override returns (bool) {
		uint256 index = assetPosition[_asset];
		return index != 0 && supportedAssets[index - 1].isDeposit;
	}

	/// @notice Return boolean if the asset is supported
	/// @param _asset The address of the asset
	/// @return True if it's valid asset, false otherwise
	function validateAsset(address _asset) public view override returns (bool) {
		return _isValidAsset(_asset);
	}

	function _isValidAsset(address _asset) internal view returns (bool) {
		return IAssetHandler(assetHandler).priceAggregators(_asset) != address(0);
	}

	function changeAssets(Asset[] calldata _addAssets, address[] calldata _removeAssets) external {
		require(
			(msg.sender == trader && !traderAssetChangeDisabled) || msg.sender == manager || msg.sender == factoryOwner,
			"only manager, owner or trader"
		);

		_changeAssets(_addAssets, _removeAssets);
	}

	function _changeAssets(Asset[] calldata _addAssets, address[] memory _removeAssets) internal {
		// REMOVE
		for (uint256 i; i < _removeAssets.length; ++i) {
			_removeAsset(_removeAssets[i]);
		}

		// ADD
		for (uint256 i; i < _addAssets.length; ++i) {
			_addAsset(_addAssets[i]);
		}

		if (_maximumSupportedAssetCount != 0)
			require(supportedAssets.length <= _maximumSupportedAssetCount, "max assets reached");

		require(getDepositAssets().length >= 1, "at least one deposit asset");
	}

	function _addAsset(Asset calldata _asset) internal {
		address asset = _asset.asset;
		bool isDeposit = _asset.isDeposit;

		if (!validateAsset(asset)) revert InvalidAsset();

		if (_isPool[asset]) revert CannotAddPoolAsset();

		address guard = _assetGuard[asset];
		if (guard != address(0)) {
			(bool hasFn, bytes memory data) = guard.staticcall(abi.encodeWithSignature("isAddAssetCheckGuard()"));
			if (hasFn && abi.decode(data, (bool))) {
				IAddAssetCheckGuard(guard).addAssetCheck(poolLogic, _asset);
			}
		}

		if (isSupportedAsset(asset)) {
			uint256 idx = assetPosition[asset] - 1;
			supportedAssets[idx].isDeposit = isDeposit;
		} else {
			uint256 len = supportedAssets.length;
			supportedAssets.push(_asset);
			assetPosition[asset] = len + 1;

			uint16 atype = IAssetHandler(assetHandler).assetTypes(asset);

			// insertion-sort step
			while (len > 0 && IAssetHandler(assetHandler).assetTypes(supportedAssets[len - 1].asset) < atype) {
				Asset memory tmp = supportedAssets[len];
				supportedAssets[len] = supportedAssets[len - 1];
				assetPosition[supportedAssets[len].asset] = len + 1;

				supportedAssets[len - 1] = tmp;
				assetPosition[supportedAssets[len - 1].asset] = len;

				--len;
			}
		}

		emit AssetAdded(poolLogic, manager, asset, isDeposit);
	}

	function _removeAsset(address _asset) internal {
		if (!isSupportedAsset(_asset)) revert AssetNotSupported();

		address guard = _assetGuard[_asset];
		if (guard != address(0)) {
			// Don't rely on on-chain wallet balance as a safe-removal condition.
            // Let the guard decide using protocol-aware checks (including external positions).
			IAssetGuard(guard).removeAssetCheck(poolLogic, _asset);
		}

		uint256 idx = assetPosition[_asset] - 1;
		uint256 len = supportedAssets.length;

		for (uint256 i = idx; i + 1 < len; ++i) {
			supportedAssets[i] = supportedAssets[i + 1];
			assetPosition[supportedAssets[i].asset] = i + 1;
		}

		assetPosition[_asset] = 0;
		supportedAssets.pop();

		emit AssetRemoved(poolLogic, manager, _asset);
	}

	// NEW FUNCTION ADDED FOR FRG-22 (governance escape hatch)
	function forceRemoveAsset(address _asset) external onlyFactoryOwner {
		if (!isSupportedAsset(_asset)) revert AssetNotSupported();

		uint256 idx = assetPosition[_asset] - 1;
		uint256 len = supportedAssets.length;

		for (uint256 i = idx; i + 1 < len; ++i) {
			supportedAssets[i] = supportedAssets[i + 1];
			assetPosition[supportedAssets[i].asset] = i + 1;
		}

		assetPosition[_asset] = 0;
		supportedAssets.pop();

		emit AssetRemoved(poolLogic, manager, _asset);
	}

	function getSupportedAssets() external view override returns (Asset[] memory) {
		return supportedAssets;
	}

	function getDepositAssets() public view returns (address[] memory arr) {
		uint256 len = supportedAssets.length;
		arr = new address[](len);
		uint256 count = 0;

		for (uint256 i; i < len; ++i) {
			if (supportedAssets[i].isDeposit) {
				arr[count] = supportedAssets[i].asset;
				++count;
			}
		}

		assembly {
			mstore(arr, count)
		}
	}

	// -----------------------------------------------------------------------
	// Asset valuation
	// -----------------------------------------------------------------------

	function assetBalance(address _asset) public view override returns (uint256) {
		address guard = _assetGuard[_asset];
		if (guard == address(0)) return 0;
		return IAssetGuard(guard).getBalance(poolLogic, _asset);
	}

	function assetDecimal(address _asset) public view returns (uint256) {
		address guard = _assetGuard[_asset];
		require(guard != address(0), "no guard");
		return IAssetGuard(guard).getDecimals(_asset);
	}

	function assetValue(address _asset, uint256 _amount) public view override returns (uint256) {
		uint256 price = IAssetHandler(assetHandler).getUSDPrice(_asset);
		if (price == 0 || _amount == 0) return 0;

		uint256 decimals = assetDecimal(_asset);
		return (price * _amount) / (10 ** decimals);
	}

	function assetValue(address _asset) public view override returns (uint256) {
		return assetValue(_asset, assetBalance(_asset));
	}

	function totalFundValue() external view override returns (uint256 total) {
		uint256 len = supportedAssets.length;
		for (uint256 i; i < len; ++i) {
			total += assetValue(supportedAssets[i].asset);
		}
	}

	// -----------------------------------------------------------------------
	// Fees
	// -----------------------------------------------------------------------

	function getFee() external view override returns (uint256, uint256, uint256, uint256, uint256) {
		return (
			performanceFeeNumerator,
			managerFeeNumerator,
			entryFeeNumerator,
			exitFeeNumerator,
			_managerFeeDenominator
		);
	}

	function getMaximumPerformanceFeeChange() public view returns (uint256 change) {
		return _maximumPerformanceFeeNumeratorChange;
	}

	function setFeeNumerator(uint256 _perf, uint256 _mgr, uint256 _entry, uint256 _exit) external onlyManager {
		require(
			_perf <= performanceFeeNumerator &&
				_mgr <= managerFeeNumerator &&
				_entry <= entryFeeNumerator &&
				_exit <= exitFeeNumerator,
			"manager fee too high"
		);

		_setFeeNumerator(_perf, _mgr, _entry, _exit);
	}

	function _setFeeNumerator(uint256 _perf, uint256 _mgr, uint256 _entry, uint256 _exit) internal {
		(uint256 maxPerf, uint256 maxMgr, uint256 maxEntry, uint256 maxExit, uint256 denom) = getMaximumFee();

		require(_perf <= maxPerf && _mgr <= maxMgr && _entry <= maxEntry && _exit <= maxExit, "invalid manager fee");

		performanceFeeNumerator = _perf;
		managerFeeNumerator = _mgr;
		entryFeeNumerator = _entry;
		exitFeeNumerator = _exit;

		emit ManagerFeeSet(poolLogic, manager, _perf, _mgr, _entry, _exit, denom);
	}

	function announceFeeIncrease(uint256 _perf, uint256 _mgr, uint256 _entry, uint256 _exit) external onlyManager {
		(uint256 maxPerf, uint256 maxMgr, uint256 maxEntry, uint256 maxExit, ) = getMaximumFee();

		uint256 maxAllowedChange = getMaximumPerformanceFeeChange();

		require(
			_perf <= maxPerf &&
				_mgr <= maxMgr &&
				_entry <= maxEntry &&
				_exit <= maxExit &&
				_perf <= performanceFeeNumerator + maxAllowedChange,
			"exceeded allowed increase"
		);

		uint256 delay = _performanceFeeNumeratorChangeDelay;

		announcedPerformanceFeeNumerator = _perf;
		announcedManagerFeeNumerator = _mgr;
		announcedEntryFeeNumerator = _entry;
		announcedExitFeeNumerator = _exit;
		announcedFeeIncreaseTimestamp = block.timestamp + delay;

		emit ManagerFeeIncreaseAnnounced(_perf, _mgr, _entry, _exit, announcedFeeIncreaseTimestamp);
	}

	function renounceFeeIncrease() external onlyManager {
		announcedPerformanceFeeNumerator = 0;
		announcedManagerFeeNumerator = 0;
		announcedEntryFeeNumerator = 0;
		announcedExitFeeNumerator = 0;
		announcedFeeIncreaseTimestamp = 0;

		emit ManagerFeeIncreaseRenounced();
	}

	function commitFeeIncrease() external onlyManager {
		require(block.timestamp >= announcedFeeIncreaseTimestamp, "delay active");

		IPoolLogic(poolLogic).mintManagerFee();

		_setFeeNumerator(
			announcedPerformanceFeeNumerator,
			announcedManagerFeeNumerator,
			announcedEntryFeeNumerator,
			announcedExitFeeNumerator
		);

		emit ManagerFeeIncreaseCommitted(
        announcedPerformanceFeeNumerator,
        announcedManagerFeeNumerator,
        announcedEntryFeeNumerator,
        announcedExitFeeNumerator);

		announcedPerformanceFeeNumerator = 0;
		announcedManagerFeeNumerator = 0;
		announcedEntryFeeNumerator = 0;
		announcedExitFeeNumerator = 0;
		announcedFeeIncreaseTimestamp = 0;
	}

	// -----------------------------------------------------------------------
	// Access / misc
	// -----------------------------------------------------------------------

	function setTraderAssetChangeDisabled(bool _disabled) external onlyManager {
		traderAssetChangeDisabled = _disabled;
		emit TraderAssetChangeDisabledSet(_disabled);
	}

	function getFeeIncreaseInfo() external view returns (uint256, uint256, uint256, uint256, uint256) {
		return (
			announcedPerformanceFeeNumerator,
			announcedManagerFeeNumerator,
			announcedEntryFeeNumerator,
			announcedExitFeeNumerator,
			announcedFeeIncreaseTimestamp
		);
	}

	function setPoolLogic(address _poolLogic) external override returns (bool) {
		require(msg.sender == factoryOwner, "only owner allowed");
		require(IPoolLogic(_poolLogic).poolManagerLogic() == address(this), "invalid pool logic");

		poolLogic = _poolLogic;
		emit PoolLogicSet(_poolLogic, msg.sender);
		return true;
	}


	function setPoolPrivate(bool _privatePool) external onlyManager {
		privatePool = _privatePool;
		emit PoolPrivacyUpdated(_privatePool);
	}

	/// @notice Allow/deny protocol contracts that call back into the PoolLogic (e.g., Morpho callbacks).
	/// @dev Whitelist the protocol contract address that performs the callback (e.g., Morpho),
	///      NOT the guard contract.
	function setAllowedCallbackSender(address caller, bool allowed) external onlyManager {
		require(caller != address(0), "caller=0");
		allowedCallbackSenders[caller] = allowed;
		emit AllowedCallbackSenderSet(caller, allowed);

	}


	function setNftMembershipCollectionAddress(address addr) external onlyManager {
		address previous = nftMembershipCollectionAddress;

		if (addr == address(0)) {
			nftMembershipCollectionAddress = addr;
			emit NftMembershipCollectionAddressSet(previous, addr);
			return;
		}
		try ERC721Upgradeable(addr).balanceOf(address(this)) returns (uint256) {
			nftMembershipCollectionAddress = addr;
			emit NftMembershipCollectionAddressSet(previous, addr);
		} catch {
			revert("Invalid collection");
		}
	}

	function isNftMemberAllowed(address _member) public view returns (bool) {
		return
			nftMembershipCollectionAddress != address(0) &&
			ERC721Upgradeable(nftMembershipCollectionAddress).balanceOf(_member) > 0;
	}


	function getAllowedCallbackSenders(address protocol) external view returns (bool) {
		return allowedCallbackSenders[protocol];
	}

	function isMemberAllowed(address _member) public view override returns (bool) {
		return _isMemberAllowed(_member) || isNftMemberAllowed(_member);
	}

	function changeManager(address _newManager, string memory _newManagerName) external onlyManager {
		if (poolLogic != address(0)) {
			IPoolLogic(poolLogic).mintManagerFee();
		}
		_changeManager(_newManager, _newManagerName);
	}
}
