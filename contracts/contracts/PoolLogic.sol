// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IManaged } from "./interfaces/IManaged.sol";
import { IPoolManagerLogic } from "./interfaces/IPoolManagerLogic.sol";
import { IPoolLogic } from "./interfaces/IPoolLogic.sol";
import { IHasSupportedAsset } from "./interfaces/IHasSupportedAsset.sol";
import { IAssetGuard } from "./interfaces/guards/IAssetGuard.sol";
import { IComplexAssetGuard } from "./interfaces/guards/IComplexAssetGuard.sol";

import { IFlashLoanReceiver } from "./interfaces/aave/IFlashLoanReceiver.sol";
import { IMorphoFlashLoanCallback } from "./interfaces/IMorphoFlashLoanCallback.sol";
import { PoolLogicFlashloanAave } from "./utils/PoolLogicFlashloanAave.sol";
import { PoolLogicFlashloanMorpho } from "./utils/PoolLogicFlashloanMorpho.sol";
import { PoolTxExecutor } from "./utils/PoolTxExecutor.sol";
import { FundCalculationLibrary } from "./utils/FundCalculationLibrary.sol";





interface ITokenLogic is IERC20 {
	function burnFrom(address account, uint256 amount) external;
	function burn(uint256 amount) external;
	function getExitRemainingCooldown(address user) external view returns (uint256);
	function mintFromPool(address to, uint256 amount) external;
}

