// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IManaged } from "./interfaces/IManaged.sol";
import { IPoolManagerLogic } from "./interfaces/IPoolManagerLogic.sol";
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
}

contract PoolLogic is ERC20Upgradeable, OwnableUpgradeable, ReentrancyGuardUpgradeable,
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
		uint256 managerFeeDenominator;
		uint256 exitFeeNumerator;
		uint256 exitFeeDenominator;
		uint256 entryFeeNumerator;
	}

	//struct TxToExecute { 
	//	address to; 
	//	bytes data; 
	//}

	struct UserReward {
		uint256 rewardDebt;
		uint256 pending;
	}

	/// @notice Complex withdraw parameters (like IPoolLogic.ComplexAsset)
	struct ComplexAsset {
		address supportedAsset;
		bytes withdrawData;
		uint256 slippageTolerance; // in bps, e.g. 100 = 1%
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

	/// @dev Compact context for pro-rata withdrawal to avoid stack-too-deep.
	struct WithdrawProRataContext {
		address recipient;
		uint256 portion;
		address[] erc20Assets;
		uint256[] erc20BalanceBefore;
		uint256 erc20Count;
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
		_accrueManagementFee();
		_updateUserReward(user);
		_;
	}

	function _accrueManagementFee() internal {
		uint256 ts = block.timestamp;

		// If no supply, nothing to mint, but still move the clock forward
		uint256 supply = totalSupply();
		if (supply == 0) {
			lastFeeMintTime = ts;
			return;
		}

		uint256 fundValue = _totalValue();
		if (fundValue == 0) {
			lastFeeMintTime = ts;
			return;
		}

		(
			uint256 performanceFeeNumerator,
			uint256 managementFeeNumerator,
			,
			,
			uint256 feeDenominator
		) = _managerFees();

		(uint256 performanceFee, uint256 streamingFee) = FundCalculationLibrary.availableManagerFee(
			fundValue,
			supply,
			performanceFeeNumerator,
			managementFeeNumerator,
			feeDenominator,
			tokenPriceAtLastFeeMint,
			lastFeeMintTime
		);

		uint256 feeShares = performanceFee + streamingFee;

		if (feeShares > 0) {
			address mgr = _manager();
			_updateUserReward(mgr);

			_mint(mgr, feeShares);
			emit ManagementFeesAccrued(feeShares, ts);

			UserReward storage ur = userRewards[mgr];
			ur.rewardDebt = (balanceOf(mgr) * rewardPerShare) / 1e18;

			tokenPriceAtLastFeeMint = (fundValue * 1e18) / supply;
		}

		lastFeeMintTime = ts;
	}

	function _updateUserReward(address user) internal {
		if (user == address(0)) return;

		UserReward storage ur = userRewards[user];
		uint256 balance = balanceOf(user);
		uint256 accumulated = (balance * rewardPerShare) / 1e18;

		if (accumulated > ur.rewardDebt) {
			ur.pending += (accumulated - ur.rewardDebt);
		}

		ur.rewardDebt = (balance * rewardPerShare) / 1e18;
	}

	/// @notice Called by PoolManagerLogic.commitFeeIncrease()
	function mintManagerFee() external nonReentrant {
		if (msg.sender != poolManagerLogic) revert OnlyManagerLogic();
		_accrueManagementFee();
	}

	// ============================================================
	// =                           STAKE                           =
	// ============================================================

	function stake(uint256 amountFusd) external nonReentrant updateFeesAndRewards(msg.sender) {
		// Backward-compatible wrapper: no minimum output enforced by the user
		// NOTE: must not call another nonReentrant function (would revert).
		_stake(amountFusd, 0);
	}

	/// @notice Stake with user-defined minimum shares
	function stake(uint256 amountFusd, uint256 minShares) public nonReentrant updateFeesAndRewards(msg.sender) {
		_stake(amountFusd, minShares);
	}

	function _stake(uint256 amountFusd, uint256 minShares) internal {
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

	// ============================================================
	// =                       REWARD LOGIC                        =
	// ============================================================

	function distributeReward(
		uint256 amountFusd
	)
		external
		nonReentrant
		updateFeesAndRewards(address(0)) // global update
	{
		if (msg.sender != _manager()) revert OnlyManager();
		if (amountFusd == 0) revert ZeroAmount();

		uint256 supply = totalSupply();
		if (supply == 0) revert NoStakers();

		// Pull FUSD from manager
		IERC20(fusd).safeTransferFrom(msg.sender, address(this), amountFusd);

		(uint256 performanceFeeNumerator, , , , uint256 feeDenominator) = _managerFees();

		uint256 perfFee = 0;
		if (performanceFeeNumerator > 0) {
			perfFee = (amountFusd * performanceFeeNumerator) / feeDenominator;
			if (perfFee > amountFusd) {
				perfFee = amountFusd;
			}
		}

		uint256 toStakers = amountFusd - perfFee;

		if (perfFee > 0) {
			IERC20(fusd).safeTransfer(_manager(), perfFee);
		}

		rewardPerShare += (toStakers * 1e18) / supply;

		emit RewardDistributed(msg.sender, amountFusd, toStakers, perfFee);
	}

	function harvest() external nonReentrant updateFeesAndRewards(msg.sender) {
		UserReward storage ur = userRewards[msg.sender];
		uint256 amount = ur.pending;
		if (amount == 0) revert NothingToHarvest();

		ur.pending = 0;
		IERC20(fusd).safeTransfer(msg.sender, amount);

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
		uint256 fusdAmount
	) external nonReentrant updateFeesAndRewards(msg.sender) {
		if (recipient == address(0)) revert InvalidRecipient();

		IHasSupportedAsset.Asset[] memory supportedAssets = IHasSupportedAsset(poolManagerLogic).getSupportedAssets();
		ComplexAsset[] memory complexAssetsData = new ComplexAsset[](supportedAssets.length);

		_withdrawCashImmediateToSafe(recipient, fusdAmount, complexAssetsData);
	}

	function withdrawCashImmediateSafe(
		uint256 fusdAmount,
		ComplexAsset[] calldata complexAssetsData
	) external nonReentrant updateFeesAndRewards(msg.sender) {
		_withdrawCashImmediateToSafe(msg.sender, fusdAmount, complexAssetsData);
	}

	function withdrawCashImmediateToSafe(
		address recipient,
		uint256 fusdAmount,
		ComplexAsset[] calldata complexAssetsData
	) external nonReentrant updateFeesAndRewards(msg.sender) {
		if (recipient == address(0)) revert InvalidRecipient();
		_withdrawCashImmediateToSafe(recipient, fusdAmount, complexAssetsData);
	}

	function _withdrawCashImmediateToSafe(
		address recipient,
		uint256 fusdAmount,
		ComplexAsset[] memory complexAssetsData
	) internal {
		if (!isImmediateWithdrawEnabled) revert ImmediateWithdrawalDisabled();
		if (fusdAmount == 0) revert ZeroAmount();
		// cooldown enforced only on CASH withdraw (not unstake)
		if (ITokenLogic(fusd).getExitRemainingCooldown(msg.sender) != 0) revert CooldownActive();

		(uint256 netFusd, uint256 feeFusd) = _applyWithdrawFeeFusd(fusdAmount);
		if (netFusd == 0) revert ZeroAmount();

		if (feeFusd > 0) {
			IERC20(fusd).safeTransferFrom(msg.sender, _manager(), feeFusd);
		}

		// burn FUSD from user
		ITokenLogic(fusd).burnFrom(msg.sender, netFusd);

		(address[] memory outAssets, uint256[] memory outAmounts, uint256 valueBefore) = _withdrawProRata(
			recipient,
			netFusd,
			complexAssetsData
		);

		uint256 valueAfter = _withdrawableFundValue();
		if (valueBefore < valueAfter) revert InvalidFundValue();
        if (valueBefore - valueAfter > netFusd + 1e15) revert InvalidFundValue();

		// Backward-compatible event (single-asset fields are not meaningful in pro-rata mode)
		emit CashWithdrawImmediate(msg.sender, fusdAmount, netFusd, feeFusd);
		emit CashWithdrawImmediateProRata(msg.sender, fusdAmount, netFusd, feeFusd, outAssets, outAmounts);
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

		// Invariant-style check: total value removed should not exceed netFusd (plus rounding tolerance)
		valueBefore = fundValue;

		// --------------------------------------------------------------------
		// Important accounting note:
		// Some non-ERC20 / complex assets may "realize" underlying ERC20s back to this contract
		// as part of their guard transactions (e.g. a "collect" that transfers tokens to PoolLogic).
		//
		// Those realized underlying tokens have already been scaled by `portion` at the complex-asset level.
		// When we later iterate ERC20 assets, we must avoid scaling these newly received tokens by `portion` again.
		//
		// To achieve this with minimal changes:
		//   - Snapshot ERC20 balances of supported assets BEFORE any processing.
		//   - When processing an ERC20, transfer:
		//         (preBalance * portion) + (currentBalance - preBalance)
		//     where (currentBalance - preBalance) is the amount realized during this withdraw.
		// --------------------------------------------------------------------
		WithdrawProRataContext memory ctx;
		ctx.recipient = recipient;
		ctx.portion = portion;
		ctx.erc20Assets = new address[](supportedAssets.length);
		ctx.erc20BalanceBefore = new uint256[](supportedAssets.length);
		ctx.erc20Count = 0;

		for (uint256 i = 0; i < supportedAssets.length; ++i) {
			address a0 = supportedAssets[i].asset;

			(bool ok, uint256 bal0) = FundCalculationLibrary.tryBalanceOf(a0, address(this));
			if (ok) {
				// snapshot only the available (unreserved) balance for ERC20 assets
				uint256 reserved0 = reservedAssetBalance[a0];
				if (bal0 < reserved0) revert InvalidReservedBalance();


				ctx.erc20Assets[ctx.erc20Count] = a0;
				ctx.erc20BalanceBefore[ctx.erc20Count] = bal0 - reserved0;
				ctx.erc20Count++;
			}
		}

		_withdrawProRataInternal(ctx, supportedAssets, complexAssetsData, out);

		outAssets = out.assets;
		outAmounts = out.amounts;

		uint256 outCount = out.count;
		assembly {
			mstore(outAssets, outCount)
			mstore(outAmounts, outCount)
		}
	}

	function _withdrawProRataInternal(
		WithdrawProRataContext memory ctx,
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

			(address withdrawAsset, uint256 withdrawAmount) = _withdrawOne(ctx, a, cd);

			if (withdrawAsset != address(0) && withdrawAmount > 0) {
				out.assets[out.count] = withdrawAsset;
				out.amounts[out.count] = withdrawAmount;
				out.count++;
			}
		}
	}

	function _withdrawOne(
		WithdrawProRataContext memory ctx,
		address asset,
		ComplexAsset memory cd
	) internal returns (address withdrawAsset, uint256 withdrawAmount) {
		(address wa, uint256 wamt, ) = _withdrawProcessing(asset, address(this), ctx.portion, cd);
		withdrawAsset = wa;
		withdrawAmount = wamt;

		if (withdrawAsset == address(0) || withdrawAmount == 0) {
			return (address(0), 0);
		}

		withdrawAmount = _adjustErc20WithdrawAmount(
			withdrawAsset,
			ctx.portion,
			ctx.erc20Assets,
			ctx.erc20BalanceBefore,
			ctx.erc20Count,
			withdrawAmount
		);

		IERC20(withdrawAsset).safeTransfer(ctx.recipient, withdrawAmount);

		return (withdrawAsset, withdrawAmount);
	}

	/// @dev Adjust ERC20 withdraw amount to avoid scaling newly realized tokens by `portion` again.
	///      Works on in-memory snapshots and updates the baseline defensively.
	function _adjustErc20WithdrawAmount(
		address withdrawAsset,
		uint256 portion,
		address[] memory erc20Assets,
		uint256[] memory erc20BalanceBefore,
		uint256 erc20Count,
		uint256 originalWithdrawAmount
	) internal view returns (uint256 withdrawAmount) {
		uint256 idx = 0;
		bool found = false;

		for (uint256 i = 0; i < erc20Count; ++i) {
			if (erc20Assets[i] == withdrawAsset) {
				idx = i;
				found = true;
				break;
			}
		}

		if (!found) {
			return originalWithdrawAmount;
		}

		// all computations are on *available* balances (excluding reserved)
		uint256 beforeAvail = erc20BalanceBefore[idx];

		uint256 currentBal = IERC20(withdrawAsset).balanceOf(address(this));
		uint256 reserved = reservedAssetBalance[withdrawAsset];
		if (currentBal < reserved) revert InvalidReservedBalance();

		uint256 currentAvail = currentBal - reserved;
		if (currentAvail < beforeAvail) revert InvalidReservedBalance();

		uint256 deltaAvail = currentAvail - beforeAvail;
		uint256 basePortion = (beforeAvail * portion) / 1e18;

		uint256 adjusted = basePortion + deltaAvail;
		if (adjusted > currentAvail) {
			adjusted = currentAvail;
		}

		// Update baseline defensively (in case the same ERC20 is encountered again)
		erc20BalanceBefore[idx] = currentAvail - adjusted;

		return adjusted;
	}

	// ============================================================
	// =                 CASH WITHDRAW — QUEUED                    =
	// ============================================================

	
	/**
    * @notice Queued withdraw:
    *  - FUSD is held in the contract; fees are applied
    *  - Later, the manager finalizes and converts the equivalent value of `fusdAmount` into `asset`
    *  - `asset` must be a deposited token; i.e., a simple withdrawable ERC20
    */
	function requestCashWithdraw(
		uint256 fusdAmount,
		address asset
	) external nonReentrant updateFeesAndRewards(msg.sender) returns (uint256 requestId) {

		if (isImmediateWithdrawEnabled) revert QueuedWithdrawalDisabled();
		if (fusdAmount== 0) revert ZeroAmount();
		if (!IPoolManagerLogic(poolManagerLogic).isDepositAsset(asset)) {
	        revert NotValidWithdrawableAsset();
        }

		if (ITokenLogic(fusd).getExitRemainingCooldown(msg.sender) != 0) {
	        revert CooldownActive();
        }

		(uint256 netFusd, uint256 feeFusd) = _applyWithdrawFeeFusd(fusdAmount);
		if (netFusd == 0) revert ZeroAmount();
		// prevent creating requests that can never be finalized due to rounding to zero.
		if (FundCalculationLibrary.fusdToAssetAmount(poolManagerLogic, netFusd, asset) == 0) revert ZeroAmount();

		requestId = ++lastRequestId;
		cashWithdrawRequests[requestId] = CashWithdrawRequest({
			user: msg.sender,
			fusdAmountTotal: fusdAmount,
			fusdNetForAsset: netFusd,
			asset: asset,
			requestedAt: block.timestamp,
			assetAmount: 0,
			status: RequestStatus.Pending
		});

		userRequests[msg.sender].push(requestId);

		// lock FUSD in this contract
		IERC20(fusd).safeTransferFrom(msg.sender, address(this), fusdAmount);

		emit CashWithdrawRequested(requestId, msg.sender, fusdAmount, netFusd, feeFusd, asset);
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

		// burn the FUSD locked in contract
		ITokenLogic(fusd).burn(r.fusdNetForAsset);

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

		IERC20(r.asset).safeTransfer(msg.sender, amount);

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

		// exclude amounts reserved for finalized queued withdrawals (ERC20 only)
		(bool ok, uint256 bal0) = FundCalculationLibrary.tryBalanceOf(asset, address(this));
		if (ok) {
			uint256 reserved = reservedAssetBalance[asset];
			if (bal0 < reserved) revert InvalidReservedBalance();

			uint256 available = bal0 - reserved;
			if (v.balance > available) {
				v.balance = available;
			}
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
	/// @param _fundValue The total fund value of the pool
	/// @return fee available manager fee of the pool (in pool tokens)
	function calculateAvailableManagerFee(uint256 _fundValue) public view returns (uint256 fee) {
		(
			uint256 performanceFeeNumerator,
			uint256 managementFeeNumerator,
			,
			,
			uint256 feeDenominator
		) = _managerFees();

		(uint256 performanceFee, uint256 streamingFee) = FundCalculationLibrary.availableManagerFee(
			_fundValue,
			totalSupply(),
			performanceFeeNumerator,
			managementFeeNumerator,
			feeDenominator,
			tokenPriceAtLastFeeMint,
			lastFeeMintTime
		);

		return performanceFee + streamingFee;
	}

	
	// ============================================================
	// =                TOKEN PRICE / FUND SUMMARY                 =
	// ============================================================

	/// @notice Get price of the pool token adjusted for any unminted manager fees
	/// @return price A price of the pool
	function tokenPrice() external view returns (uint256 price) {
		uint256 fundValue = _totalValue();
		uint256 tokenSupply = totalSupply() + calculateAvailableManagerFee(fundValue);
		price = FundCalculationLibrary.tokenPrice(fundValue, tokenSupply);
	}

	/// @notice Get price of the pool token ignoring unminted manager fees
	function tokenPriceWithoutManagerFee() external view returns (uint256 price) {
		uint256 fundValue = _totalValue();
		uint256 supply = totalSupply();
		price = FundCalculationLibrary.tokenPrice(fundValue, supply);
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
				totalSupply: totalSupply(),
				totalFundValue: _totalValue(),
				manager: _manager(),
				managerName: IManaged(poolManagerLogic).managerName(),
				creationTime: creationTime,
				privatePool: IPoolManagerLogic(poolManagerLogic).privatePool(),
				performanceFeeNumerator: performanceFeeNumerator,
				managerFeeNumerator: managerFeeNumerator,
				managerFeeDenominator: denominator,
				exitFeeNumerator: exitFeeNumerator,
				exitFeeDenominator: denominator,
				entryFeeNumerator: entryFeeNumerator
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
            // Check if the asset exposes an ERC20 balanceOf(pool)
		    (bool isErc20, uint256 onchainBal) =
			   FundCalculationLibrary.tryBalanceOf(asset, address(this));
		    if (isErc20) {
			    uint256 reserved = reservedAssetBalance[asset];
		// Defensive: reserved should never exceed on-chain balance
			    if (onchainBal <= reserved) {
				    withdrawableBalance = 0;
			    } else {
				    uint256 available = onchainBal - reserved;
				    // Cap guard balance to transferable amount
				    if (withdrawableBalance > available) {
					    withdrawableBalance = available;
				    }
			    }
		    }

	        value += IPoolManagerLogic(poolManagerLogic)
			.assetValue(asset, withdrawableBalance);
        }

    }

}
