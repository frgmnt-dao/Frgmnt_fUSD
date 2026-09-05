// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

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

interface IUserActionSender {
    function actionUser() external view returns (address);
}

contract PoolLogic is
    IPoolLogic,
    ERC20Upgradeable,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable,
    IFlashLoanReceiver,
    IMorphoFlashLoanCallback,
    PoolLogicFlashloanAave,
    PoolLogicFlashloanMorpho
{
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
        Claimed,
        // FNA-03: appended at the end, not inserted, so the existing numeric values above
        // (Pending=1, Finalized=2, Claimed=3) never shift for any request already stored
        // on-chain before this upgrade. Same as Finalized, except assetAmount was moved into
        // withdrawalEscrow rather than left bookkept via reservedAssetBalance — see
        // finalizeCashWithdraw()/claimCashWithdraw().
        FinalizedEscrowed
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

    /// @notice Legacy reward-per-share accumulator retained for upgrade migration.
    uint256 public rewardPerShare;

    /// assets that users already have a claim on
    uint256 public accountedAssets;

    // Total rewards ever accrued by the protocol (USD-denominated)
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

    /// @notice Compounded reward index for implicit auto-compounding rewards, scaled by 1e18.
    uint256 public compoundedRewardIndex;

    /// @notice Old rewardPerShare snapshot used to lazily migrate existing stakers.
    uint256 public autoCompoundStartRewardPerShare;

    /// @notice Tracks users already migrated from rewardDebt accounting to index snapshots.
    mapping(address => bool) public rewardIndexInitialized;

    /// @notice FNA-03: dedicated escrow holding finalized-but-unclaimed queued-withdrawal
    ///         assets, physically segregated from this pool's own balance. Wired once via
    ///         initializeWithdrawalEscrow() below.
    address public withdrawalEscrow;

    /// @notice FNA-38: sum of fusdNetForAsset across every request currently
    ///         Finalized/FinalizedEscrowed but not yet Claimed. finalizeCashWithdraw() already
    ///         carves that request's backing asset out of active NAV immediately, but its FUSD
    ///         isn't burned until claimCashWithdraw() — leaving it counted as an active claim in
    ///         totalSupply() in the meantime would double-count the same value against remaining
    ///         holders. See computeImmediateWithdrawPortion()/computeFinalizeAssetAmount().
    /// @dev Only ever incremented for a FinalizedEscrowed request and decremented on its claim —
    ///      never touches a legacy, pre-FNA-38 plain-Finalized request, which was never added
    ///      here to begin with (this counter starts at 0 on upgrade, regardless of any such
    ///      request already outstanding at the time — a bounded, self-correcting gap: it only
    ///      ever *under*-excludes claims until any such legacy request is itself claimed, never
    ///      over-excludes).
    uint256 public finalizedUnclaimedFusd;

    // ============================================================
    // =                         ERRORS                           =
    // ============================================================

    error ZeroAmount();
    error ZeroAddress();
    error EmptyMetadata();
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
    error WithdrawAmountTooSmall();
    error AutoCompoundingAlreadyInitialized();
    error AutoCompoundingNotInitialized();
    error EscrowAlreadySet();
    /// @dev Thrown when a complex withdraw attempt fails (unsupported guard or guard-level revert).
    error ComplexWithdrawFailed(address asset, address guard);
    error OnlyTokenLogic();
    error InvalidCallData();

    // ============================================================
    // =                         EVENTS                           =
    // ============================================================

    event Stake(address indexed user, uint256 fusdIn, uint256 sharesMinted, uint256 entryFeeFusd);
    event Unstake(address indexed user, uint256 sharesBurned, uint256 fusdOut);

    /// @notice CertiK FNA-04 follow-up (09/03 comment): stake/unstake/harvest/mintManagerFee
    ///         deliberately stay fail-open on incomplete NAV (see the design note on
    ///         computeYieldAccrual()) rather than reverting like checkpointFeesForDeposit() does
    ///         — but that silent skip previously had zero on-chain signal. CertiK's own
    ///         recommendation for this accepted-risk design was operational monitoring of
    ///         "incomplete-NAV events and the associated changes in sFUSD ownership"; this event
    ///         is what actually makes that monitorable, naming the exact actor whose
    ///         stake/unstake/harvest went through while accrual was skipped.
    event IncompleteNAVAccrual(address indexed actor, uint256 timestamp);

    event RewardDistributed(
        address indexed by,
        uint256 fusdGross,
        uint256 fusdToStakers,
        uint256 perfFeeFusd
    );
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

    event CashWithdrawClaimed(
        uint256 indexed requestId,
        address indexed user,
        address indexed asset,
        uint256 amount
    );

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

    /// @param name_ ERC20 name for the share token of this deployment, e.g. "Staked Frgmnt EURO".
    ///        FNA-11: parameterized so one implementation bytecode can back multiple xUSD-style
    ///        products without forking source per denomination.
    /// @param symbol_ ERC20 symbol for the share token of this deployment, e.g. "sfEURO".
    function initialize(
        address _fusd,
        address _poolManagerLogic,
        address _owner,
        string memory name_,
        string memory symbol_
    ) external initializer {
        if (_fusd == address(0)) revert ZeroAddress();
        if (_poolManagerLogic == address(0)) revert ZeroAddress();
        if (_owner == address(0)) revert ZeroAddress();
        if (bytes(name_).length == 0 || bytes(symbol_).length == 0) revert EmptyMetadata();

        __ERC20_init(name_, symbol_);
        __Ownable_init(_owner);
        __ReentrancyGuard_init();

        fusd = _fusd;
        poolManagerLogic = _poolManagerLogic;

        creationTime = block.timestamp;
        lastFeeMintTime = block.timestamp;
        tokenPriceAtLastFeeMint = 1e18;
        isImmediateWithdrawEnabled = true;
        compoundedRewardIndex = 1e18;
    }

    /// @custom:oz-upgrades-validate-as-initializer
    function initializeAutoCompounding() external onlyOwner reinitializer(2) {
        if (compoundedRewardIndex != 0) revert AutoCompoundingAlreadyInitialized();
        compoundedRewardIndex = 1e18;
        autoCompoundStartRewardPerShare = rewardPerShare;
    }

    /// @notice FNA-03: one-time wiring of the dedicated WithdrawalEscrow deployed for this
    ///         pool, callable exactly once by this pool's own owner, any time after
    ///         deployment (the escrow itself is immutable-bound to this pool's address at its
    ///         own construction, so deploy order is escrow-after-pool). A plain
    ///         already-set guard is used here instead of a new reinitializer version (as
    ///         initializeAutoCompounding() uses) purely to avoid inlining another copy of
    ///         OpenZeppelin's Initializable version-check machinery — PoolLogic has
    ///         essentially no bytecode headroom left (see FNA-03/FNA-04 history).
    function initializeWithdrawalEscrow(address escrow) external onlyOwner {
        if (withdrawalEscrow != address(0)) revert EscrowAlreadySet();
        if (escrow == address(0)) revert ZeroAddress();
        withdrawalEscrow = escrow;
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
        returns (
            uint256 performance,
            uint256 management,
            uint256 entry,
            uint256 exit,
            uint256 denominator
        )
    {
        return IPoolManagerLogic(poolManagerLogic).getFee();
    }

    function _totalValueWithCompleteness() internal view returns (uint256, bool) {
        return FundCalculationLibrary.totalValueWithCompleteness(poolManagerLogic);
    }

    /// @dev FNA-17: reserved-value-excluding NAV, used for accrual (_accrueYield()) and its
    ///      calculateAvailableManagerFee() preview — see FundCalculationLibrary's docs on why
    ///      these two call sites specifically must not treat a finalized-but-unclaimed queued
    ///      withdrawal's reserved liquidity as part of the pool's active value. getFundSummary()
    ///      deliberately keeps using the gross _totalValueWithCompleteness() above — it is a
    ///      general display figure ("everything the pool currently holds"), not an accrual input.
    function _activeTotalValueWithCompleteness() internal view returns (uint256, bool) {
        return FundCalculationLibrary.activeTotalValueWithCompleteness(address(this), poolManagerLogic);
    }

    function _unclaimedRewards() internal view returns (uint256) {
        return totalRewardAccrued - totalRewardHarvested;
    }

    function _managementFeeBase() internal view returns (uint256) {
        return IERC20(fusd).totalSupply() + _unclaimedRewards();
    }

    function _requireAutoCompoundingInitialized() internal view returns (uint256 index) {
        index = compoundedRewardIndex;
        if (index == 0) revert AutoCompoundingNotInitialized();
    }

    function _actionSender() internal view returns (address sender) {
        sender = msg.sender;
        if (_isAllowedCallbackSender(sender)) {
            sender = IUserActionSender(sender).actionUser();
        }
    }

    // ============================================================
    // =                MANAGEMENT FEE & REWARDS                   =
    // ============================================================

    modifier updateFeesAndRewards(address user) {
        _updateFeesAndRewardsFor(user);
        _;
    }

    function _updateFeesAndRewardsFor(address user) internal {
        _accrueYield();
        _updateUserReward(user);
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
     * 2) Compute net incremental performance yield (net yield) and performance fee using
     *    FundCalculationLibrary.calculatePerformanceFee().
     *    Net yield and Performance fee are computed in USD.
     * 3) Compute time-based management fee using
     *    FundCalculationLibrary.calculateManagementFee().
     * 4) Settle the manager's pending rewards BEFORE modifying the reward index
     *    or minting new shares, to avoid retroactive reward dilution.
     * 5) Distribute net yield (after removing management fee) to existing stakers and
     *    unharvested rewards by increasing compoundedRewardIndex.
     * 6) Mint performance and management fee shares to the manager in FUSD.
     * 7) Update manager reward debt.
     *
     * IMPORTANT:
     * - Fees are minted in FUSD.
     * - The ordering of operations is critical to ensure fair reward
     *   distribution and to prevent fee minting from capturing past rewards.
     *
     * DESIGN NOTE (FNA-13 — reward recognition, not a bug):
     * A positive NAV change is distributed across whoever holds sfUSD (effectiveSupply)
     * at the moment THIS function runs — not proportionally to how long each holder has
     * actually held their shares. stake() already calls this before minting new shares,
     * so a staker can never retroactively capture value already visible in totalFundValue()
     * at entry. But if value is earned before it becomes visible here (e.g. an incentive
     * token the pool holds, recognized only once the manager converts it into a supported
     * asset), a staker who enters between "earned" and "recognized" and exits immediately
     * after receives a pro-rata share of that recognition event, same as any other holder
     * present at the time — regardless of how briefly they held.
     * This is an intentional, accepted tradeoff, not a defect: entry/exit fees and unstake
     * lock periods are deliberately NOT used to discourage this (see PR/audit discussion for
     * FNA-13), matching how fee-less, lock-free ERC-4626-style vaults generally behave —
     * rewards belong to whoever holds the share token at recognition time, full stop. If
     * this behavior ever needs to change, the fix is architectural (e.g. streaming
     * recognition instead of discrete jumps, or accruing at the value-changing event itself
     * rather than lazily on the next stake/unstake/harvest), not a parameter tweak.
     */

    function _accrueYield() internal {
        uint256 index = _requireAutoCompoundingInitialized();
        (uint256 totalValue, bool navComplete) = _activeTotalValueWithCompleteness();
        if (!navComplete) emit IncompleteNAVAccrual(msg.sender, block.timestamp);
        uint256 totalFusd = _managementFeeBase();

        (
            uint256 _performanceFeeNumerator,
            uint256 _managementFeeNumerator,
            ,
            ,
            uint256 _feeDenominator
        ) = _managerFees();

        (
            uint256 _performanceFee,
            uint256 _managementFee,
            uint256 _netYield,
            uint256 _newAccountedAssets,
            uint256 _lastFeeMintTime
        ) = FundCalculationLibrary.computeYieldAccrual(
                totalValue,
                navComplete,
                accountedAssets,
                totalFusd,
                lastFeeMintTime,
                _performanceFeeNumerator,
                _managementFeeNumerator,
                _feeDenominator,
                true
            );

        address mgr = _manager();

        // 0) Settle manager pending rewards BEFORE changing the reward index
        _updateUserReward(mgr);

        // 1) distribute net yield to stakers
        totalManagementFee += _managementFee;
        totalPerformanceFee += _performanceFee;
        accountedAssets = _newAccountedAssets;

        // FNA-06: with no floor, an attacker holding the pool's only (dust, e.g. 1 wei) effective
        // sfUSD supply could donate an ordinary ERC20 transfer directly to PoolLogic (reads as
        // "yield" here since it grows fund value without growing accountedAssets), then harvest,
        // cheaply repeating this for huge multiplicative index growth per cycle until a
        // checkpoint's index exceeds type(uint256).max and Math.mulDiv panics — permanently
        // freezing every withdraw/stake/unstake/harvest, since all of them accrue yield first.
        // PoolLogic is already deployed and upgradeable on mainnet, so this can't rely on a fresh
        // initializer (e.g. seeding minimum supply at deploy time); it must hold on already-live
        // pools purely from this check. Below 1e18 effective supply, compounding is skipped
        // entirely (closes the attack outright: dust-supply cycles can never move the index; the
        // skipped yield isn't lost, just absorbed into accountedAssets like the pre-existing
        // effectiveSupply==0 case already did). Above that floor, netYield is capped to at most
        // effectiveSupply*1e6 (a ~1e6x growth-factor ceiling per checkpoint — unreachable via any
        // legitimate yield report, e.g. a lone staker's small unclaimed-rewards balance briefly
        // outpaced by fresh yield is nowhere close, but it still bounds a pathological/buggy
        // totalValue reading).
        //
        // CertiK follow-up: an earlier version of this fix also stopped updating the index at all
        // once it reached 1e30, purely to keep a comfortable margin under type(uint256).max. That
        // traded a rare, bounded-cost DoS for a worse failure: once crossed, EVERY future
        // legitimate yield event — attacked or not, including a pool's own long-run organic
        // compounding — stopped distributing rewards permanently and silently, with no revert to
        // signal it. Removed: this per-checkpoint growth cap alone already bounds the WORST-CASE
        // number of checkpoints needed to approach type(uint256).max to roughly ten, and each of
        // those ten must independently inject appliedNetYield ~= effectiveSupply * 1e6 in real
        // recognized yield — cost that scales directly with the pool's actual staked supply, not
        // a fixed or shrinking quantity, and is economically irrational once effectiveSupply is
        // healthy (not sitting at the 1e18 floor). Residual, accepted risk, same tradeoff CertiK
        // recommended: an attacker willing to burn an amount of capital that scales with (and
        // ordinarily dwarfs) the pool's own liquidity could still force a Math.mulDiv revert here
        // on some future checkpoint — mitigated operationally by seeding real initial liquidity
        // at deploy and keeping effectiveSupply away from the 1e18 floor, not by a second code-
        // level ceiling that reintroduces a permanent, silent reward freeze of its own.
        uint256 effectiveSupply = totalSupply() + _unclaimedRewards();
        if (_netYield > 0 && effectiveSupply >= 1e18) {
            uint256 appliedNetYield = effectiveSupply * 1e6;
            if (_netYield < appliedNetYield) {
                appliedNetYield = _netYield;
            }
            totalRewardAccrued += appliedNetYield;
            // Reused below to hold (effectiveSupply + appliedNetYield) — the mulDiv numerator —
            // now that its "capped yield" value has already been consumed above. That sum is
            // bounded by effectiveSupply * (1 + 1e6), provably far under 2**256 for any realistic
            // supply, making the checked-arithmetic guard on this addition redundant.
            unchecked {
                appliedNetYield += effectiveSupply;
            }
            compoundedRewardIndex = Math.mulDiv(index, appliedNetYield, effectiveSupply);
        }

        // 2) mint performance and management fee to manager in FUSD
        uint256 _fee = _performanceFee + _managementFee;
        if (_fee > 0) {
            ITokenLogic(fusd).mintFromPool(mgr, _fee);
        }
        // 4) Update manager rewardDebt after minting shares
        //UserReward storage ur = userRewards[mgr];
        //ur.rewardDebt = (balanceOf(mgr) * rewardPerShare) / 1e18;
        // 5) update state
        lastFeeMintTime = _lastFeeMintTime;
    }

    /// @dev Shared by _currentPendingReward's un-migrated preview branch and _migrateRewardIndex's
    ///      actual migration — both need the same "pending accrued under the old rewardPerShare
    ///      accounting, not yet reflected in `rewardDebt`" delta.
    function _migratedAccumulatedDelta(
        uint256 balance,
        uint256 rewardDebt
    ) internal view returns (uint256) {
        uint256 accumulated = Math.mulDiv(balance, autoCompoundStartRewardPerShare, 1e18);
        return accumulated > rewardDebt ? accumulated - rewardDebt : 0;
    }

    function _currentPendingReward(address user) internal view returns (uint256) {
        uint256 index = _requireAutoCompoundingInitialized();
        UserReward memory ur = userRewards[user];
        uint256 balance = balanceOf(user);
        uint256 pending = ur.pending;
        uint256 snapshot = ur.rewardDebt;

        if (!rewardIndexInitialized[user]) {
            pending += _migratedAccumulatedDelta(balance, ur.rewardDebt);
            snapshot = 1e18;
        } else if (snapshot == 0) {
            snapshot = 1e18;
        }

        uint256 effectiveBalance = balance + pending;
        uint256 currentEffective = Math.mulDiv(effectiveBalance, index, snapshot);

        return currentEffective > balance ? currentEffective - balance : 0;
    }

    function _migrateRewardIndex(address user) internal {
        if (user == address(0) || rewardIndexInitialized[user]) return;

        UserReward storage ur = userRewards[user];
        ur.pending += _migratedAccumulatedDelta(balanceOf(user), ur.rewardDebt);
        ur.rewardDebt = 1e18;
        rewardIndexInitialized[user] = true;
    }

    function _updateUserReward(address user) internal {
        if (user == address(0)) return;

        _migrateRewardIndex(user);

        UserReward storage ur = userRewards[user];
        ur.pending = _currentPendingReward(user);
        ur.rewardDebt = _requireAutoCompoundingInitialized();
    }

    /// @notice Called by PoolManagerLogic.commitFeeIncrease()
    function mintManagerFee() external nonReentrant {
        if (msg.sender != poolManagerLogic) revert OnlyManagerLogic();
        _accrueYield();
    }

    // ============================================================
    // =                           STAKE                           =
    // ============================================================

    /// @dev FNA-13: both stake() overloads call _updateFeesAndRewardsFor()/_accrueYield()
    ///      before minting shares, so a new staker never captures NAV growth already visible
    ///      at entry. Value not yet visible (recognized later in a separate transaction) is a
    ///      different, intentionally-accepted case — see the design note on _accrueYield().
    function stake(uint256 amountFusd) external nonReentrant updateFeesAndRewards(msg.sender) {
        // Backward-compatible wrapper: no minimum output enforced by the user
        _stake(msg.sender, amountFusd, 0);
    }

    /// @notice Stake with user-defined minimum shares
    function stake(
        uint256 amountFusd,
        uint256 minShares
    ) public nonReentrant {
        address user = _actionSender();
        _updateFeesAndRewardsFor(user);
        _stake(user, amountFusd, minShares);
    }

    function _stake(
        address user,
        uint256 amountFusd,
        uint256 minShares
    ) internal returns (uint256 sharesMinted) {
        if (
            !(user == _manager() ||
                !IPoolManagerLogic(poolManagerLogic).privatePool() ||
                IPoolManagerLogic(poolManagerLogic).isMemberAllowed(user))
        ) revert OnlyMemberAllowed();

        if (amountFusd == 0) revert ZeroAmount();

        // Pull FUSD from user
        IERC20(fusd).safeTransferFrom(user, address(this), amountFusd);

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

        _mint(user, netFusd);
        sharesMinted = netFusd;

        // update rewardDebt after mint
        UserReward storage ur = userRewards[user];
        ur.rewardDebt = _requireAutoCompoundingInitialized();

        if (feeFusd > 0) {
            IERC20(fusd).safeTransfer(_manager(), feeFusd);
        }

        emit Stake(user, amountFusd, netFusd, feeFusd);
    }

    // ============================================================
    // =                          UNSTAKE                          =
    // ============================================================

    function unstake(uint256 shareAmount) external nonReentrant {
        address user = _actionSender();
        _updateFeesAndRewardsFor(user);
        _unstake(user, shareAmount);
    }

    function _unstake(address user, uint256 shareAmount) internal returns (uint256 fusdOut) {
        if (shareAmount == 0) revert ZeroAmount();
        if (balanceOf(user) < shareAmount) revert InsufficientShares();

        _burn(user, shareAmount);

        UserReward storage ur = userRewards[user];
        ur.rewardDebt = _requireAutoCompoundingInitialized();

        IERC20(fusd).safeTransfer(user, shareAmount);
        fusdOut = shareAmount;

        emit Unstake(user, shareAmount, shareAmount);
    }

    function harvest() external nonReentrant updateFeesAndRewards(msg.sender) {
        UserReward storage ur = userRewards[msg.sender];
        uint256 amount = ur.pending;
        if (amount == 0) revert NothingToHarvest();
        ur.pending = 0;
        totalRewardHarvested += amount;
        ur.rewardDebt = _requireAutoCompoundingInitialized();
        ITokenLogic(fusd).mintFromPool(msg.sender, amount);
        emit Harvest(msg.sender, amount);
    }

    function _applyWithdrawFeeFusd(
        uint256 fusdAmount
    ) internal view returns (uint256 netFusd, uint256 feeFusd) {
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

    function withdrawCashImmediate(
        uint256 fusdAmount
    ) external nonReentrant {
        address user = _actionSender();
        _updateFeesAndRewardsFor(user);

        IHasSupportedAsset.Asset[] memory supportedAssets = IHasSupportedAsset(poolManagerLogic)
            .getSupportedAssets();
        ComplexAsset[] memory complexAssetsData = new ComplexAsset[](supportedAssets.length);

        _withdrawCashImmediateToSafe(user, user, fusdAmount, complexAssetsData);
    }

    function withdrawCashImmediateTo(
        address recipient,
        uint256 amount
    ) external nonReentrant updateFeesAndRewards(msg.sender) {
        if (recipient == address(0)) revert InvalidRecipient();

        IHasSupportedAsset.Asset[] memory supportedAssets = IHasSupportedAsset(poolManagerLogic)
            .getSupportedAssets();
        ComplexAsset[] memory complexAssetsData = new ComplexAsset[](supportedAssets.length);

        _withdrawCashImmediateToSafe(msg.sender, recipient, amount, complexAssetsData);
    }

    function withdrawCashImmediateSafe(
        uint256 amount,
        ComplexAsset[] calldata complexAssetsData
    ) external nonReentrant updateFeesAndRewards(msg.sender) {
        _withdrawCashImmediateToSafe(msg.sender, msg.sender, amount, complexAssetsData);
    }

    function withdrawCashImmediateToSafe(
        address recipient,
        uint256 amount,
        ComplexAsset[] calldata complexAssetsData
    ) external nonReentrant updateFeesAndRewards(msg.sender) {
        if (recipient == address(0)) revert InvalidRecipient();
        _withdrawCashImmediateToSafe(msg.sender, recipient, amount, complexAssetsData);
    }

    function _withdrawCashImmediateToSafe(
        address user,
        address recipient,
        uint256 amount,
        ComplexAsset[] memory complexAssetsData
    ) internal {
        if (!isImmediateWithdrawEnabled) revert ImmediateWithdrawalDisabled();
        if (amount == 0) revert ZeroAmount();
        uint256 netFusd;
        uint256 feeFusd;
        if (user == _manager()) {
            netFusd = amount;
        } else {
            // cooldown enforced only on CASH withdraw (not unstake)
            if (ITokenLogic(fusd).getExitRemainingCooldown(user) != 0)
                revert CooldownActive();

            (netFusd, feeFusd) = _applyWithdrawFeeFusd(amount);
            if (netFusd == 0) revert ZeroAmount();

            if (feeFusd > 0) {
                IERC20(fusd).safeTransferFrom(user, _manager(), feeFusd);
            }
        }
        // burn FUSD
        ITokenLogic(fusd).burnFrom(user, netFusd);

        (
            address[] memory outAssets,
            uint256[] memory outAmounts,
            uint256 valueBefore,
            uint256 totalClaims,
            uint256 completeFundValue
        ) = _withdrawProRata(recipient, netFusd, complexAssetsData);

        uint256 valueAfter = _withdrawableFundValue();
        if (valueBefore < valueAfter) revert InvalidFundValue();
        uint256 valueDelta = valueBefore - valueAfter;
        if (valueDelta > netFusd + 1e15) revert InvalidFundValue();
        // FNA-42: reduces accountedAssets by more than valueDelta whenever this withdrawal
        // retires claims while an unrecognized loss (accountedAssets > completeFundValue) is
        // outstanding — see computeAccountedAssetsReduction's own docs for why the plain
        // valueDelta subtraction previously left the baseline overstated for remaining claims,
        // and for why completeFundValue (not this function's own liquidity-capped valueBefore)
        // is the correct NAV to measure the overhang against.
        uint256 reduction = FundCalculationLibrary.computeAccountedAssetsReduction(
            netFusd,
            totalClaims,
            accountedAssets,
            completeFundValue,
            valueDelta
        );
        if (accountedAssets < reduction) revert InvalidFundValue();
        accountedAssets -= reduction;

        // Backward-compatible event (single-asset fields are not meaningful in pro-rata mode)
        emit CashWithdrawImmediate(user, amount, netFusd, feeFusd);
        emit CashWithdrawImmediateProRata(
            user,
            amount,
            netFusd,
            feeFusd,
            outAssets,
            outAmounts
        );
    }

    /// @dev Helper to reduce stack usage in withdrawCashImmediate (compile fix: avoids "stack too deep")
    function _withdrawProRata(
        address recipient,
        uint256 netFusd,
        ComplexAsset[] memory complexAssetsData
    )
        internal
        returns (
            address[] memory outAssets,
            uint256[] memory outAmounts,
            uint256 valueBefore,
            uint256 totalClaims,
            uint256 completeFundValue
        )
    {
        // compute portion in terms of totalFundValue, floored by outstanding claims so an
        // underwater pool socializes the shortfall instead of paying early redeemers at par —
        // see FundCalculationLibrary.computeImmediateWithdrawPortion and FNA-05.
        uint256 fundValue = _withdrawableFundValue();
        if (fundValue == 0) revert EmptyFund();
        // FNA-07 follow-up: computeImmediateWithdrawPortion now internally derives a separate,
        // non-liquidity-capped NAV for its solvency haircut, so a temporary under-liquid lending
        // position is never misread as permanent insolvency — see its own docs.
        uint256 portion;
        (portion, totalClaims, completeFundValue) = FundCalculationLibrary
            .computeImmediateWithdrawPortion(address(this), netFusd, fundValue);
        if (portion == 0) revert WithdrawAmountTooSmall();

        // withdraw proportionally from ALL supported assets
        IHasSupportedAsset.Asset[] memory supportedAssets = IHasSupportedAsset(poolManagerLogic)
            .getSupportedAssets();
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

            (address withdrawAsset, uint256 withdrawAmount) = _withdrawOne(
                portion,
                recipient,
                a,
                cd
            );

            if (withdrawAsset != address(0) && withdrawAmount > 0) {
                uint256 count = out.count;
                out.assets[count] = withdrawAsset;
                out.amounts[count] = withdrawAmount;
                out.count = count + 1;
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
        if (amount == 0) revert ZeroAmount();
        if (!IPoolManagerLogic(poolManagerLogic).isDepositAsset(asset)) {
            revert NotValidWithdrawableAsset();
        }
        uint256 netFusd;
        uint256 feeFusd;
        if (msg.sender == _manager()) {
            netFusd = amount;
        } else {
            if (ITokenLogic(fusd).getExitRemainingCooldown(msg.sender) != 0)
                revert CooldownActive();
            (netFusd, feeFusd) = _applyWithdrawFeeFusd(amount);
            if (netFusd == 0) revert ZeroAmount();
            // prevent creating requests that can never be finalized due to rounding to zero.
            if (FundCalculationLibrary.fusdToAssetAmount(poolManagerLogic, netFusd, asset) == 0)
                revert ZeroAmount();
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

        address asset = r.asset;
        uint256 fusdNetForAsset = r.fusdNetForAsset;
        uint256 feeFusd = totalFusd - fusdNetForAsset;
        if (feeFusd > 0) {
            IERC20(fusd).safeTransfer(_manager(), feeFusd);
        }

        // Floor by outstanding claims so an underwater pool socializes the shortfall instead of
        // paying finalized-first requests at par, then convert to asset units at today's price —
        // see FundCalculationLibrary.computeFinalizeAssetAmount and FNA-05. FUSD backing this
        // request is transferred-not-burned until claimCashWithdraw, so totalSupply() already
        // reflects outstanding claims as of this finalization.
        (uint256 assetAmount, uint256 totalClaims, uint256 completeFundValue) = FundCalculationLibrary
            .computeFinalizeAssetAmount(address(this), asset, fusdNetForAsset);
        if (assetAmount == 0) revert ZeroAmount();

        // Finalization does not transfer assets to the user; assets remain on the contract until claim.
        // Therefore we must account for other finalized-but-unclaimed requests to avoid over-allocating
        // the same on-chain balance across multiple requests.
        uint256 bal = IERC20(asset).balanceOf(address(this));
        uint256 reserved = reservedAssetBalance[asset];

        // Defensive: reserved should never exceed the actual on-chain balance.
        if (bal < reserved) revert InvalidReservedBalance();

        // Only the unreserved portion of the balance can be used for a new finalization.
        uint256 available = bal - reserved;
        if (available < assetAmount) revert InsufficientAssetBalance();

        // FNA-03/FNA-26: physically move the finalized amount into this pool's dedicated
        // escrow instead of only bookkeeping it as "reserved" while it remains part of this
        // contract's own balance — CertiK's follow-up showed that capping individual or
        // aggregate spender approvals against a bookkept reservation still sitting in the
        // pool's own balanceOf() could not fully close the drain this was meant to prevent;
        // physically removing the asset from that balance closes it structurally instead.
        // reservedAssetBalance is deliberately left untouched: nothing is "reserved" in the
        // old sense anymore, the asset simply is not part of this pool's own balance once it
        // leaves for escrow. The move itself removes that much value from active NAV — the
        // same NAV _accrueYield() compares accountedAssets against — so the library also
        // measures the before/after delta around the move and returns the adjusted baseline
        // directly, rather than this deferring an approximation to claimCashWithdraw() (see
        // that function's docs for why that was wrong). Delegated entirely to
        // FundCalculationLibrary purely to keep this call site's own bytecode under the
        // EIP-170 size limit.
        // FNA-42: also feeds this request's own netFusd/totalClaims/completeFundValue through so
        // the baseline reduction accounts for this claim's own share of any pre-existing
        // unrecognized loss, not just the dollars physically moved to escrow — see
        // _computeAccountedAssetsReduction's own docs.
        accountedAssets = FundCalculationLibrary.finalizeReserveAndUpdateBaseline(
            poolManagerLogic,
            withdrawalEscrow,
            asset,
            assetAmount,
            fusdNetForAsset,
            totalClaims,
            completeFundValue,
            accountedAssets
        );

        r.assetAmount = assetAmount;
        r.status = RequestStatus.FinalizedEscrowed;

        // FNA-38: this request's backing asset just left active NAV above; its FUSD isn't
        // burned until claimCashWithdraw(), so exclude it from totalClaims in the meantime too —
        // see finalizedUnclaimedFusd's own docs.
        finalizedUnclaimedFusd += fusdNetForAsset;

        emit CashWithdrawFinalized(
            requestId,
            totalFusd,
            fusdNetForAsset,
            asset,
            assetAmount
        );
    }

    function claimCashWithdraw(
        uint256 requestId
    ) external nonReentrant updateFeesAndRewards(msg.sender) {
        CashWithdrawRequest storage r = cashWithdrawRequests[requestId];
        if (r.user != msg.sender) revert InvalidWithdrawRequest();
        // FNA-03: FinalizedEscrowed is the normal case going forward (assetAmount already
        // moved into withdrawalEscrow); plain Finalized only remains reachable for a request
        // finalized before the escrow was wired in, whose assetAmount is still part of this
        // pool's own balance under the pre-FNA-03 reservedAssetBalance-only bookkeeping — see
        // claimCashWithdrawRelease's own docs.
        bool escrowed = r.status == RequestStatus.FinalizedEscrowed;
        if (!escrowed && r.status != RequestStatus.Finalized) revert InvalidWithdrawRequest();

        uint256 amount = r.assetAmount;
        if (amount == 0) revert ZeroAmount();

        address asset = r.asset;
        uint256 fusdNetForAsset = r.fusdNetForAsset;

        r.status = RequestStatus.Claimed;
        r.assetAmount = 0;

        // burn the FUSD locked in contract
        ITokenLogic(fusd).burn(fusdNetForAsset);

        // FNA-38: only ever incremented for an escrowed finalize (see finalizedUnclaimedFusd's
        // own docs) — a legacy, pre-FNA-38 plain-Finalized claim was never added here, so must
        // never be subtracted here either.
        if (escrowed) {
            finalizedUnclaimedFusd -= fusdNetForAsset;
        }

        // FNA-03: releases from this pool's dedicated escrow when `escrowed` (the normal case
        // going forward — see finalizeCashWithdraw()), or from this pool's own balance under
        // the pre-FNA-03 reservedAssetBalance-only bookkeeping otherwise (a request finalized
        // before the escrow was wired in) — see claimCashWithdrawRelease's own docs. Delegated
        // to FundCalculationLibrary purely to keep this contract's own bytecode under the
        // EIP-170 size limit.
        (uint256 newReserved, uint256 delivered) = FundCalculationLibrary.claimCashWithdrawRelease(
            withdrawalEscrow,
            escrowed,
            asset,
            amount,
            reservedAssetBalance[asset]
        );
        reservedAssetBalance[asset] = newReserved;

        // FNA-26: accountedAssets is deliberately left untouched here. Releasing the reservation
        // and transferring `amount` leave active, reserved-excluding NAV exactly unchanged —
        // that value was already removed from the baseline back in finalizeCashWithdraw() when
        // the reservation was created (see its own docs). This function previously subtracted
        // the claim's full, pre-haircut fusdNetForAsset here too, on top of finalize's own
        // (correct) adjustment — for an underwater/haircut claim (FNA-05), fusdNetForAsset can
        // be materially larger than the reserved asset's actual value, and once accountedAssets
        // had independently caught back up to active NAV (e.g. via later deposits), that extra
        // subtraction understated accountedAssets below true NAV by the gap, which a later
        // accrual call misread as yield and minted FUSD against — with nothing backing it.

        emit CashWithdrawClaimed(requestId, msg.sender, asset, delivered);
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

        // FNA-36: sized against net-realizable value (see IUnwindCostAwareGuard/FNA-35), not raw
        // getBalance(), so a leveraged position whose gross equity looks positive but whose real
        // proceeds are fully consumed by unwind costs is skipped below the same way a genuinely
        // zero-equity one already is.
        v.balance = FundCalculationLibrary.guardNetRealizableBalance(address(this), asset, v.guard);
        uint256 reserved = reservedAssetBalance[asset];
        if (reserved > 0) {
            if (v.balance < reserved) revert InvalidReservedBalance();
            v.balance -= reserved;
        }

        v.portionBalance = (v.balance * portion) / 1e18;
        // FNA-36: this asset's own share of the withdrawal NAV is already zero — calling the
        // guard's own withdrawProcessing() here would, for a leveraged position, still plan and
        // attempt a real unwind (e.g. an Aave flashloan) purely because debt exists, with nothing
        // to actually deliver; if that unwind fails, it reverts the *entire* pro-rata withdrawal,
        // including every other, healthy asset's share. Skipping here is equivalent to the guard
        // itself reporting a zero-value, zero-transaction withdrawal for this asset.
        if (v.portionBalance == 0) {
            return (address(0), 0, false);
        }
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
            (withdrawAsset, withdrawAmount, v.transactions) = IAssetGuard(v.guard)
                .withdrawProcessing(address(this), asset, portion, to);
        }

        v.txCount = v.transactions.length;
        if (v.txCount > 0) {
            if (withdrawAsset != address(0)) {
                v.assetBalanceBefore = IERC20(withdrawAsset).balanceOf(address(this));
            }

            for (uint256 i = 0; i < v.txCount; ++i) {
                (bool success, bytes memory returndata) = v.transactions[i].to.call(
                    v.transactions[i].txData
                );
                _checkCallResult(v.transactions[i].txData, success, returndata);
                externalProcessed = true;
            }

            if (withdrawAsset != address(0)) {
                v.assetBalanceAfter = IERC20(withdrawAsset).balanceOf(address(this));
                if (v.assetBalanceAfter > v.assetBalanceBefore) {
                    withdrawAmount += (v.assetBalanceAfter - v.assetBalanceBefore);
                }
            }
        }

        if (
            v.regularProcessing && complexData.slippageTolerance != 0 && withdrawAsset != address(0)
        ) {
            v.actualValue = IPoolManagerLogic(poolManagerLogic).assetValue(
                withdrawAsset,
                withdrawAmount
            );

            if (
                v.actualValue <
                (v.expectedValue * (10_000 - complexData.slippageTolerance)) / 10_000
            ) revert SlippageExceeded();
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
        if (msg.sender != fusd) revert OnlyTokenLogic();

        // Prevent accidental zero-value updates.
        if (amount == 0) revert ZeroAmount();

        // Increase the accounting baseline by the specified amount.
        accountedAssets += amount;

        // Emit event for off-chain tracking and auditing.
        emit AccountedAssetsIncremented(amount);
    }

    /// @notice FNA-22: settles pending management/performance fee accrual using the fUSD
    ///         supply and fund value as they stand right now, before TokenLogic applies an
    ///         incoming deposit's effects (minting new fUSD, crediting new collateral) — see
    ///         the FNA-13 design note above on _accrueYield() for why stake() already
    ///         checkpoints before minting new shares; deposit previously did not.
    /// @dev Only callable by TokenLogic (fusd), exactly like incrementAccountedAssets.
    /// @dev FNA-04 follow-up: fails closed (reverts IncompleteNAV) when the pool's active NAV
    ///      reading is incomplete, unlike _accrueYield()'s other callers (stake/unstake/harvest),
    ///      which deliberately stay fail-open — see the design note on computeYieldAccrual()
    ///      for why reverting there would freeze withdrawal of EXISTING value over one guard's
    ///      transient failure. A deposit is different: TokenLogic mints NEW fUSD and calls
    ///      incrementAccountedAssets() unconditionally in the same transaction regardless of
    ///      whether this checkpoint ran, so silently skipping accrual here doesn't just delay
    ///      recognition — it lets that freshly-minted fUSD be staked into a share supply that,
    ///      once the failing guard recovers, distributes value earned (but invisible) before
    ///      this deposit pro rata across whoever holds shares at recognition time (see FNA-13's
    ///      design note), including this new depositor at the incumbents' expense. Reverting
    ///      here blocks the deposit outright while incomplete; the depositor can simply retry
    ///      once the failing guard recovers.
    /// @dev FNA-22 follow-up (CertiK, 08/25): still fails open (returns without reverting,
    ///      lastFeeMintTime left untouched) if autocompounding was never initialized — the one
    ///      remaining case where this function returns without either accruing or reverting.
    ///      Provably NOT the FNA-22 bug (a deposit's new fUSD retroactively taxed for a period
    ///      before it existed), because no fee of any kind — deposit-triggered or otherwise —
    ///      can accrue while compoundedRewardIndex == 0: _accrueYield() itself starts with
    ///      _requireAutoCompoundingInitialized(), so every OTHER caller (stake/unstake/harvest)
    ///      already reverts outright in this state rather than silently skipping. This early
    ///      return exists purely so a deposit doesn't revert with that same
    ///      AutoCompoundingNotInitialized error on an already-deployed, not-yet-migrated pool
    ///      (an unrelated, cross-proxy-upgrade-ordering case, matching this function's
    ///      pre-existing behavior) — deliberately kept fail-open rather than requiring every such
    ///      pool's owner to call initializeAutoCompounding() before its first post-upgrade
    ///      deposit can succeed.
    function checkpointFeesForDeposit() external {
        if (msg.sender != fusd) revert OnlyTokenLogic();
        if (compoundedRewardIndex == 0) return;

        (, bool navComplete) = _activeTotalValueWithCompleteness();
        if (!navComplete) revert IncompleteNAV();

        _accrueYield();
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

        // PoolTxExecutor.exec() verifies, after dispatching the guarded call, that the reserve
        // invariant (balanceOf(this) >= reservedAssetBalance[asset]) still holds for every
        // supported asset — see PoolTxExecutor._checkReservedBalancesIntact(). Without this, a
        // manager/trader deploying a reserved asset elsewhere (e.g. supplying it to Aave for
        // yield, completely ordinary vault management) could silently leave a finalized withdraw
        // claim unbacked.
        (bool success, uint16 txType) = PoolTxExecutor.exec(ctx, to, data);

        emit TransactionExecuted(address(this), msg.sender, txType, block.timestamp);

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
        return _currentPendingReward(user);
    }

    function getUserRequests(address user) external view returns (uint256[] memory) {
        return userRequests[user];
    }

    // ============================================================
    // =         MANAGER FEE VIEW LOGIC (UNMINTED FEES)           =
    // ============================================================

    /// @notice Get available manager fee of the pool
    /// @dev Can be used on the frontend by passing in fund value
    /// @dev FNA-17: mirrors _accrueYield()'s reserved-value-excluding NAV, so this preview always
    ///      matches what accrual would actually mint — see _activeTotalValueWithCompleteness().

    /// @return fee available manager fee of the pool (in pool tokens)
    function calculateAvailableManagerFee() public view returns (uint256 fee) {
        (uint256 totalValue, ) = _activeTotalValueWithCompleteness();
        uint256 totalFusd = _managementFeeBase();

        (
            uint256 _performanceFeeNumerator,
            uint256 _managementFeeNumerator,
            ,
            ,
            uint256 _feeDenominator
        ) = _managerFees();

        (uint256 _performanceFee, uint256 _managementFee, , , ) = FundCalculationLibrary
            .computeYieldAccrual(
                totalValue,
                true,
                accountedAssets,
                totalFusd,
                lastFeeMintTime,
                _performanceFeeNumerator,
                _managementFeeNumerator,
                _feeDenominator,
                false
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
        (uint256 totalValue, ) = _totalValueWithCompleteness();

        return
            FundSummary({
                name: name(),
                totalSupply: IERC20(fusd).totalSupply(),
                totalFundValue: totalValue,
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
        return _executeAaveFlashloan(assets, amounts, premiums, initiator, params);
    }

    // ============================================================
    // = MORPHO FLASHLOAN =
    // ============================================================

    /// @notice Executes operations after receiving a flashloan from Morpho
    /// @param assets Amount that was flash loaned
    /// @param params Arbitrary bytes passed to the receiver
    function onMorphoFlashLoan(uint256 assets, bytes calldata params) external override {
        _executeMorphoFlashloan(assets, params);
    }

    // ============================================================
    // =  NEW HOOKS (REQUIRED BY STATELESS MODULES) =
    // ============================================================

    function _getPoolManagerLogic()
        internal
        view
        override(PoolLogicFlashloanAave, PoolLogicFlashloanMorpho)
        returns (address)
    {
        return poolManagerLogic;
    }

    function _isAllowedCallbackSender(address sender) internal view override returns (bool) {
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
    * FNA-07: guardBalance is further capped by whatever external liquidity a guard reports via
    * IWithdrawableBalanceGuard (delegated to FundCalculationLibrary — see its docs), so one
    * under-liquid lending position sizes its own share down instead of the whole withdrawal
    * reverting.
    */
    function _withdrawableFundValue() internal view returns (uint256 value) {
        return FundCalculationLibrary.computeWithdrawableFundValue(address(this), poolManagerLogic);
    }

    function _checkCallResult(
        bytes memory data,
        bool success,
        bytes memory returndata
    ) internal pure {
        if (!success) revert TxFailed();

        // Only verify return value for ERC20 transfer/approve
        if (data.length < 4) revert InvalidCallData();
        bytes4 sig;
        assembly {
            sig := mload(add(data, 32))
        }

        bool isERC20 = (sig == IERC20.transfer.selector || sig == IERC20.approve.selector);

        if (isERC20 && returndata.length > 0) {
            // SafeERC20-style: decode as bool
            bool ok = abi.decode(returndata, (bool));
            if (!ok) revert TxFailed();
        }
        // For other calls (e.g., Aave withdraw/repay uint256), ignore returndata
    }
}
