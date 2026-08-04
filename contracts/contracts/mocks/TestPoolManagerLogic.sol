// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IMintManagerFeePool {
    function mintManagerFee() external;
}

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
    mapping(address => bool) public allowedCallbackSenders;

    // Ordered list for getSupportedAssets()
    address[] private _assetList;
    mapping(address => bool) private _assetInList;

    address public pool; // optional reference (not used by PoolLogic, but handy in tests)

    constructor(
        address _manager,
        address _trader,
        string memory _managerName,
        address /* baseAsset */
    ) {
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
        returns (
            uint256 performance,
            uint256 management,
            uint256 entry,
            uint256 exit,
            uint256 denominator
        )
    {
        return (fees.performance, fees.management, fees.entry, fees.exit, fees.denominator);
    }

    // ---- Fund value ----

    function totalFundValue() external view returns (uint256) {
        return _totalFundValue;
    }

    // FNA-04: PoolLogic._accrueYield() consumes this (via FundCalculationLibrary's low-level-call
    // fallback, so a mock that doesn't implement it — the state before this setter is called for
    // the first time — is equally valid for exercising that fallback path). Defaults to true so
    // existing tests that never call setValuationComplete() keep going through the "normal"
    // accrual path unchanged.
    bool public valuationComplete = true;

    function setValuationComplete(bool _complete) external {
        valuationComplete = _complete;
    }

    function totalFundValueWithCompleteness() external view returns (uint256, bool) {
        return (_totalFundValue, valuationComplete);
    }

    function factory() external view returns (address) {
        return address(this);
    }

    function setTotalFundValue(uint256 v) external {
        _totalFundValue = v;
    }

    // ---- Supported assets / pricing ----

    function isSupportedAsset(address asset) external view returns (bool) {
        return supportedAssets[asset];
    }

    function isDepositAsset(address asset) external view returns (bool) {
        return supportedAssets[asset];
    }

    // Pool membership / privacy (always open by default)
    bool public privatePool = false;
    bool public memberAllowed = true;

    function setPrivatePool(bool _private) external {
        privatePool = _private;
    }

    function setMemberAllowed(bool allowed) external {
        memberAllowed = allowed;
    }

    function isMemberAllowed(address) external view returns (bool) {
        return memberAllowed;
    }

    function setSupportedAsset(
        address asset,
        bool isSupported,
        uint256 price,
        uint8 decimals_
    ) external {
        if (isSupported && !_assetInList[asset]) {
            _assetList.push(asset);
            _assetInList[asset] = true;
        }
        supportedAssets[asset] = isSupported;
        assetPrice[asset] = price;
        assetDecimals[asset] = decimals_;
    }

    struct Asset {
        address asset;
        bool isDeposit;
    }

    function getSupportedAssets() external view returns (Asset[] memory assets) {
        assets = new Asset[](_assetList.length);
        for (uint256 i = 0; i < _assetList.length; i++) {
            assets[i] = Asset({ asset: _assetList[i], isDeposit: true });
        }
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

    function setAllowedCallbackSender(address caller, bool allowed) external {
        allowedCallbackSenders[caller] = allowed;
    }

    function getAllowedCallbackSenders(address caller) external view returns (bool) {
        return allowedCallbackSenders[caller];
    }

    // ---- Optional pool backref ----

    function setPool(address _pool) external {
        pool = _pool;
    }

    function callMintManagerFee(address poolLogic_) external {
        IMintManagerFeePool(poolLogic_).mintManagerFee();
    }

    // ---- trader (used in PoolLogic access control) ----

    function traderFn() external view returns (address) {
        return trader;
    }
}
