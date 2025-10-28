// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";

import {IPoolLogic} from "./interfaces/IPoolLogic.sol";
import {IPoolManagerLogic} from "./interfaces/IPoolManagerLogic.sol";
import {IHasAssetInfo} from "./interfaces/IHasAssetInfo.sol";
import {IHasFeeInfo} from "./interfaces/IHasFeeInfo.sol";
import {IHasGuardInfo} from "./interfaces/IHasGuardInfo.sol";
import {IHasSupportedAsset} from "./interfaces/IHasSupportedAsset.sol";
import {IHasOwnable} from "./interfaces/IHasOwnable.sol";
import {IAssetGuard} from "./interfaces/guards/IAssetGuard.sol";
import {IAddAssetCheckGuard} from "./interfaces/guards/IAddAssetCheckGuard.sol";
import {IPoolFactory} from "./interfaces/IPoolFactory.sol";
import {Managed} from "./Managed.sol";

/// @title Frgmnt — PoolManagerLogic
/// @notice Logic implementation for pool management.
contract PoolManagerLogic is Initializable, IPoolManagerLogic, IHasSupportedAsset, Managed {
  // =====================================================
  //                       EVENTS
  // =====================================================

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

  // =====================================================
  //                   STATE VARIABLES
  // (ORDER PRESERVED EXACTLY — DO NOT REORDER)
  // =====================================================

  address public override factory;
  address public override poolLogic;

  Asset[] public supportedAssets;
  mapping(address => uint256) public assetPosition; // maps the asset to its 1-based position

  // Fee increase announcement
  uint256 public announcedPerformanceFeeNumerator;
  uint256 public announcedFeeIncreaseTimestamp;
  uint256 public performanceFeeNumerator;
  // Management (or streaming) fee is referred to as manager fee (backward compatibility)
  uint256 public announcedManagerFeeNumerator;
  uint256 public managerFeeNumerator;

  // Should be in Managed.sol but not upgradable
  address public nftMembershipCollectionAddress;

  uint256 public override minDepositUSD;

  uint256 public announcedEntryFeeNumerator;
  uint256 public entryFeeNumerator;

  uint256 public announcedExitFeeNumerator;
  uint256 public exitFeeNumerator;

  // By default, traders can change supported assets.
  bool public traderAssetChangeDisabled;

  // =====================================================
  //                      ERRORS
  // =====================================================
  error InvalidFactory();
  // InvalidManager is inherited from Managed
  error InvalidPoolLogic();
  error CannotAddPoolAsset();
  error InvalidAsset();
  error AssetNotSupported();

  // =====================================================
  //                    INITIALIZATION
  // =====================================================

  /// @notice initialize the pool manager
  function initialize(
    address _factory,
    address _manager,
    string calldata _managerName,
    address _poolLogic,
    uint256 _performanceFeeNumerator,
    uint256 _managerFeeNumerator,
    Asset[] calldata _supportedAssets
  ) external initializer {
    if (_factory == address(0)) revert InvalidFactory();
    if (_manager == address(0)) revert InvalidManager();
    if (_poolLogic == address(0)) revert InvalidPoolLogic();

    _initialize(_manager, _managerName);

    factory = _factory;
    poolLogic = _poolLogic;

    // By default entry and exit fees will be set to 0%.
    _setFeeNumerator(_performanceFeeNumerator, _managerFeeNumerator, 0, 0);

   
    _changeAssets(_supportedAssets, new address[](0));
  }

  // =====================================================
  //                SUPPORTED ASSET QUERIES
  // =====================================================

  function isSupportedAsset(address _asset) public view override returns (bool) {
    return assetPosition[_asset] != 0;
  }

  function isDepositAsset(address _asset) external view override returns (bool) {
    uint256 index = assetPosition[_asset];
    return index != 0 && supportedAssets[index - 1].isDeposit;
  }

  function validateAsset(address _asset) public view override returns (bool) {
    return IHasAssetInfo(factory).isValidAsset(_asset);
  }

  // =====================================================
  //                SUPPORTED ASSET MUTATIONS
  // =====================================================

  function changeAssets(Asset[] calldata _addAssets, address[] calldata _removeAssets) external {
    /* solhint-disable reason-string */
    require(
      (msg.sender == trader && !traderAssetChangeDisabled) ||
        msg.sender == manager ||
        msg.sender == IHasOwnable(factory).owner(),
      "only manager, owner or trader enabled"
    );
    /* solhint-enable reason-string */

    _changeAssets(_addAssets, _removeAssets);
    _emitFactoryEvent();
  }

  function _changeAssets(Asset[] calldata _addAssets, address[] memory _removeAssets) internal {
    uint256 rlen = _removeAssets.length;
    for (uint256 i = 0; i < rlen; ) {
      _removeAsset(_removeAssets[i]);
      unchecked { ++i; }
    }

    uint256 alen = _addAssets.length;
    for (uint256 i = 0; i < alen; ) {
      _addAsset(_addAssets[i]);
      unchecked { ++i; }
    }

    // bounds
    require(
      supportedAssets.length <= IHasAssetInfo(factory).getMaximumSupportedAssetCount(),
      "maximum assets reached"
    );
    require(getDepositAssets().length >= 1, "at least one deposit asset");
  }

  /// @notice Add an asset to the pool
  function _addAsset(Asset calldata _asset) internal {
    address asset = _asset.asset;
    bool isDeposit = _asset.isDeposit;

    if (!validateAsset(asset)) revert InvalidAsset();

    // Pools with price aggregators cannot add other pools as assets
    if (validateAsset(poolLogic) && IPoolFactory(factory).isPool(asset)) revert CannotAddPoolAsset();

    address guard = IHasGuardInfo(factory).getAssetGuard(asset);
    if (guard != address(0)) {
      // solhint-disable-next-line avoid-low-level-calls
      (bool hasFunction, bytes memory answer) = guard.call(abi.encodeWithSignature("isAddAssetCheckGuard()"));
      if (hasFunction && abi.decode(answer, (bool))) {
        IAddAssetCheckGuard(guard).addAssetCheck(poolLogic, _asset);
      }
    }

    if (isSupportedAsset(asset)) {
      uint256 index = assetPosition[asset] - 1;
      supportedAssets[index].isDeposit = isDeposit;
    } else {
      uint256 i = supportedAssets.length;
      supportedAssets.push(_asset);
      assetPosition[asset] = i + 1; // store 1-based

      IHasAssetInfo assetInfo = IHasAssetInfo(factory);
      uint16 assetType = assetInfo.getAssetType(asset);

      // insertion by assetType (descending); bubble the new element backward
      for ( ; i > 0 && assetInfo.getAssetType(supportedAssets[i - 1].asset) < assetType; ) {
        Asset memory tmp = supportedAssets[i];
        supportedAssets[i] = supportedAssets[i - 1];
        assetPosition[supportedAssets[i].asset] = i + 1;

        supportedAssets[i - 1] = tmp;
        assetPosition[supportedAssets[i - 1].asset] = i;

        unchecked { --i; }
      }
    }

    emit AssetAdded(poolLogic, manager, asset, isDeposit);
  }

  /// @notice Remove asset from the pool
  function _removeAsset(address _asset) internal {
    if (!isSupportedAsset(_asset)) revert AssetNotSupported();

    address guard = IHasGuardInfo(factory).getAssetGuard(_asset);
    if (guard != address(0)) {
      // should be able to remove any deprecated assets
      require(assetBalance(_asset) == 0, "cannot remove non-empty asset");
      IAssetGuard(guard).removeAssetCheck(poolLogic, _asset);
    }

    uint256 index = assetPosition[_asset] - 1; // to 0-based
    uint256 length = supportedAssets.length;

    // shift left from index
    for (uint256 i = index; i + 1 < length; ) {
      Asset memory tmp = supportedAssets[i];
      supportedAssets[i] = supportedAssets[i + 1];
      assetPosition[supportedAssets[i].asset] = i + 1;

      supportedAssets[i + 1] = tmp;
      assetPosition[supportedAssets[i + 1].asset] = i + 2;

      unchecked { ++i; }
    }

    assetPosition[supportedAssets[length - 1].asset] = 0;
    supportedAssets.pop();

    emit AssetRemoved(poolLogic, manager, _asset);
  }

  // =====================================================
  //                    VIEW HELPERS
  // =====================================================

  function getSupportedAssets() external view override returns (Asset[] memory) {
    return supportedAssets;
  }

  function getDepositAssets() public view returns (address[] memory) {
    uint256 assetCount = supportedAssets.length;
    address[] memory depositAssets = new address[](assetCount);
    uint256 index = 0;

    for (uint256 i = 0; i < assetCount; ) {
      if (supportedAssets[i].isDeposit) {
        depositAssets[index] = supportedAssets[i].asset;
        unchecked { ++index; }
      }
      unchecked { ++i; }
    }

    uint256 reduceLength = assetCount - index;
    assembly {
      mstore(depositAssets, sub(mload(depositAssets), reduceLength))
    }
    return depositAssets;
  }

  function assetBalance(address _asset) public view override returns (uint256 balance) {
    address guard = IHasGuardInfo(factory).getAssetGuard(_asset);
    balance = IAssetGuard(guard).getBalance(poolLogic, _asset);
  }

  function assetDecimal(address _asset) public view returns (uint256 decimal) {
    address guard = IHasGuardInfo(factory).getAssetGuard(_asset);
    decimal = IAssetGuard(guard).getDecimals(_asset);
  }

  function assetValue(address _asset, uint256 _amount) public view override returns (uint256 value) {
    uint256 price = IHasAssetInfo(factory).getAssetPrice(_asset);
    uint256 decimals = assetDecimal(_asset);
    value = (price * _amount) / (10 ** decimals);
  }

  function assetValue(address _asset) public view override returns (uint256 value) {
    value = assetValue(_asset, assetBalance(_asset));
  }

  function getFundComposition()
    external
    view
    returns (Asset[] memory assets, uint256[] memory balances, uint256[] memory rates)
  {
    uint256 assetCount = supportedAssets.length;
    assets = new Asset[](assetCount);
    balances = new uint256[](assetCount);
    rates = new uint256[](assetCount);

    IHasAssetInfo assetInfo = IHasAssetInfo(factory);
    for (uint256 i = 0; i < assetCount; ) {
      address asset = supportedAssets[i].asset;
      balances[i] = assetBalance(asset);
      assets[i] = supportedAssets[i];
      rates[i] = assetInfo.getAssetPrice(asset);
      unchecked { ++i; }
    }
  }

  function totalFundValue() external view override returns (uint256 total) {
    uint256 assetCount = supportedAssets.length;
    for (uint256 i = 0; i < assetCount; ) {
      total += assetValue(supportedAssets[i].asset);
      unchecked { ++i; }
    }
  }

  /* ========== MANAGER FEES ========== */

  function getFee() external view override returns (uint256, uint256, uint256, uint256, uint256) {
    (, , , , uint256 managerFeeDenominator) = IHasFeeInfo(factory).getMaximumFee();
    return (performanceFeeNumerator, managerFeeNumerator, entryFeeNumerator, exitFeeNumerator, managerFeeDenominator);
  }

  function getMaximumFee() public view returns (uint256, uint256, uint256, uint256, uint256) {
    return IHasFeeInfo(factory).getMaximumFee();
  }

  function getMaximumPerformanceFeeChange() public view returns (uint256 change) {
    change = IHasFeeInfo(factory).maximumPerformanceFeeNumeratorChange();
  }

  function setFeeNumerator(
    uint256 _performanceFeeNumerator,
    uint256 _managerFeeNumerator,
    uint256 _entryFeeNumerator,
    uint256 _exitFeeNumerator
  ) external onlyManager {
    require(
      _performanceFeeNumerator <= performanceFeeNumerator &&
        _managerFeeNumerator <= managerFeeNumerator &&
        _entryFeeNumerator <= entryFeeNumerator &&
        _exitFeeNumerator <= exitFeeNumerator,
      "manager fee too high"
    );
    _setFeeNumerator(_performanceFeeNumerator, _managerFeeNumerator, _entryFeeNumerator, _exitFeeNumerator);
    _emitFactoryEvent();
  }

  function _setFeeNumerator(
    uint256 _performanceFeeNumerator,
    uint256 _managerFeeNumerator,
    uint256 _entryFeeNumerator,
    uint256 _exitFeeNumerator
  ) internal {
    (
      uint256 maximumPerformanceFeeNumerator,
      uint256 maximumManagerFeeNumerator,
      uint256 maximumEntryFeeNumerator,
      uint256 maximumExitFeeNumerator,
      uint256 denominator
    ) = getMaximumFee();

    require(
      _performanceFeeNumerator <= maximumPerformanceFeeNumerator &&
        _managerFeeNumerator <= maximumManagerFeeNumerator &&
        _entryFeeNumerator <= maximumEntryFeeNumerator &&
        _exitFeeNumerator <= maximumExitFeeNumerator,
      "invalid manager fee"
    );

    performanceFeeNumerator = _performanceFeeNumerator;
    managerFeeNumerator = _managerFeeNumerator;
    entryFeeNumerator = _entryFeeNumerator;
    exitFeeNumerator = _exitFeeNumerator;

    emit ManagerFeeSet(
      poolLogic,
      manager,
      _performanceFeeNumerator,
      _managerFeeNumerator,
      _entryFeeNumerator,
      _exitFeeNumerator,
      denominator
    );
  }

  function announceFeeIncrease(
    uint256 _performanceFeeNumerator,
    uint256 _managerFeeNumerator,
    uint256 _entryFeeNumerator,
    uint256 _exitFeeNumerator
  ) external onlyManager {
    (
      uint256 maximumPerformanceFeeNumerator,
      uint256 maximumManagerFeeNumerator,
      uint256 maximumEntryFeeNumerator,
      uint256 maximumExitFeeNumerator,

    ) = getMaximumFee();
    uint256 maximumAllowedChange = getMaximumPerformanceFeeChange();

    require(
      _performanceFeeNumerator <= maximumPerformanceFeeNumerator &&
        _managerFeeNumerator <= maximumManagerFeeNumerator &&
        _entryFeeNumerator <= maximumEntryFeeNumerator &&
        _exitFeeNumerator <= maximumExitFeeNumerator &&
        _performanceFeeNumerator <= performanceFeeNumerator + maximumAllowedChange,
      "exceeded allowed increase"
    );

    uint256 feeChangeDelay = IHasFeeInfo(factory).performanceFeeNumeratorChangeDelay();

    announcedPerformanceFeeNumerator = _performanceFeeNumerator;
    announcedManagerFeeNumerator = _managerFeeNumerator; // fixed typo
    announcedEntryFeeNumerator = _entryFeeNumerator;
    announcedExitFeeNumerator = _exitFeeNumerator;
    announcedFeeIncreaseTimestamp = block.timestamp + feeChangeDelay;

    emit ManagerFeeIncreaseAnnounced(
      _performanceFeeNumerator,
      _managerFeeNumerator,
      _entryFeeNumerator,
      _exitFeeNumerator,
      announcedFeeIncreaseTimestamp
    );

    _emitFactoryEvent();
  }

  function renounceFeeIncrease() external onlyManager {
    announcedPerformanceFeeNumerator = 0;
    announcedManagerFeeNumerator = 0;
    announcedEntryFeeNumerator = 0;
    announcedExitFeeNumerator = 0;
    announcedFeeIncreaseTimestamp = 0;

    emit ManagerFeeIncreaseRenounced();
    _emitFactoryEvent();
  }

  function commitFeeIncrease() external onlyManager {
    require(block.timestamp >= announcedFeeIncreaseTimestamp, "fee increase delay active");

    IPoolLogic(poolLogic).mintManagerFee();

    _setFeeNumerator(
      announcedPerformanceFeeNumerator,
      announcedManagerFeeNumerator,
      announcedEntryFeeNumerator,
      announcedExitFeeNumerator
    );

    announcedPerformanceFeeNumerator = 0;
    announcedManagerFeeNumerator = 0;
    announcedEntryFeeNumerator = 0;
    announcedExitFeeNumerator = 0;
    announcedFeeIncreaseTimestamp = 0;
  }

  // =====================================================
  //                ACCESS / MISC CONTROLS
  // =====================================================

  function setTraderAssetChangeDisabled(bool _disabled) external onlyManager {
    traderAssetChangeDisabled = _disabled;
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
    address owner = IHasOwnable(factory).owner();
    require(msg.sender == owner, "only owner address allowed");
    require(IPoolLogic(_poolLogic).poolManagerLogic() == address(this), "invalid pool logic");

    poolLogic = _poolLogic;
    emit PoolLogicSet(_poolLogic, msg.sender);
    _emitFactoryEvent();
    return true;
  }

  function setNftMembershipCollectionAddress(address _newNftMembershipCollectionAddress) external onlyManager {
    if (_newNftMembershipCollectionAddress == address(0)) {
      nftMembershipCollectionAddress = _newNftMembershipCollectionAddress;
      return;
    }
    try ERC721Upgradeable(_newNftMembershipCollectionAddress).balanceOf(address(this)) returns (uint256) {
      nftMembershipCollectionAddress = _newNftMembershipCollectionAddress;
    } catch {
      revert("Invalid collection");
    }
  }

  function setMinDepositUSD(uint256 _minDepositUSD) external onlyManager {
    _setMinDepositUSD(_minDepositUSD);
    _emitFactoryEvent();
  }

  function _setMinDepositUSD(uint256 _minDepositUSD) internal {
    minDepositUSD = _minDepositUSD;
    emit MinDepositUpdated(_minDepositUSD);
  }

  function isNftMemberAllowed(address _member) public view returns (bool) {
    return (nftMembershipCollectionAddress != address(0) &&
      ERC721Upgradeable(nftMembershipCollectionAddress).balanceOf(_member) > 0);
  }

  function isMemberAllowed(address _member) public view virtual override returns (bool) {
    return _isMemberAllowed(_member) || isNftMemberAllowed(_member);
  }

  function _emitFactoryEvent() internal {
    IPoolFactory(factory).emitPoolManagerEvent();
  }

  uint256[42] private __gap;
}
