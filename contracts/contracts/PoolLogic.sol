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
import { IGuard } from "./interfaces/guards/IGuard.sol";
import { ITxTrackingGuard } from "./interfaces/guards/ITxTrackingGuard.sol";

interface ITokenLogic is IERC20 {
	function burnFrom(address account, uint256 amount) external;
	function burn(uint256 amount) external;
	function getExitRemainingCooldown(address user) external view returns (uint256);
}

contract PoolLogic is ERC20Upgradeable, OwnableUpgradeable, ReentrancyGuardUpgradeable {
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

	struct TxToExecute {
		address to;
		bytes data;
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

	// ============================================================
	// =                        STORAGE                           =
	// ============================================================

	/// @notice TokenLogic (FUSD) address
	address public fusd;

	/// @notice Linked PoolManagerLogic
	address public poolManagerLogic;

	/// @notice Pool creation time
	uint256 public creationTime;

	/// @notice For compatibility / UI only
	bool public privatePool;

	/// @notice Reward per share in FUSD (scaled 1e18)
	uint256 public rewardPerShare;

	mapping(address => UserReward) public userRewards;

	/// @notice Last timestamp when management fee accrued / minted
	uint256 public lastFeeMintTime;

	/// @notice Token price at last fee mint (for performance fee calc)
	uint256 public tokenPriceAtLastFeeMint;

	/// @notice Queued cash withdraw requests
	uint256 public lastRequestId;
	mapping(uint256 => CashWithdrawRequest) public cashWithdrawRequests;
	mapping(address => uint256[]) public userRequests;

	/// @notice Contracts allowed to invoke callback-style calls (e.g., Morpho).
	/// @dev Used by fallback to accept only known protocol callbacks.
	mapping(address => bool) public allowedCallbackSenders;

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
		uint256 fusdFee,
		address indexed asset,
		uint256 assetAmount
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

	event PoolPrivacyUpdated(bool isPoolPrivate);

	event TransactionExecuted(address pool, address actor, uint16 transactionType, uint256 time);

	// ============================================================
	// =                      INITIALIZATION                       =
	// ============================================================

	/// @custom:oz-upgrades-unsafe-allow constructor
	constructor() {
		_disableInitializers();
	}

	function initialize(address _fusd, address _poolManagerLogic, address _owner) external initializer {
		require(_fusd != address(0), "PoolLogic: fusd=0");
		require(_poolManagerLogic != address(0), "PoolLogic: managerLogic=0");
		require(_owner != address(0), "PoolLogic: owner=0");

		__ERC20_init("Staked Frgmnt USD", "SFUSD");
		__Ownable_init(_owner);
		__ReentrancyGuard_init();

		fusd = _fusd;
		poolManagerLogic = _poolManagerLogic;

		creationTime = block.timestamp;
		lastFeeMintTime = block.timestamp;
		tokenPriceAtLastFeeMint = 1e18;
		privatePool = false;
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
		uint256 dt = ts - lastFeeMintTime;
		if (dt == 0) return;

		(, uint256 managementFeeNumerator, , , uint256 feeDenominator) = _managerFees();

		if (managementFeeNumerator == 0) {
			lastFeeMintTime = ts;
			return;
		}

		uint256 supply = totalSupply();
		if (supply == 0) {
			lastFeeMintTime = ts;
			return;
		}

		// feeShares = supply * mgmtFee * dt / (denom * 365 days)
		uint256 feeShares = (supply * managementFeeNumerator * dt) / (feeDenominator * 365 days);

		if (feeShares > 0) {
			_mint(_manager(), feeShares);
			emit ManagementFeesAccrued(feeShares, ts);
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
		require(msg.sender == poolManagerLogic, "PoolLogic: only managerLogic");
		_accrueManagementFee();
	}

	// ============================================================
	// =                           STAKE                           =
	// ============================================================

	function stake(uint256 amountFusd) external nonReentrant updateFeesAndRewards(msg.sender) {
		require(amountFusd > 0, "PoolLogic: zero amount");

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
		require(netFusd > 0, "PoolLogic: netFusd=0");

		_mint(msg.sender, netFusd);

		// update rewardDebt after mint
		UserReward storage ur = userRewards[msg.sender];
		ur.rewardDebt = (balanceOf(msg.sender) * rewardPerShare) / 1e18;

		emit Stake(msg.sender, amountFusd, netFusd, feeFusd);
	}

	// ============================================================
	// =                          UNSTAKE                          =
	// ============================================================

	function unstake(uint256 shareAmount) external nonReentrant updateFeesAndRewards(msg.sender) {
		require(shareAmount > 0, "PoolLogic: zero shares");
		require(balanceOf(msg.sender) >= shareAmount, "PoolLogic: not enough shares");

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
		require(msg.sender == _manager(), "PoolLogic: only manager");
		require(amountFusd > 0, "PoolLogic: zero reward");

		uint256 supply = totalSupply();
		require(supply > 0, "PoolLogic: no stakers");

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
		require(amount > 0, "PoolLogic: nothing to harvest");

		ur.pending = 0;
		IERC20(fusd).safeTransfer(msg.sender, amount);

		emit Harvest(msg.sender, amount);
	}

	// ============================================================
	// =            FUSD → ASSET CONVERSION HELPERS                =
	// ============================================================

	function _fusdToAssetAmount(uint256 fusdAmount, address asset) internal view returns (uint256 assetAmount) {
		if (fusdAmount == 0) return 0;

		require(IHasSupportedAsset(poolManagerLogic).isSupportedAsset(asset), "PoolLogic: asset not supported");

		uint256 price = IPoolManagerLogic(poolManagerLogic).getAssetPrice(asset);
		require(price > 0, "PoolLogic: bad asset price");

		uint256 _decimals = IPoolManagerLogic(poolManagerLogic).assetDecimal(asset);

		// FUSD is USD-18
		uint256 assetAmount18 = (fusdAmount * 1e18) / price;

		if (_decimals == 18) {
			assetAmount = assetAmount18;
		} else if (_decimals < 18) {
			assetAmount = assetAmount18 / (10 ** (18 - _decimals));
		} else {
			assetAmount = assetAmount18 * (10 ** (_decimals - 18));
		}
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
	 * @notice Immediate cash-out:
	 *  - burns FUSD from user
	 *  - applies FUSD withdraw fee
	 *  - converts net FUSD to portion of pool
	 *  - uses guard-based withdrawProcessing (Option A)
	 */
	function withdrawCashImmediate(
		uint256 fusdAmount,
		address asset,
		ComplexAsset calldata complexData
	) external nonReentrant updateFeesAndRewards(msg.sender) {
		require(fusdAmount > 0, "PoolLogic: zero fusd");
		require(IHasSupportedAsset(poolManagerLogic).isSupportedAsset(asset), "PoolLogic: asset not supported");

		// cooldown enforced only on CASH withdraw (not unstake)
		require(ITokenLogic(fusd).getExitRemainingCooldown(msg.sender) == 0, "PoolLogic: cooldown");

		(uint256 netFusd, uint256 feeFusd) = _applyWithdrawFeeFusd(fusdAmount);
		require(netFusd > 0, "PoolLogic: netFusd=0");

		// burn FUSD from user
		ITokenLogic(fusd).burnFrom(msg.sender, fusdAmount);

		// compute portion in terms of totalFundValue
		uint256 fundValue = _totalValue();
		require(fundValue > 0, "PoolLogic: fund=0");

		uint256 portion = (netFusd * 1e18) / fundValue;

		(address withdrawAsset, uint256 withdrawAmount, ) = _withdrawProcessing(
			asset,
			msg.sender,
			portion,
			complexData
		);

		require(withdrawAsset != address(0), "PoolLogic: invalid withdraw asset");
		require(withdrawAmount > 0, "PoolLogic: zero withdraw");

		IERC20(withdrawAsset).safeTransfer(msg.sender, withdrawAmount);

		emit CashWithdrawImmediate(msg.sender, fusdAmount, netFusd, feeFusd, withdrawAsset, withdrawAmount);
	}

	// ============================================================
	// =                 CASH WITHDRAW — QUEUED                    =
	// ============================================================

	/**
	 * @notice Queued withdraw:
	 *  - FUSD is held in the contract, fee applied
	 *  - later manager finalizes & converts using price (no withdrawProcessing)
	 */
	function requestCashWithdraw(
		uint256 fusdAmount,
		address asset
	) external nonReentrant updateFeesAndRewards(msg.sender) returns (uint256 requestId) {
		require(fusdAmount > 0, "PoolLogic: zero fusd");
		require(IHasSupportedAsset(poolManagerLogic).isSupportedAsset(asset), "PoolLogic: asset not supported");

		require(ITokenLogic(fusd).getExitRemainingCooldown(msg.sender) == 0, "PoolLogic: cooldown");

		// lock FUSD in this contract
		IERC20(fusd).safeTransferFrom(msg.sender, address(this), fusdAmount);

		(uint256 netFusd, uint256 feeFusd) = _applyWithdrawFeeFusd(fusdAmount);
		require(netFusd > 0, "PoolLogic: netFusd=0");

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

		emit CashWithdrawRequested(requestId, msg.sender, fusdAmount, netFusd, feeFusd, asset);
	}

	function finalizeCashWithdraw(uint256 requestId) external nonReentrant {
		require(msg.sender == _manager(), "PoolLogic: only manager");

		CashWithdrawRequest storage r = cashWithdrawRequests[requestId];
		require(r.status == RequestStatus.Pending, "PoolLogic: not pending");
		require(r.user != address(0), "PoolLogic: invalid request");

		uint256 totalFusd = r.fusdAmountTotal;
		require(totalFusd > 0, "PoolLogic: zero fusd");

		// burn the FUSD locked in contract
		ITokenLogic(fusd).burn(totalFusd);

		// convert netFusd to assetAmount using price
		uint256 assetAmount = _fusdToAssetAmount(r.fusdNetForAsset, r.asset);
		require(assetAmount > 0, "PoolLogic: assetAmount=0");
		require(IERC20(r.asset).balanceOf(address(this)) >= assetAmount, "PoolLogic: insufficient asset");

		r.assetAmount = assetAmount;
		r.status = RequestStatus.Finalized;

		emit CashWithdrawFinalized(requestId, r.fusdAmountTotal, r.fusdNetForAsset, r.asset, assetAmount);
	}

	function claimCashWithdraw(uint256 requestId) external nonReentrant updateFeesAndRewards(msg.sender) {
		CashWithdrawRequest storage r = cashWithdrawRequests[requestId];
		require(r.user == msg.sender, "PoolLogic: not owner");
		require(r.status == RequestStatus.Finalized, "PoolLogic: not finalized");

		uint256 amount = r.assetAmount;
		require(amount > 0, "PoolLogic: zero asset");

		r.status = RequestStatus.Claimed;
		r.assetAmount = 0;

		IERC20(r.asset).safeTransfer(msg.sender, amount);

		emit CashWithdrawClaimed(requestId, msg.sender, r.asset, amount);
	}

	// ============================================================
	// =           dHEDGE-STYLE WITHDRAW PROCESSING                =
	// ============================================================

	function _withdrawProcessing(
		address asset,
		address to,
		uint256 portion,
		ComplexAsset calldata complexData
	) internal returns (address withdrawAsset, uint256 withdrawAmount, bool externalProcessed) {
		WithdrawProcessingLocalVars memory v;

		v.guard = IPoolManagerLogic(poolManagerLogic).getAssetGuard(asset);
		require(v.guard != address(0), "PoolLogic: invalid guard");

		v.balance = IAssetGuard(v.guard).getBalance(address(this), asset);
		v.portionBalance = (v.balance * portion) / 1e18;

		v.expectedValue = IPoolManagerLogic(poolManagerLogic).assetValue(asset, v.portionBalance);

		v.regularProcessing = true;

		if (complexData.withdrawData.length > 0) {
			require(asset == complexData.supportedAsset, "PoolLogic: invalid asset data");

			(withdrawAsset, withdrawAmount, v.transactions) = IComplexAssetGuard(v.guard).withdrawProcessing(
				address(this),
				asset,
				portion,
				to,
				complexData.withdrawData
			);

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
				require(success, "PoolLogic: withdraw tx failed");
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

			require(
				v.actualValue >= (v.expectedValue * (10_000 - complexData.slippageTolerance)) / 10_000,
				"PoolLogic: high withdraw slippage"
			);
		}

		return (withdrawAsset, withdrawAmount, externalProcessed);
	}

	// ============================================================
	// =           GUARDED TX EXECUTION (LIKE dHEDGE)              =
	// ============================================================

	function _resolveGuard(
		address to,
		bytes memory data
	) internal returns (address guard, uint16 txType, bool isPublic) {
		// 1) Try contract guard
		address contractGuard = IPoolManagerLogic(poolManagerLogic).getContractGuard(to);

		if (contractGuard != address(0)) {
			guard = contractGuard;
			(txType, isPublic) = IGuard(guard).txGuard(poolManagerLogic, to, data);
		}

		// 2) If no valid txType, fallback to asset guard
		if (txType == 0) {
			address assetGuard = IPoolManagerLogic(poolManagerLogic).getAssetGuard(to);

			if (assetGuard == address(0)) {
				revert("PoolLogic: no guard");
			}

			require(IHasSupportedAsset(poolManagerLogic).isSupportedAsset(to), "PoolLogic: asset disabled");

			guard = assetGuard;
			(txType, isPublic) = IGuard(guard).txGuard(poolManagerLogic, to, data);
		}
	}

	function _afterTxGuard(address guard, address to, bytes memory data) internal {
		(bool hasFn, bytes memory ret) = guard.call(abi.encodeWithSignature("isTxTrackingGuard()"));

		if (!hasFn || ret.length != 32) {
			return;
		}

		bool tracking = abi.decode(ret, (bool));
		if (!tracking) return;

		ITxTrackingGuard(guard).afterTxGuard(poolManagerLogic, to, data);
	}

	function _execTransaction(address to, bytes memory data) private nonReentrant returns (bool success) {
		require(to != address(0), "PoolLogic: to=0");

		(address guard, uint16 txType, bool isPublic) = _resolveGuard(to, data);

		require(txType > 0, "PoolLogic: invalid transaction");
		require(
			isPublic || msg.sender == _manager() || msg.sender == _trader(),
			"PoolLogic: only manager/trader/public"
		);

		(success, ) = to.call(data);
		require(success, "PoolLogic: tx failed");

		_afterTxGuard(guard, to, data);

		emit TransactionExecuted(address(this), msg.sender, txType, block.timestamp);
	}

	function execTransaction(address to, bytes calldata data) external returns (bool) {
		return _execTransaction(to, data);
	}

	function execTransactions(TxToExecute[] calldata txs) external {
		for (uint256 i; i < txs.length; ++i) {
			require(_execTransaction(txs[i].to, txs[i].data), "PoolLogic: tx failed");
		}
	}

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
			uint256 denominator
		) = _managerFees();

		(uint256 performanceFee, uint256 streamingFee) = _availableManagerFee(
			_fundValue,
			totalSupply(),
			performanceFeeNumerator,
			managementFeeNumerator,
			denominator
		);

		return performanceFee + streamingFee;
	}

	/// @notice Get available manager fee of the pool internal call
	/// @param _fundValue The total fund value of the pool
	/// @param _tokenSupply The total token supply of the pool
	/// @param _performanceFeeNumerator Performance fee numerator
	/// @param _managerFeeNumerator Management fee numerator
	/// @param _feeDenominator Fee denominator
	/// @return performanceFee Performance fee generated by the pool (in pool tokens)
	/// @return streamingFee Management fee generated by the pool (in pool tokens)
	function _availableManagerFee(
		uint256 _fundValue,
		uint256 _tokenSupply,
		uint256 _performanceFeeNumerator,
		uint256 _managerFeeNumerator,
		uint256 _feeDenominator
	) internal view returns (uint256 performanceFee, uint256 streamingFee) {
		if (_tokenSupply == 0 || _fundValue == 0) return (0, 0);

		uint256 currentTokenPrice = (_fundValue * 1e18) / _tokenSupply;

		// Performance fee based on price increase since last fee mint
		if (currentTokenPrice > tokenPriceAtLastFeeMint) {
			uint256 feeUsdAmount = (
				(currentTokenPrice - tokenPriceAtLastFeeMint) *
					_performanceFeeNumerator *
					_tokenSupply
			) / (_feeDenominator * 1e18);

			// Convert USD fee amount to pool token amount
			// performanceFee = feeUsdAmount / (fundValue - feeUsdAmount) * tokenSupply
			performanceFee = (feeUsdAmount * _tokenSupply) / (_fundValue - feeUsdAmount);
		}

		// Streaming (management) fee from lastFeeMintTime to now
		if (lastFeeMintTime != 0) {
			uint256 timeChange = block.timestamp - lastFeeMintTime;
			streamingFee =
				(_tokenSupply * timeChange * _managerFeeNumerator) /
				_feeDenominator /
				365 days;
		}
	}

	// ============================================================
	// =                TOKEN PRICE / FUND SUMMARY                 =
	// ============================================================

	function _tokenPrice(uint256 fundValue, uint256 tokenSupply) internal pure returns (uint256 price) {
		if (tokenSupply == 0 || fundValue == 0) return 0;
		price = (fundValue * 1e18) / tokenSupply;
	}

	/// @notice Get price of the pool token adjusted for any unminted manager fees
	/// @return price A price of the pool
	function tokenPrice() external view returns (uint256 price) {
		uint256 fundValue = _totalValue();
		uint256 tokenSupply = totalSupply() + calculateAvailableManagerFee(fundValue);
		price = _tokenPrice(fundValue, tokenSupply);
	}

	/// @notice Get price of the pool token ignoring unminted manager fees
	function tokenPriceWithoutManagerFee() external view returns (uint256 price) {
		uint256 fundValue = _totalValue();
		uint256 supply = totalSupply();
		price = _tokenPrice(fundValue, supply);
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
				privatePool: privatePool,
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
	// =                     PRIVACY FLAG                          =
	// ============================================================

	function setPoolPrivate(bool _privatePool) external {
		require(msg.sender == _manager(), "PoolLogic: only manager");
		privatePool = _privatePool;
		emit PoolPrivacyUpdated(_privatePool);
	}

	// ============================================================
	// =                 CALLBACK SENDER WHITELIST                 =
	// ============================================================

	/// @notice Allow/deny protocol contracts that call back into this PoolLogic (e.g., Morpho callbacks).
	/// @dev Whitelist the protocol contract address that performs the callback (e.g., Morpho),
	///      NOT the guard contract.
	function setAllowedCallbackSender(address protocol, bool allowed) external {
		require(msg.sender == _manager(), "PoolLogic: only manager");
		require(protocol != address(0), "PoolLogic: protocol=0");
		allowedCallbackSenders[protocol] = allowed;
	}

	// ============================================================
	// =                 NON-TRANSFERABLE sFUSD                   =
	// ============================================================

	/// @notice sFUSD Token: a non-transferable receipt token received when users stake their fUSD.
	///         It gives direct access to protocol yields and compounds returns automatically.
	function transfer(address, uint256) public pure override returns (bool) {
		revert("PoolLogic: sFUSD is non-transferable");
	}

	/// @notice sFUSD Token: a non-transferable receipt token received when users stake their fUSD.
	///         It gives direct access to protocol yields and compounds returns automatically.
	function transferFrom(address, address, uint256) public pure override returns (bool) {
		revert("PoolLogic: sFUSD is non-transferable");
	}

	/// @notice Disable approvals to prevent indirect transfers.
	function approve(address, uint256) public pure override returns (bool) {
		revert("PoolLogic: sFUSD is non-transferable");
	}

	// ============================================================
	// =                   CALLBACK COMPATIBILITY                  =
	// ============================================================

	/// @notice Fallback function to gracefully accept callback calls
	///         from protocols such as Morpho that expect msg.sender
	///         to implement optional callback interfaces.
	/// @dev Prevents unintended reverts during protocol interactions.
	fallback() external {
		require(allowedCallbackSenders[msg.sender], "PoolLogic: callback sender not allowed");
		// Intentionally empty — simply prevents revert on unknown function selectors for allowed senders
	}
}
