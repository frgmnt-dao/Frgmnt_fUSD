// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { ERC721Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";

import { IPoolLogic } from "./interfaces/IPoolLogic.sol";
import { IPoolManagerLogic } from "./interfaces/IPoolManagerLogic.sol";
import { IGovernance } from "./interfaces/IGovernance.sol";
import { IHasSupportedAsset } from "./interfaces/IHasSupportedAsset.sol";
import { IAssetGuard } from "./interfaces/guards/IAssetGuard.sol";
import { IAddAssetCheckGuard } from "./interfaces/guards/IAddAssetCheckGuard.sol";
import { IAssetHandler } from "./interfaces/IAssetHandler.sol";
import { IMorphoBlueLendingPoolAssetGuard } from "./interfaces/guards/IMorphoBlueLendingPoolAssetGuard.sol";
import { IPreValuedAssetGuard } from "./interfaces/guards/IPreValuedAssetGuard.sol";
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
    event PoolStatusSet(address indexed pool, bool value);
    event FactoryOwnerUpdated(address indexed previousOwner, address indexed newOwner);
    event AssetHandlerUpdated(
        address indexed previousAssetHandler,
        address indexed newAssetHandler
    );
    event GovernanceUpdated(address indexed previousGovernance, address indexed newGovernance);
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
    event ManagerFeeIncreaseCommitted(
        uint256 performanceFeeNumerator,
        uint256 managerFeeNumerator,
        uint256 entryFeeNumerator,
        uint256 exitFeeNumerator
    );

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
    address public governance;

    // Asset info
    uint256 private _maximumSupportedAssetCount;

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
    error InvalidGovernance();
    error CannotAddPoolAsset();
    error InvalidAsset();
    error AssetNotSupported();
    error PreValuedAssetNotDepositable();
    error NoAssetGuard();
    error AssetStillReferenced();
    error CannotAddFusdAsAsset();

    modifier onlyFactoryOwner() {
        require(msg.sender == factoryOwner, "only factoryOwner allowed");
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _factoryOwner,
        address _manager,
        string calldata _managerName,
        address _poolLogic,
        address _assetHandler,
        address _governance,
        uint256 _performanceFeeNumerator,
        uint256 _managerFeeNumerator
    ) external initializer {
        if (_factoryOwner == address(0)) revert InvalidFactory();
        if (_manager == address(0)) revert InvalidManager();
        // FNA-09: _poolLogic is deliberately allowed to be address(0) here. PoolLogic.initialize()
        // itself requires this contract's address, so the deployment script must deploy
        // PoolManagerLogic first (with poolLogic unset) and wire it up afterward via
        // setPoolLogic() once PoolLogic exists — see scripts/deploy_core_contracts.ts. setPoolLogic
        // below enforces non-zero before that wiring completes.
        if (_governance == address(0)) revert InvalidGovernance();
        _initialize(_manager, _managerName);
        factoryOwner = _factoryOwner;
        poolLogic = _poolLogic;
        governance = _governance;
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

    /// @dev CertiK FNA-56: shared by getAssetPrice(), assetValue(), and _addAsset()'s FNA-18
    ///      deposit check — the same low-level-staticcall marker check, previously duplicated
    ///      three times in this file. `guard == address(0)` (no guard registered for this asset
    ///      type) correctly reports false: there is nothing to be pre-valued.
    function _isPreValued(address guard) internal view returns (bool) {
        if (guard == address(0)) return false;
        (bool hasFn, bytes memory data) = guard.staticcall(
            abi.encodeWithSignature("isPreValuedAssetGuard()")
        );
        return hasFn && data.length == 32 && abi.decode(data, (bool));
    }

    /// @notice Return the latest price of a given asset
    /// @param _asset The address of the asset
    /// @return price The latest price of a given asset
    /// @dev CertiK FNA-45 follow-up: AssetHandler's registered feed for a pre-valued asset is
    ///      only a placeholder $1.00 identity aggregator (see IPreValuedAssetGuard's own docs and
    ///      assetValue() below) — returning it here for a *transferable* pre-valued share (e.g.
    ///      a Morpho Vault V2 / Aave V4 Tokenization share worth more or less than $1) silently
    ///      mispriced any consumer that calls getAssetPrice() directly on the share itself,
    ///      rather than through assetValue()'s own already-correct guard-balance short-circuit —
    ///      SlippageAccumulator.assetValue() being the concrete case this closes. On a
    ///      pre-valued match, dispatches to the guard's own IPreValuedAssetGuard.getUnitPrice(),
    ///      a plain (non-try/catch) typed call so a guard's revert (a non-transferable
    ///      pseudo-asset with no meaningful unit price, or a real share whose pricing dependency
    ///      failed) propagates instead of being swallowed — the correct fail-closed behavior for
    ///      a price a caller is about to act on.
    function getAssetPrice(address _asset) external view override returns (uint256 price) {
        address guard = getAssetGuard(_asset);
        if (_isPreValued(guard)) {
            return IPreValuedAssetGuard(guard).getUnitPrice(_asset);
        }
        price = IAssetHandler(assetHandler).getUSDPrice(_asset);
    }

    /// @notice Return type of the asset
    /// @param _asset The address of the asset
    /// @return assetType The type of the asset
    function getAssetType(address _asset) public view override returns (uint16 assetType) {
        assetType = IAssetHandler(assetHandler).assetTypes(_asset);
    }

    /// @notice Get address of the asset guard
    /// @param _extAsset The address of the external asset
    function getAssetGuard(address _extAsset) public view returns (address) {
        uint16 _assetType = getAssetType(_extAsset);
        return IGovernance(governance).assetGuards(_assetType);
    }

    /// @notice Get address of the contract guard
    /// @param _extContract The address of the external contract
    function getContractGuard(address _extContract) public view returns (address) {
        return IGovernance(governance).contractGuards(_extContract);
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

    function setGovernance(address _governance) external onlyFactoryOwner {
        require(_governance != address(0), "invalid governance");
        address previousGovernance = governance;
        governance = _governance;
        emit GovernanceUpdated(previousGovernance, _governance);
    }

    // -----------------------------------------------------------------------
    // Supported assets
    // -----------------------------------------------------------------------

    function isSupportedAsset(address _asset) public view override returns (bool) {
        return assetPosition[_asset] != 0;
    }

    // @notice a deposited asset must be a "withdrawable" ERC20 token.
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
            (msg.sender == trader && !traderAssetChangeDisabled) ||
                msg.sender == manager ||
                msg.sender == factoryOwner,
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

        // FNA-23: fusd is the fund's accounting unit, not a collateral asset. Listing it as a
        // supported asset of its own backing pool would leave fUSD reserved for finalized cash
        // withdrawals unring-fenced from the pool's general fUSD balance, spendable by ordinary
        // guarded operations. poolLogic can be unset only during initial wiring (FNA-09), before
        // any real asset is ever added, so skip the check rather than reverting in that window.
        if (poolLogic != address(0) && asset == IPoolLogic(poolLogic).fusd())
            revert CannotAddFusdAsAsset();

        address guard = getAssetGuard(asset);
        if (guard != address(0)) {
            (bool hasFn, bytes memory data) = guard.staticcall(
                abi.encodeWithSignature("isAddAssetCheckGuard()")
            );
            if (hasFn && abi.decode(data, (bool))) {
                IAddAssetCheckGuard(guard).addAssetCheck(poolLogic, _asset);
            }

            // FNA-18: a pre-valued/complex guard's getBalance() already returns a fully priced
            // USD-18 figure (see IPreValuedAssetGuard) — its registered price is a fixed $1
            // identity multiplier, not a real per-share/per-token price. TokenLogic's deposit
            // and PoolLogic's queued-withdrawal math (_convertToUSD, fusdToAssetAmount,
            // computeFinalizeAssetAmount) all treat the registered price/decimals as literal
            // per-raw-unit conversion factors instead, so depositing or queue-withdrawing such
            // an asset would mint or transfer against the wrong quantity entirely whenever one
            // unit's real value isn't exactly $1 (e.g. a Morpho Vault V2 share worth $2 would
            // transfer double the shares a queued withdrawal should deliver). Enforced here,
            // not just by convention, since this is the single authoritative point isDeposit is
            // ever set — TokenLogic.configureAsset() already requires
            // poolManagerLogic.isDepositAsset() to be true first, so blocking it here is
            // sufficient without a second, redundant check on that separately-upgradeable proxy.
            if (isDeposit && _isPreValued(guard)) {
                revert PreValuedAssetNotDepositable();
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
            while (
                len > 0 &&
                IAssetHandler(assetHandler).assetTypes(supportedAssets[len - 1].asset) < atype
            ) {
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

    /// @dev FNA-52: requires a resolvable guard before allowing removal, rather than silently
    ///      skipping removeAssetCheck() when one can't be found. getAssetGuard() resolves
    ///      through AssetHandler.assetTypes(_asset) -> Governance.assetGuards(assetType) — if an
    ///      operator calls AssetHandler.removeAsset() (which zeroes assetTypes(_asset)) before
    ///      removing the asset from this pool's own supportedAssets, this guard lookup would
    ///      otherwise go straight to address(0), and the balance/position check that's supposed
    ///      to block removing an asset with an open position never runs at all — the exact gap
    ///      the finding describes for a Morpho loan token, but not specific to Morpho: it applies
    ///      to any asset whose type mapping is cleared ahead of the pool-level removal. An
    ///      unresolvable guard means this contract has no way to verify the asset is actually
    ///      safe to unlist, so it must block the removal rather than assume it's fine — recovery
    ///      is the same either way: restore the asset's type/guard registration in
    ///      AssetHandler/Governance, then retry, exactly as the finding's own recommended
    ///      sequence already requires before any removal.
    /// @notice FNA-53: centralizes the cross-asset dependency check every asset removal must
    ///         pass, regardless of the candidate's own guard type.
    /// @dev Before this, `removeTokenCheck()` — already implemented by seven guards
    ///      (ERC20Guard, ClosedAssetGuard and every guard built on it: Aave V3/V4 lending,
    ///      Morpho Blue, Morpho Vault V2, Aave V4 Tokenization/Spoke, Uniswap V3) — was only
    ///      ever actually invoked from ERC20Guard.removeAssetCheck()'s own loop, so the check
    ///      only ran when the asset being REMOVED was itself ERC20Guard-typed (a plain token).
    ///      Removing anything else (a lending position, a vault share, a Uniswap V3 position
    ///      manager) skipped it entirely, since every other guard here inherits ClosedAssetGuard,
    ///      whose removeAssetCheck() only checks its own pool balance — never asking any other
    ///      guard whether it still depends on the asset being removed. A composite ERC-20 (e.g.
    ///      a Morpho Vault V2 share) used as a Uniswap V3 position leg could therefore be removed
    ///      from supportedAssets while an open Uniswap V3 NFT still referenced it as token0/
    ///      token1 — UniswapV3AssetGuard then silently skips that leg in getBalance() without
    ///      reporting the reading as incomplete (FNA-53). Looping here instead of inside
    ///      ERC20Guard makes the check run for every removal uniformly; ERC20Guard.
    ///      removeAssetCheck() no longer duplicates it.
    function _requireNotReferencedByOtherAssets(address _asset) internal view {
        Asset[] memory assets = supportedAssets;
        uint256 len = assets.length;
        for (uint256 i; i < len; ++i) {
            address otherAsset = assets[i].asset;
            address otherGuard = getAssetGuard(otherAsset);
            if (otherGuard == address(0)) continue;
            if (!IAssetGuard(otherGuard).removeTokenCheck(poolLogic, otherAsset, _asset)) {
                revert AssetStillReferenced();
            }
        }
    }

    function _removeAsset(address _asset) internal {
        if (!isSupportedAsset(_asset)) revert AssetNotSupported();

        address guard = getAssetGuard(_asset);
        if (guard == address(0)) revert NoAssetGuard();
        // Don't rely on on-chain wallet balance as a safe-removal condition.
        // Let the guard decide using protocol-aware checks (including external positions).
        IAssetGuard(guard).removeAssetCheck(poolLogic, _asset);
        _requireNotReferencedByOtherAssets(_asset);

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
        address guard = getAssetGuard(_asset);
        if (guard == address(0)) return 0;
        return IAssetGuard(guard).getBalance(poolLogic, _asset);
    }

    function assetDecimal(address _asset) public view returns (uint256) {
        address guard = getAssetGuard(_asset);
        require(guard != address(0), "no guard");
        return IAssetGuard(guard).getDecimals(_asset);
    }

    /// @dev Pre-valued guards (Aave V3/V4, Morpho Blue, Morpho Vault V2, Uniswap V3 — see
    ///      IPreValuedAssetGuard) already return a fully priced, base-currency USD/EUR value from
    ///      getBalance(), computed by pricing each underlying individually. Their registered
    ///      pseudo-asset price feed exists only so addAssetCheck()-style registration validation
    ///      has something to check; it must NOT be multiplied in again here, since that would
    ///      silently double-apply any conversion (e.g. AssetHandler's EUR/USD rate) already baked
    ///      into the guard's own internal pricing.
    function assetValue(address _asset, uint256 _amount) public view override returns (uint256) {
        if (_amount == 0) return 0;

        address guard = getAssetGuard(_asset);
        if (_isPreValued(guard)) {
            return _amount;
        }

        uint256 price = IAssetHandler(assetHandler).getUSDPrice(_asset);
        if (price == 0) return 0;

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
        total = _subtractTotalDeficit(total);
    }

    /// @dev See IPoolManagerLogic.totalFundValueWithCompleteness(). Checks the
    ///      IIncompleteValuationGuard marker via a low-level staticcall (same pattern as
    ///      isPreValuedAssetGuard() above); a guard without the marker, or a marker check that
    ///      itself can't be decoded, is treated as complete — correct for every guard in this
    ///      codebase that doesn't opt in, since those either revert on failure (making the whole
    ///      totalFundValue() call revert, not silently understate it) or have no external
    ///      dependency that can degrade a nonzero position to zero.
    /// @dev public (not external): FNA-43's commitFeeIncrease() below also calls this by bare
    ///      name from within this same contract — external functions cannot be invoked
    ///      internally by name in Solidity (unlike the delegatecall-library "this." pitfall
    ///      elsewhere in this codebase, PoolManagerLogic is not delegatecall-invoked, so `this.`
    ///      would also work here, just as a strictly more expensive external call for no benefit).
    function totalFundValueWithCompleteness()
        public
        view
        override
        returns (uint256 total, bool complete)
    {
        complete = true;
        uint256 len = supportedAssets.length;
        for (uint256 i; i < len; ++i) {
            address asset = supportedAssets[i].asset;
            total += assetValue(asset);
            if (complete && !_isValuationComplete(asset)) {
                complete = false;
            }
        }
        total = _subtractTotalDeficit(total);
    }

    function _isValuationComplete(address _asset) internal view returns (bool) {
        address guard = getAssetGuard(_asset);
        if (guard == address(0)) return true;

        (bool hasMarker, bytes memory markerData) = guard.staticcall(
            abi.encodeWithSignature("isIncompleteValuationGuard()")
        );
        if (!hasMarker || markerData.length != 32 || !abi.decode(markerData, (bool))) return true;

        (bool ok, bytes memory data) = guard.staticcall(
            abi.encodeWithSignature("isValuationComplete(address,address)", poolLogic, _asset)
        );
        if (!ok || data.length != 32) return false;
        return abi.decode(data, (bool));
    }

    /// @notice FNA-54: sums every supported asset's IDeficitReportingGuard-reported deficit
    ///         (an underwater lending position's debt exceeding its collateral) and subtracts
    ///         the total from `grossTotal`, floored at 0. getBalance() alone can only clamp an
    ///         underwater position's own contribution to 0 — it cannot make the sum go negative,
    ///         since every consumer here works in non-negative uint256 — so without this
    ///         separate pass the deficit is silently omitted rather than actually deducted from
    ///         the rest of the pool's positive balances.
    /// @dev Checked via the same low-level-staticcall marker pattern as
    ///      isPreValuedAssetGuard()/isIncompleteValuationGuard() above; a guard without the
    ///      marker contributes 0, correct for every guard in this codebase that cannot carry
    ///      negative equity.
    function _subtractTotalDeficit(uint256 grossTotal) internal view returns (uint256) {
        uint256 totalDeficit;
        uint256 len = supportedAssets.length;
        for (uint256 i; i < len; ++i) {
            address asset = supportedAssets[i].asset;
            address guard = getAssetGuard(asset);
            if (guard == address(0)) continue;

            (bool hasMarker, bytes memory markerData) = guard.staticcall(
                abi.encodeWithSignature("isDeficitReportingGuard()")
            );
            if (!hasMarker || markerData.length != 32 || !abi.decode(markerData, (bool))) continue;

            (bool ok, bytes memory data) = guard.staticcall(
                abi.encodeWithSignature("getDeficit(address,address)", poolLogic, asset)
            );
            if (ok && data.length == 32) {
                totalDeficit += abi.decode(data, (uint256));
            }
        }
        return grossTotal > totalDeficit ? grossTotal - totalDeficit : 0;
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

    function setFeeNumerator(
        uint256 _perf,
        uint256 _mgr,
        uint256 _entry,
        uint256 _exit
    ) external onlyManager {
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
        (
            uint256 maxPerf,
            uint256 maxMgr,
            uint256 maxEntry,
            uint256 maxExit,
            uint256 denom
        ) = getMaximumFee();

        require(
            _perf <= maxPerf && _mgr <= maxMgr && _entry <= maxEntry && _exit <= maxExit,
            "invalid manager fee"
        );

        performanceFeeNumerator = _perf;
        managerFeeNumerator = _mgr;
        entryFeeNumerator = _entry;
        exitFeeNumerator = _exit;

        emit ManagerFeeSet(poolLogic, manager, _perf, _mgr, _entry, _exit, denom);
    }

    function announceFeeIncrease(
        uint256 _perf,
        uint256 _mgr,
        uint256 _entry,
        uint256 _exit
    ) external onlyManager {
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

    /// @dev FNA-43: mintManagerFee() -> PoolLogic._accrueYield() is a deliberate no-op on an
    ///      incomplete NAV (see its own docs) — it leaves accountedAssets/lastFeeMintTime exactly
    ///      where they were rather than checkpointing against a possibly-understated total. That
    ///      protects stakers from an under-recognized checkpoint, but it also means committing a
    ///      fee increase during a transient incomplete-NAV window installs the new numerators
    ///      without ever settling the old ones against the yield/time that already elapsed — the
    ///      first *complete*-NAV accrual afterwards then charges the new, higher rate on that
    ///      entire pre-commit interval. Reverting here instead makes the manager wait for the
    ///      guard to recover before the new rate can be installed, so the old rate always gets
    ///      its own checkpoint first. Uses this contract's own totalFundValueWithCompleteness()
    ///      rather than a new call into PoolLogic — its `complete` flag is the same one
    ///      PoolLogic's accrual reads (activeTotalValueWithCompleteness() calls this function's
    ///      figure and only subtracts reserved value, never touching completeness), so this check
    ///      is exactly equivalent, one transaction earlier.
    function commitFeeIncrease() external onlyManager {
        require(block.timestamp >= announcedFeeIncreaseTimestamp, "delay active");

        (, bool navComplete) = totalFundValueWithCompleteness();
        require(navComplete, "NAV incomplete");

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
            announcedExitFeeNumerator
        );

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

    function getFeeIncreaseInfo()
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256)
    {
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
        // FNA-09: explicit zero check for a clear revert reason — the external call below already
        // reverts on address(0) (no code to decode a return value from), but only implicitly.
        if (_poolLogic == address(0)) revert InvalidPoolLogic();
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

        // FNA-09: address(0) is a deliberate, valid input here — it's how the manager disables
        // NFT membership gating entirely, not a missing validation gap.
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

    function changeManager(
        address _newManager,
        string memory _newManagerName
    ) external onlyManager {
        if (poolLogic != address(0)) {
            IPoolLogic(poolLogic).mintManagerFee();
        }
        _changeManager(_newManager, _newManagerName);
    }
}
