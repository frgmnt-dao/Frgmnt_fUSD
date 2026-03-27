// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// This mock aggregates the methods that PoolManagerLogic calls on `factory`,
/// matching the names from IHasAssetInfo, IHasFeeInfo, IHasGuardInfo, and IHasOwnable.
/// PoolManagerLogic makes interface calls *against the factory address*, so we expose
/// those functions right here to keep tests simple.

contract MockFactory {
    // --- owner (IHasOwnable) ---
    address public owner_;

    // --- asset info (IHasAssetInfo) ---
    uint256 public maximumSupportedAssetCount = 16;
    mapping(address => bool) public validAsset;
    mapping(address => uint256) public assetPrice; // 18 decimals
    mapping(address => uint16) public assetType; // for ordering

    // --- fee info (IHasFeeInfo) ---
    uint256 public maxPerf = 2000; // 20.00%
    uint256 public maxMgmt = 500; // 5.00%
    uint256 public maxEntry = 100; // 1.00%
    uint256 public maxExit = 100; // 1.00%
    uint256 public feeDenominator = 10000;

    uint256 public maxPerfChange = 100; // +1.00% max step
    uint256 public perfChangeDelay = 7 days; // delay

    // --- guard info (IHasGuardInfo) ---
    address public assetGuard; // returns same guard for any asset in tests

    // --- pool checks (IPoolFactory.isPool) ---
    mapping(address => bool) public isPoolAddr;

    event PoolManagerEventEmitted();

    constructor(address _owner) {
        owner_ = _owner;
    }

    // ----------------- setters for tests -----------------
    function setOwner(address _new) external {
        owner_ = _new;
    }
    function setMaximumSupportedAssetCount(uint256 n) external {
        maximumSupportedAssetCount = n;
    }
    function setValidAsset(address a, bool v) external {
        validAsset[a] = v;
    }
    function setAssetPrice(address a, uint256 p) external {
        assetPrice[a] = p;
    }
    function setAssetType(address a, uint16 t) external {
        assetType[a] = t;
    }
    function setMaxFees(uint256 p, uint256 m, uint256 eIn, uint256 eOut, uint256 denom) external {
        maxPerf = p;
        maxMgmt = m;
        maxEntry = eIn;
        maxExit = eOut;
        feeDenominator = denom;
    }
    function setPerfChange(uint256 maxChange, uint256 delaySecs) external {
        maxPerfChange = maxChange;
        perfChangeDelay = delaySecs;
    }
    function setAssetGuard(address g) external {
        assetGuard = g;
    }
    function setIsPool(address a, bool v) external {
        isPoolAddr[a] = v;
    }

    // ----------------- functions PoolManagerLogic calls -----------------

    // IHasOwnable
    function owner() external view returns (address) {
        return owner_;
    }

    // IHasAssetInfo
    function isValidAsset(address a) external view returns (bool) {
        return validAsset[a];
    }
    function getMaximumSupportedAssetCount() external view returns (uint256) {
        return maximumSupportedAssetCount;
    }
    function getAssetPrice(address a) external view returns (uint256) {
        uint256 p = assetPrice[a];
        return p == 0 ? 1e18 : p; // default 1 USD
    }
    function getAssetType(address a) external view returns (uint16) {
        return assetType[a];
    }

    // IHasFeeInfo
    function getMaximumFee() external view returns (uint256, uint256, uint256, uint256, uint256) {
        return (maxPerf, maxMgmt, maxEntry, maxExit, feeDenominator);
    }
    function maximumPerformanceFeeNumeratorChange() external view returns (uint256) {
        return maxPerfChange;
    }
    function performanceFeeNumeratorChangeDelay() external view returns (uint256) {
        return perfChangeDelay;
    }

    // IHasGuardInfo
    function getAssetGuard(address) external view returns (address) {
        return assetGuard;
    }

    // IPoolFactory bits PoolManagerLogic actually uses
    function isPool(address a) external view returns (bool) {
        return isPoolAddr[a];
    }
    function emitPoolManagerEvent() external {
        emit PoolManagerEventEmitted();
    }
}