contract PoolLogic is IPoolLogic, ERC20Upgradeable, OwnableUpgradeable, ReentrancyGuardUpgradeable,
    IFlashLoanReceiver,
    IMorphoFlashLoanCallback,
    PoolLogicFlashloanAave,
    PoolLogicFlashloanMorpho {
	using SafeERC20 for IERC20;


	// ============================================================
	// =                        STRUCTS                           =
	// ============================================================

	struct FundSummary {
		string name;
		uint256 totalSupply;
		uint256 totalFundValue;
		address manager;
		string managerName;
		uint256 creationTime;
		bool privatePool;
		uint256 performanceFeeNumerator;
		uint256 managerFeeNumerator;
		uint256 exitFeeNumerator;
		uint256 entryFeeNumerator;
		uint256 feeDenominator;
	}

	//struct TxToExecute { 
	//	address to; 
	//	bytes data; 
	//}

	struct UserReward {
		uint256 rewardDebt;
		uint256 pending;
	}


	enum RequestStatus {
		None,
		Pending,
		Finalized,
		Claimed
	}

	struct CashWithdrawRequest {
		address user;
		uint256 fusdAmountTotal; // FUSD locked for withdrawal (before fee)
		uint256 fusdNetForAsset; // FUSD to convert to asset (after fee)
		address asset;
		uint256 requestedAt;
		uint256 assetAmount; // amount of asset claimable
		RequestStatus status;
	}

	struct WithdrawProcessingLocalVars {
		address guard;
		uint256 balance;
		uint256 portionBalance;
		uint256 expectedValue;
		IAssetGuard.MultiTransaction[] transactions;
		bool regularProcessing;
		uint256 txCount;
		uint256 assetBalanceBefore;
		uint256 assetBalanceAfter;
		uint256 actualValue;
	}

	
	/// @dev Compact outputs for pro-rata withdrawal to avoid stack-too-deep.
	struct WithdrawOutputs {
		address[] assets;
		uint256[] amounts;
		uint256 count;
	}

	// ============================================================
	// =                        STORAGE                           =
	// ============================================================

	/// @notice TokenLogic (FUSD) address
	address public fusd;

	/// @notice Linked PoolManagerLogic
	address public poolManagerLogic;

	/// @notice Pool creation time
	uint256 public creationTime;

	/// @notice Reward per share in FUSD (scaled 1e18)
	uint256 public rewardPerShare;

	/// assets that users already have a claim on
    uint256 public accountedAssets;

	// Total rewards ever accrued by the protocol (USD-denominated, via rewardPerShare)
    uint256 public totalRewardAccrued;

    // Total rewards harvested (claimed) by users
    uint256 public totalRewardHarvested;

	uint256 public totalManagementFee;

	uint256 public totalPerformanceFee;

	mapping(address => UserReward) public userRewards;

	/// @notice Last timestamp when management fee accrued / minted
	uint256 public lastFeeMintTime;

	/// @notice Token price at last fee mint (for performance fee calc)
	uint256 public tokenPriceAtLastFeeMint;

    /// @notice Defines the withdraw mode for the vault
    /// @dev true  = immediate withdrawals are enabled
    ///   false = withdrawals must go through the queue mechanism
    bool public isImmediateWithdrawEnabled;

	/// @notice Queued cash withdraw requests
	uint256 public lastRequestId;
	mapping(uint256 => CashWithdrawRequest) public cashWithdrawRequests;
	mapping(address => uint256[]) public userRequests;

	/// @notice Reserved amount for finalized-but-unclaimed requests per asset.
	/// @dev Finalization doesn't transfer assets; without reserving, multiple requests could be finalized
	///      against the same balance and later claims could fail. This mapping tracks the total amount
	///      committed to Finalized requests and not yet released via claim.
	mapping(address => uint256) public reservedAssetBalance;


	// ============================================================
	// =                         ERRORS                           =
	// ============================================================

	error ZeroAmount();
	error ZeroAddress();
	error OnlyManager();
	error OnlyManagerLogic();
	error CooldownActive();
	error AssetNotSupported();
	error NotValidWithdrawableAsset();
	error InvalidRecipient();
	error NothingToHarvest();
	error InsufficientShares();
	error NoStakers();
	error SlippageExceeded();
	error EmptyFund();
	error InvalidReservedBalance();
	error InsufficientAssetBalance();
	error InvalidTransaction();
    error TxFailed();
    error InvalidGuard();
    error AssetDisabled();
	error InvalidAssetData();
	error CallbackSenderNotAllowed();
	error InvalidFundValue();
	error InvalidWithdrawRequest();
	error NonTransferable();
	error ImmediateWithdrawalDisabled();
	error QueuedWithdrawalDisabled();
	error OnlyMemberAllowed();

	    
	/// @dev Thrown when a complex withdraw attempt fails (unsupported guard or guard-level revert).
	error ComplexWithdrawFailed(address asset, address guard);

	// ============================================================
	// =                         EVENTS                           =
	// ============================================================

	event Stake(address indexed user, uint256 fusdIn, uint256 sharesMinted, uint256 entryFeeFusd);
	event Unstake(address indexed user, uint256 sharesBurned, uint256 fusdOut);

	event RewardDistributed(address indexed by, uint256 fusdGross, uint256 fusdToStakers, uint256 perfFeeFusd);
	event Harvest(address indexed user, uint256 fusdAmount);

	event ManagementFeesAccrued(uint256 feeShares, uint256 timestamp);

	event CashWithdrawImmediate(
		address indexed user,
		uint256 fusdTotal,
		uint256 fusdNet,
		uint256 fusdFee
	);

	event CashWithdrawRequested(
		uint256 indexed requestId,
		address indexed user,
		uint256 fusdTotal,
		uint256 fusdNet,
		uint256 fusdFee,
		address indexed asset
	);

	event CashWithdrawFinalized(
		uint256 indexed requestId,
		uint256 fusdTotal,
		uint256 fusdNet,
		address indexed asset,
		uint256 assetAmount
	);

	event CashWithdrawClaimed(uint256 indexed requestId, address indexed user, address indexed asset, uint256 amount);

	event TransactionExecuted(address pool, address actor, uint16 transactionType, uint256 time);

	event AccountedAssetsIncremented(uint256 amount);

	/// @notice Pro-rata immediate cash-out results across multiple assets
	event CashWithdrawImmediateProRata(
		address indexed user,
		uint256 fusdTotal,
		uint256 fusdNet,
		uint256 fusdFee,
		address[] assets,
		uint256[] amounts
	);

	/// @notice Emitted when the withdrawal mode is updated by the manager
    /// @param immediateWithdrawEnabled Whether immediate withdrawals are enabled
    event WithdrawModeUpdated(bool immediateWithdrawEnabled);

	// ============================================================
	// =                      INITIALIZATION                       =
	// ============================================================

	/// @custom:oz-upgrades-unsafe-allow constructor
	constructor() {
		_disableInitializers();
	}

	function initialize(address _fusd, address _poolManagerLogic, address _owner) external initializer {
		if (_fusd == address(0)) revert ZeroAddress();
	    if (_poolManagerLogic == address(0)) revert ZeroAddress();
	    if (_owner == address(0)) revert ZeroAddress();

		__ERC20_init("Staked Frgmnt USD", "SFUSD");
		__Ownable_init(_owner);
		__ReentrancyGuard_init();

		fusd = _fusd;
		poolManagerLogic = _poolManagerLogic;

		creationTime = block.timestamp;
		lastFeeMintTime = block.timestamp;
		tokenPriceAtLastFeeMint = 1e18;
		isImmediateWithdrawEnabled = true;
	}

	// ============================================================
	// =                     INTERNAL HELPERS                      =
	// ============================================================

	function _manager() internal view returns (address) {
		return IManaged(poolManagerLogic).manager();
	}

	function _trader() internal view returns (address) {
		return IManaged(poolManagerLogic).trader();
	}

	function _managerFees()
		internal
		view
		returns (uint256 performance, uint256 management, uint256 entry, uint256 exit, uint256 denominator)
	{
		return IPoolManagerLogic(poolManagerLogic).getFee();
	}

	function _totalValue() internal view returns (uint256) {
		return IPoolManagerLogic(poolManagerLogic).totalFundValue();
	}

	// ============================================================
	// =                MANAGEMENT FEE & REWARDS                   =
	// ============================================================

	modifier updateFeesAndRewards(address user) {
		_accrueYield();
		_updateUserReward(user);
		_;
	}

    /**
     * @dev Accrues protocol yield and manager fees, and updates reward accounting.
     *
     * This function is responsible for synchronizing the fund state with the
     * latest total value and FUSD supply, computing performance and management
     * fees, and distributing net yield to stakers.
     *
     * High-level flow:
     * 1) Read current fund value and total SFUSD supply.
     * 2) Compute incremental performance yield and performance fee using
     *    FundCalculationLibrary.calculatePerformanceFee().
     *    - Yield is computed in USD terms.
     *    - Performance fee is converted to SFUSD.
     * 3) Compute time-based management fee using
     *    FundCalculationLibrary.calculateManagementFee().
     * 4) Settle the manager's pending rewards BEFORE modifying rewardPerShare
     *    or minting new shares, to avoid retroactive reward dilution.
     * 5) Distribute net yield (after management fee) to existing stakers by
     *    increasing rewardPerShare.
     * 6) Mint performance and management fee shares to the manager.
     * 7) Update manager reward debt and persist accounting checkpoints
     *    (lastTotalValue, lastTotalFusd, lastFeeMintTime).
     *
     * IMPORTANT:
     * - Performance yield and net yield are accounted in USD terms.
     * - Fees are minted in SFUSD.
     * - The ordering of operations is critical to ensure fair reward
     *   distribution and to prevent fee minting from capturing past rewards.
     */

    function _accrueYield() internal {

        uint256 totalValue = _totalValue();
		uint256 _totalFusd = IERC20(fusd).totalSupply();

        (
            uint256 _performanceFeeNumerator,
            uint256 _managementFeeNumerator,
            ,
            ,
            uint256 _feeDenominator) = _managerFees();
       
	       (
            uint256 _performanceFee,
            uint256 _netYield) = FundCalculationLibrary.calculatePerformanceFee(
            totalValue,
            accountedAssets,
            _performanceFeeNumerator,
            _feeDenominator);

        (
            uint256 _managementFee,
            uint256 _lastFeeMintTime) = FundCalculationLibrary.calculateManagementFee(
            _totalFusd,
            lastFeeMintTime,
            _managementFeeNumerator,
            _feeDenominator
        );

        address mgr = _manager();

        // 0) Settle manager pending rewards BEFORE changing rewardPerShare or balance
        _updateUserReward(mgr);

        // 1) distribute net yield to stakers
        uint256 _supply = totalSupply();
		if ( _managementFee > _netYield) {
            _managementFee = _netYield;
        }
		_netYield = _netYield - _managementFee;
		totalRewardAccrued += _netYield;
	    totalManagementFee += totalManagementFee;
		totalPerformanceFee += totalPerformanceFee;
		accountedAssets = totalValue;
        if (_supply > 0 && _netYield > 0) {
            rewardPerShare += (_netYield * 1e18) / _supply;
        }
		
		// 2) mint performance and management fee shares to manager
		uint256 _fee = _performanceFee + _managementFee;
        if (_fee > 0) {
            ITokenLogic(fusd).mintFromPool(mgr, _fee);
        }
        // 4) Update manager rewardDebt after minting shares
        UserReward storage ur = userRewards[mgr];
        ur.rewardDebt = (balanceOf(mgr) * rewardPerShare) / 1e18;
        // 5) update state
        lastFeeMintTime = _lastFeeMintTime;
    }

	function _updateUserReward(address user) internal {
		if (user == address(0)) return;

		UserReward storage ur = userRewards[user];
		uint256 balance = balanceOf(user);
		uint256 accumulated = (balance * rewardPerShare) / 1e18;

		if (accumulated > ur.rewardDebt) {
			ur.pending += (accumulated - ur.rewardDebt);
		}

		ur.rewardDebt = accumulated;
	}

		/// @notice Called by PoolManagerLogic.commitFeeIncrease()
	function mintManagerFee() external nonReentrant {
		if (msg.sender != poolManagerLogic) revert OnlyManagerLogic();
		_accrueYield() ;
	}

	// ============================================================
	// =                           STAKE                           =
	// ============================================================

	function stake(uint256 amountFusd) external nonReentrant updateFeesAndRewards(msg.sender) {
		// Backward-compatible wrapper: no minimum output enforced by the user
		_stake(amountFusd, 0);
	}

	/// @notice Stake with user-defined minimum shares
	function stake(uint256 amountFusd, uint256 minShares) public nonReentrant updateFeesAndRewards(msg.sender) {
		_stake(amountFusd, minShares);
	}

	function _stake(uint256 amountFusd, uint256 minShares) internal {

		if (!( msg.sender == _manager() || ! IPoolManagerLogic(poolManagerLogic).privatePool() 
		    ||  IPoolManagerLogic(poolManagerLogic).isMemberAllowed(msg.sender))) 
		    revert OnlyMemberAllowed();
		
		if (amountFusd == 0) revert ZeroAmount();

		// Pull FUSD from user
		IERC20(fusd).safeTransferFrom(msg.sender, address(this), amountFusd);

		// Entry fee in FUSD
		(, , uint256 entryFeeNumerator, , uint256 feeDenominator) = _managerFees();

		uint256 feeFusd = 0;
		if (entryFeeNumerator > 0) {
			feeFusd = (amountFusd * entryFeeNumerator) / feeDenominator;
			if (feeFusd > amountFusd) {
				feeFusd = amountFusd;
			}
		}

		uint256 netFusd = amountFusd - feeFusd;
		if (netFusd == 0) revert ZeroAmount();

		// Minimum shares protection (sharesMinted == netFusd in this implementation)
		if (netFusd < minShares) revert SlippageExceeded();


		_mint(msg.sender, netFusd);

		// update rewardDebt after mint
		UserReward storage ur = userRewards[msg.sender];
		ur.rewardDebt = (balanceOf(msg.sender) * rewardPerShare) / 1e18;

		if (feeFusd > 0) {
			IERC20(fusd).safeTransfer(_manager(), feeFusd);
		}

		emit Stake(msg.sender, amountFusd, netFusd, feeFusd);
	}

	// ============================================================
	// =                          UNSTAKE                          =
	// ============================================================

	function unstake(uint256 shareAmount) external nonReentrant updateFeesAndRewards(msg.sender) {
		if (shareAmount == 0) revert ZeroAmount();
		if (balanceOf(msg.sender) < shareAmount) revert InsufficientShares();

		_burn(msg.sender, shareAmount);

		UserReward storage ur = userRewards[msg.sender];
		ur.rewardDebt = (balanceOf(msg.sender) * rewardPerShare) / 1e18;

		IERC20(fusd).safeTransfer(msg.sender, shareAmount);

		emit Unstake(msg.sender, shareAmount, shareAmount);
	}


	function harvest() external nonReentrant updateFeesAndRewards(msg.sender) {
		UserReward storage ur = userRewards[msg.sender];
		uint256 amount = ur.pending;
		if (amount == 0) revert NothingToHarvest();
		ur.pending = 0;
		totalRewardHarvested += amount;
		ITokenLogic(fusd).mintFromPool(msg.sender, amount);
		emit Harvest(msg.sender, amount);
	}

	function _applyWithdrawFeeFusd(uint256 fusdAmount) internal view returns (uint256 netFusd, uint256 feeFusd) {
		(, , , uint256 exitFeeNumerator, uint256 feeDenominator) = _managerFees();

		if (exitFeeNumerator == 0 || fusdAmount == 0) {
			return (fusdAmount, 0);
		}

		feeFusd = (fusdAmount * exitFeeNumerator) / feeDenominator;
		if (feeFusd > fusdAmount) {
			feeFusd = fusdAmount;
		}
		netFusd = fusdAmount - feeFusd;
	}

	// ============================================================
	// =                CASH WITHDRAW — IMMEDIATE                  =
	// ============================================================


	/**
    * @notice Set the withdrawal mode of the vault
    * @dev Can only be called by the manager
    *      - true  : immediate withdrawals are enabled
    *      - false : withdrawals must go through the queue mechanism
    * @param enabled Whether immediate withdrawals are enabled
    */
    function setImmediateWithdrawEnabled(bool enabled) external {
        if (msg.sender != _manager()) revert OnlyManager();
        isImmediateWithdrawEnabled = enabled;
		emit WithdrawModeUpdated(enabled);
    }

	/**
	 * @notice Immediate cash-out:
	 *  - burns FUSD from user
	 *  - applies FUSD withdraw fee
	 *  - converts net FUSD to portion of pool
	 *  - uses guard-based withdrawProcessing
	 *
	 * NOTE: Pro-rata withdrawal is performed across all supported assets (dHedge-style).
	 */

	function withdrawCashImmediate(uint256 fusdAmount) external nonReentrant updateFeesAndRewards(msg.sender) {
		IHasSupportedAsset.Asset[] memory supportedAssets = IHasSupportedAsset(poolManagerLogic).getSupportedAssets();
		ComplexAsset[] memory complexAssetsData = new ComplexAsset[](supportedAssets.length);

		_withdrawCashImmediateToSafe(msg.sender, fusdAmount, complexAssetsData);
	}

	function withdrawCashImmediateTo(
		address recipient,
		uint256 amount
	) external nonReentrant updateFeesAndRewards(msg.sender) {
		if (recipient == address(0)) revert InvalidRecipient();

		IHasSupportedAsset.Asset[] memory supportedAssets = IHasSupportedAsset(poolManagerLogic).getSupportedAssets();
		ComplexAsset[] memory complexAssetsData = new ComplexAsset[](supportedAssets.length);

		_withdrawCashImmediateToSafe(recipient, amount, complexAssetsData);
	}

	function withdrawCashImmediateSafe(
		uint256 amount,
		ComplexAsset[] calldata complexAssetsData
	) external nonReentrant updateFeesAndRewards(msg.sender) {
		_withdrawCashImmediateToSafe(msg.sender, amount, complexAssetsData);
	}

	function withdrawCashImmediateToSafe(
		address recipient,
		uint256 amount,
		ComplexAsset[] calldata complexAssetsData
	) external nonReentrant updateFeesAndRewards(msg.sender) {
		if (recipient == address(0)) revert InvalidRecipient();
		_withdrawCashImmediateToSafe(recipient, amount, complexAssetsData);
	}

	function _withdrawCashImmediateToSafe(
		address recipient,
		uint256 amount,
		ComplexAsset[] memory complexAssetsData
	) internal {
		if (!isImmediateWithdrawEnabled) revert ImmediateWithdrawalDisabled();
		if (amount == 0) revert ZeroAmount();
		uint256 netFusd;
		uint256 feeFusd;
        if(msg.sender == _manager()) {
			netFusd = amount;
			
		} else {
            // cooldown enforced only on CASH withdraw (not unstake)
		    if (ITokenLogic(fusd).getExitRemainingCooldown(msg.sender) != 0) revert CooldownActive();

		    (netFusd, feeFusd) = _applyWithdrawFeeFusd(amount);
		    if (netFusd == 0) revert ZeroAmount();

		    if (feeFusd > 0) {
			    IERC20(fusd).safeTransferFrom(msg.sender, _manager(), feeFusd);
		    }
		}
		// burn FUSD 
		ITokenLogic(fusd).burnFrom(msg.sender, netFusd);

		(address[] memory outAssets, uint256[] memory outAmounts, uint256 valueBefore) = _withdrawProRata(
			recipient,
			netFusd,
			complexAssetsData
		);

		uint256 valueAfter = _withdrawableFundValue();
		if (valueBefore < valueAfter) revert InvalidFundValue();
        if (valueBefore - valueAfter > netFusd + 1e15) revert InvalidFundValue();
		if (accountedAssets < valueBefore - valueAfter) revert InvalidFundValue();
		accountedAssets -= valueBefore - valueAfter;

		// Backward-compatible event (single-asset fields are not meaningful in pro-rata mode)
		emit CashWithdrawImmediate(msg.sender, amount, netFusd, feeFusd);
		emit CashWithdrawImmediateProRata(msg.sender, amount, netFusd, feeFusd, outAssets, outAmounts);
	}

	/// @dev Helper to reduce stack usage in withdrawCashImmediate (compile fix: avoids "stack too deep")
	function _withdrawProRata(
		address recipient,
		uint256 netFusd,
		ComplexAsset[] memory complexAssetsData
	) internal returns (address[] memory outAssets, uint256[] memory outAmounts, uint256 valueBefore) {
		// compute portion in terms of totalFundValue
		uint256 fundValue = _withdrawableFundValue();
		if (fundValue == 0) revert EmptyFund();


		uint256 portion = (netFusd * 1e18) / fundValue;

		// withdraw proportionally from ALL supported assets
		IHasSupportedAsset.Asset[] memory supportedAssets = IHasSupportedAsset(poolManagerLogic).getSupportedAssets();
		if (complexAssetsData.length != supportedAssets.length) {
	        revert InvalidAssetData();
        }

		WithdrawOutputs memory out;
		out.assets = new address[](supportedAssets.length);
		out.amounts = new uint256[](supportedAssets.length);
		out.count = 0;
		valueBefore = fundValue;

		_withdrawProRataInternal(portion, recipient, supportedAssets, complexAssetsData, out);

		outAssets = out.assets;
		outAmounts = out.amounts;

		uint256 outCount = out.count;
		assembly {
			mstore(outAssets, outCount)
			mstore(outAmounts, outCount)
		}
	}

	function _withdrawProRataInternal(
		uint256 portion, 
		address recipient,
		IHasSupportedAsset.Asset[] memory supportedAssets,
		ComplexAsset[] memory complexAssetsData,
		WithdrawOutputs memory out
	) internal {
		for (uint256 i = 0; i < supportedAssets.length; ++i) {
			address a = supportedAssets[i].asset;

			ComplexAsset memory cd = complexAssetsData[i];
			if (cd.withdrawData.length > 0) {
				if (a != cd.supportedAsset) revert InvalidAssetData();
			}

			(address withdrawAsset, uint256 withdrawAmount) = _withdrawOne(portion, recipient, a, cd);

			if (withdrawAsset != address(0) && withdrawAmount > 0) {
				out.assets[out.count] = withdrawAsset;
				out.amounts[out.count] = withdrawAmount;
				out.count++;
			}
		}
	}

	function _withdrawOne(
		uint256 portion, 
		address recipient,
		address asset,
		ComplexAsset memory cd
	) internal returns (address withdrawAsset, uint256 withdrawAmount) {
		(address wa, uint256 wamt, ) = _withdrawProcessing(asset, recipient, portion, cd);
		withdrawAsset = wa;
		withdrawAmount = wamt;

		if (withdrawAsset == address(0) || withdrawAmount == 0) {
			    return (address(0), 0);
		} else {
                IERC20(withdrawAsset).safeTransfer(recipient, withdrawAmount);
                return (withdrawAsset, withdrawAmount);
		}
	}

	// ============================================================
	// =                 CASH WITHDRAW — QUEUED                    =
	// ============================================================

	
	/**
    * @notice Queued withdraw:
    *  - FUSD is held in the contract; fees are applied
    *  - Later, the manager finalizes and converts the equivalent value of `amount` into `asset`
    *  - `asset` must be a deposited token; i.e., a simple withdrawable ERC20
    */
	function requestCashWithdraw(
		uint256 amount,
		address asset
	) external nonReentrant updateFeesAndRewards(msg.sender) returns (uint256 requestId) {

		if (isImmediateWithdrawEnabled) revert QueuedWithdrawalDisabled();
		if (amount== 0) revert ZeroAmount();
		if (!IPoolManagerLogic(poolManagerLogic).isDepositAsset(asset)) {
	        revert NotValidWithdrawableAsset();
        }
        uint256 netFusd;
		uint256 feeFusd;
		if(msg.sender == _manager()) {
			netFusd = amount;
			
		} else {
			
			if (ITokenLogic(fusd).getExitRemainingCooldown(msg.sender) != 0) 
	        revert CooldownActive();
			(netFusd, feeFusd) = _applyWithdrawFeeFusd(amount);
		    if (netFusd == 0) revert ZeroAmount();
		    // prevent creating requests that can never be finalized due to rounding to zero.
		    if (FundCalculationLibrary.fusdToAssetAmount(poolManagerLogic, netFusd, asset) == 0) revert ZeroAmount();
		}
		requestId = ++lastRequestId;
		cashWithdrawRequests[requestId] = CashWithdrawRequest({
			user: msg.sender,
			fusdAmountTotal: amount,
			fusdNetForAsset: netFusd,
			asset: asset,
			requestedAt: block.timestamp,
			assetAmount: 0,
			status: RequestStatus.Pending
		});

		userRequests[msg.sender].push(requestId);

		// lock FUSD in this contract
		IERC20(fusd).safeTransferFrom(msg.sender, address(this), amount);

		emit CashWithdrawRequested(requestId, msg.sender, amount, netFusd, feeFusd, asset);
	}

	function finalizeCashWithdraw(uint256 requestId) external nonReentrant {
		if (msg.sender != _manager()) revert OnlyManager();

		CashWithdrawRequest storage r = cashWithdrawRequests[requestId];
		if (r.status != RequestStatus.Pending) revert InvalidWithdrawRequest();
        if (r.user == address(0)) revert InvalidWithdrawRequest();

		uint256 totalFusd = r.fusdAmountTotal;
		if (totalFusd == 0) revert ZeroAmount();

		uint256 feeFusd = totalFusd - r.fusdNetForAsset;
		if (feeFusd > 0) {
			IERC20(fusd).safeTransfer(_manager(), feeFusd);
		}

		// convert netFusd to assetAmount using price
		uint256 assetAmount = FundCalculationLibrary.fusdToAssetAmount(poolManagerLogic, r.fusdNetForAsset, r.asset);
		if (assetAmount == 0) revert ZeroAmount();

		// Finalization does not transfer assets to the user; assets remain on the contract until claim.
		// Therefore we must account for other finalized-but-unclaimed requests to avoid over-allocating
		// the same on-chain balance across multiple requests.
		uint256 bal = IERC20(r.asset).balanceOf(address(this));
		uint256 reserved = reservedAssetBalance[r.asset];

		// Defensive: reserved should never exceed the actual on-chain balance.
		if (bal < reserved) revert InvalidReservedBalance();

		// Only the unreserved portion of the balance can be used for a new finalization.
		uint256 available = bal - reserved;
		if (available < assetAmount) revert InsufficientAssetBalance();


		// Reserve the amount for this request until it is claimed.
		reservedAssetBalance[r.asset] = reserved + assetAmount;

		r.assetAmount = assetAmount;
		r.status = RequestStatus.Finalized;

		emit CashWithdrawFinalized(requestId, r.fusdAmountTotal, r.fusdNetForAsset, r.asset, assetAmount);
	}

	function claimCashWithdraw(uint256 requestId) external nonReentrant updateFeesAndRewards(msg.sender) {
		CashWithdrawRequest storage r = cashWithdrawRequests[requestId];
		if (r.user != msg.sender) revert InvalidWithdrawRequest();
        if (r.status != RequestStatus.Finalized) revert InvalidWithdrawRequest();

		uint256 amount = r.assetAmount;
		if (amount == 0) revert ZeroAmount();

		// Release the reserved amount for this request.
		// If safeTransfer reverts, the whole tx reverts and the reservation remains intact.
		reservedAssetBalance[r.asset] -= amount;

		r.status = RequestStatus.Claimed;
		r.assetAmount = 0;

		// burn the FUSD locked in contract
		ITokenLogic(fusd).burn(r.fusdNetForAsset);

		IERC20(r.asset).safeTransfer(msg.sender, amount);

		if (accountedAssets < r.fusdNetForAsset) revert InvalidFundValue();
		accountedAssets -= r.fusdNetForAsset;

		emit CashWithdrawClaimed(requestId, msg.sender, r.asset, amount);
	}

	// ============================================================
	// =           dHEDGE-STYLE WITHDRAW PROCESSING                =
	// ============================================================

	// NOTE:
	// When `withdrawData` is provided, the asset guard MUST implement `IComplexAssetGuard`.
	// Standard ERC20 guards and Uniswap V3 asset guards do NOT support this interface.
	// Passing non-empty `withdrawData` for such assets will intentionally revert.
	function _withdrawProcessing(
		address asset,
		address to,
		uint256 portion,
		ComplexAsset memory complexData
	) internal returns (address withdrawAsset, uint256 withdrawAmount, bool externalProcessed) {
		WithdrawProcessingLocalVars memory v;

		v.guard = IPoolManagerLogic(poolManagerLogic).getAssetGuard(asset);
		if (v.guard == address(0)) revert InvalidGuard();

		v.balance = IAssetGuard(v.guard).getBalance(address(this), asset);
		uint256 reserved = reservedAssetBalance[asset];
		if (reserved > 0 ) {
			if (v.balance < reserved) revert InvalidReservedBalance();
			v.balance -= reserved;
		}

		v.portionBalance = (v.balance * portion) / 1e18;
		v.expectedValue = IPoolManagerLogic(poolManagerLogic).assetValue(asset, v.portionBalance);
		v.regularProcessing = true;

		if (complexData.withdrawData.length > 0) {
			if (asset != complexData.supportedAsset) revert InvalidAssetData();
			try
				IComplexAssetGuard(v.guard).withdrawProcessing(
					address(this),
					asset,
					portion,
					to,
					complexData.withdrawData
				)
			returns (address wa, uint256 wamt, IAssetGuard.MultiTransaction[] memory txs) {
				(withdrawAsset, withdrawAmount, v.transactions) = (wa, wamt, txs);
			} catch {
				revert ComplexWithdrawFailed(asset, v.guard);
			}
			v.regularProcessing = false;
		} else {
			(withdrawAsset, withdrawAmount, v.transactions) = IAssetGuard(v.guard).withdrawProcessing(
				address(this),
				asset,
				portion,
				to
			);
		}

		v.txCount = v.transactions.length;
		if (v.txCount > 0) {
			if (withdrawAsset != address(0)) {
				v.assetBalanceBefore = IERC20(withdrawAsset).balanceOf(address(this));
			}

			for (uint256 i = 0; i < v.txCount; ++i) {
				(bool success, ) = v.transactions[i].to.call(v.transactions[i].txData);
				if (!success) revert TxFailed();
				externalProcessed = true;
			}

			if (withdrawAsset != address(0)) {
				v.assetBalanceAfter = IERC20(withdrawAsset).balanceOf(address(this));
				if (v.assetBalanceAfter > v.assetBalanceBefore) {
					withdrawAmount += (v.assetBalanceAfter - v.assetBalanceBefore);
				}
			}
		}

		if (v.regularProcessing && complexData.slippageTolerance != 0 && withdrawAsset != address(0)) {
			v.actualValue = IPoolManagerLogic(poolManagerLogic).assetValue(withdrawAsset, withdrawAmount);

			if (
			    v.actualValue <
			    (v.expectedValue * (10_000 - complexData.slippageTolerance)) / 10_000
			)  revert SlippageExceeded();
		}

		return (withdrawAsset, withdrawAmount, externalProcessed);
	}


	/**
    * @notice Increase the accounted assets of the vault.
    * @dev This function is intended to be called only by TokenLogic.
    *      
    *
    * @param amount The amount of assets in USD to add to the accountedAssets.
    *
	*/              
    
	function incrementAccountedAssets(uint256 amount) external {
        // Only the TokenLogic contract can adjust accountedAssets.
        require(msg.sender == fusd, "PoolLogic: only tokenLogic");

        // Prevent accidental zero-value updates.
        require(amount > 0, "PoolLogic: zero amount");

        // Increase the accounting baseline by the specified amount.
        accountedAssets += amount;

        // Emit event for off-chain tracking and auditing.
        emit AccountedAssetsIncremented(amount);
    }

	// ============================================================
	// =           GUARDED TX EXECUTION (LIKE dHEDGE)              =
	// ============================================================

	function _execTx(address to, bytes memory data) internal returns (bool) {
	    PoolTxExecutor.ExecContext memory ctx = PoolTxExecutor.ExecContext({
		    pool: address(this),
		    poolManagerLogic: poolManagerLogic,
		    manager: _manager(),
		    trader: _trader()
	    });

	    bool success = PoolTxExecutor.exec(ctx, to, data);

	    emit TransactionExecuted(address(this), msg.sender, 0, block.timestamp);

	    return success;
    }

	
	function execTransaction(address to, bytes calldata data) external returns (bool) {
		return _execTx(to, data);
	}

	//function execTransactions(TxToExecute[] calldata txs) external {
	//	for (uint256 i; i < txs.length; ++i) {
	//		_execTx(txs[i].to, txs[i].data);
	//	}
	//}

	// ============================================================
	// =                         VIEWS                             =
	// ============================================================

	function pendingReward(address user) external view returns (uint256) {
		UserReward memory ur = userRewards[user];
		uint256 balance = balanceOf(user);
		uint256 acc = (balance * rewardPerShare) / 1e18;

		if (acc > ur.rewardDebt) {
			return ur.pending + (acc - ur.rewardDebt);
		}
		return ur.pending;
	}

	function getUserRequests(address user) external view returns (uint256[] memory) {
		return userRequests[user];
	}

	// ============================================================
	// =         MANAGER FEE VIEW LOGIC (UNMINTED FEES)           =
	// ============================================================

	/// @notice Get available manager fee of the pool
	/// @dev Can be used on the frontend by passing in fund value
	
	/// @return fee available manager fee of the pool (in pool tokens)
	function calculateAvailableManagerFee() public view returns (uint256 fee) {

        uint256 totalValue = _totalValue();
		uint256 _totalFusd = IERC20(fusd).totalSupply();

        (
            uint256 _performanceFeeNumerator,
            uint256 _managementFeeNumerator,
            ,
            ,
            uint256 _feeDenominator) = _managerFees();
       
	    (
            uint256 _performanceFee,
           
            ) = FundCalculationLibrary.calculatePerformanceFee(
            totalValue,
            accountedAssets,
            _performanceFeeNumerator,
            _feeDenominator);

        (
            uint256 _managementFee,
            ) = FundCalculationLibrary.calculateManagementFee(
            _totalFusd,
            lastFeeMintTime,
            _managementFeeNumerator,
            _feeDenominator
        );

		return _performanceFee + _managementFee;
	}


	function getFundSummary() external view returns (FundSummary memory) {
		(
			uint256 performanceFeeNumerator,
			uint256 managerFeeNumerator,
			uint256 entryFeeNumerator,
			uint256 exitFeeNumerator,
			uint256 denominator
		) = _managerFees();

		return
			FundSummary({
				name: name(),
				totalSupply:  IERC20(fusd).totalSupply(),
				totalFundValue: _totalValue(),
				manager: _manager(),
				managerName: IManaged(poolManagerLogic).managerName(),
				creationTime: creationTime,
				privatePool: IPoolManagerLogic(poolManagerLogic).privatePool(),
				performanceFeeNumerator: performanceFeeNumerator,
				managerFeeNumerator: managerFeeNumerator,
				exitFeeNumerator: exitFeeNumerator,
				entryFeeNumerator: entryFeeNumerator,
				feeDenominator: denominator
			});
	}

	function factory() external view returns (address) {
		return IPoolManagerLogic(poolManagerLogic).factory();
	}


    // ============================================================
	// = AAVE FLASHLOAN =
	// ============================================================

	/// @notice Executes operations after receiving a flashloan from Aave
	/// @param assets Array of asset addresses that were flash loaned
	/// @param amounts Array of amounts that were flash loaned
	/// @param premiums Array of premiums to pay for each borrowed asset
	/// @param initiator Address that initiated the flash loan
	/// @param params Arbitrary bytes passed to the receiver
	/// @return success Boolean indicating whether the operation was successful
	function executeOperation(
		address[] calldata assets,
		uint256[] calldata amounts,
		uint256[] calldata premiums,
		address initiator,
		bytes calldata params
	) external override returns (bool) {
		return _executeAaveFlashloan(
			assets,
			amounts,
			premiums,
			initiator,
			params
		);
	}

	// ============================================================
	// = MORPHO FLASHLOAN =
	// ============================================================

	/// @notice Executes operations after receiving a flashloan from Morpho
	/// @param assets Amount that was flash loaned
	/// @param params Arbitrary bytes passed to the receiver
	function onMorphoFlashLoan(
		uint256 assets,
		bytes calldata params
	) external override {
		_executeMorphoFlashloan(assets, params);
	}



	// ============================================================
	// =  NEW HOOKS (REQUIRED BY STATELESS MODULES) =
	// ============================================================

	function _getPoolManagerLogic()
		internal
		view
		override(
        PoolLogicFlashloanAave,
        PoolLogicFlashloanMorpho
    )
		returns (address)
	{
		return poolManagerLogic;
	}

	function _isAllowedCallbackSender(address sender)
		internal
		view
		override
		returns (bool)
	{
		return IPoolManagerLogic(poolManagerLogic).getAllowedCallbackSenders(sender);
	}


	// ============================================================
	// =                 NON-TRANSFERABLE sFUSD                    =
	// ============================================================

	/// @notice sFUSD Token: a non-transferable receipt token received when users stake their fUSD.
	///         It gives direct access to protocol yields and compounds returns automatically.
	function transfer(address, uint256) public pure override returns (bool) {
		revert NonTransferable();
	}

	/// @notice sFUSD Token: a non-transferable receipt token received when users stake their fUSD.
	///         It gives direct access to protocol yields and compounds returns automatically.
	function transferFrom(address, address, uint256) public pure override returns (bool) {
		revert NonTransferable();
	}

	/// @notice Disable approvals to prevent indirect transfers.
	function approve(address, uint256) public pure override returns (bool) {
		revert NonTransferable();
	}

	// ============================================================
	// =                   CALLBACK COMPATIBILITY                  =
	// ============================================================

	/// @notice Fallback function to gracefully accept callback calls
	///         from protocols such as Morpho that expect msg.sender
	///         to implement optional callback interfaces.
	/// @dev Prevents unintended reverts during protocol interactions.
	fallback() external {
		if (!_isAllowedCallbackSender(msg.sender)) {
	        revert CallbackSenderNotAllowed();
        }

		// Intentionally empty — simply prevents revert on unknown function selectors for allowed senders
	}

	 /**
    * @dev Computes the total *withdrawable* fund value for immediate withdrawals.
    *
    * DESIGN:
    * - AssetGuards define the total (gross) balance of each asset.
    * - PoolLogic owns `reservedAssetBalance`, which represents liquidity
    *   locked for finalized queued withdrawals.
    * - Immediate withdrawals must NOT use reserved liquidity.
	- `reservedAssetBalance` ONLY applies to ERC20 assets directly held by PoolLogic.
    * - Complex assets (Aave, Morpho, NFTs, wrappers, etc.):
    *     - do NOT expose balanceOf(pool)
    *     - MUST have reservedAssetBalance == 0
    *
    * This function computes the sum of :
    *   withdrawable balance = guardBalance - reservedBalance
    *
    */
    function _withdrawableFundValue() internal view returns (uint256 value) {
	    IHasSupportedAsset.Asset[] memory assets =
		    IHasSupportedAsset(poolManagerLogic).getSupportedAssets();

	    for (uint256 i = 0; i < assets.length; ++i) {
		    address asset = assets[i].asset;
		    address guard = IPoolManagerLogic(poolManagerLogic).getAssetGuard(asset);
            // Gross balance as defined by the AssetGuard
		    uint256 withdrawableBalance =
			    IAssetGuard(guard).getBalance(address(this), asset);
			uint256 reserved = reservedAssetBalance[asset];
		    if (reserved > 0) {
				if (withdrawableBalance < reserved) revert InvalidReservedBalance();
                withdrawableBalance -= reserved ;
			}

	        value += IPoolManagerLogic(poolManagerLogic)
			.assetValue(asset, withdrawableBalance);
        }

    }

}
