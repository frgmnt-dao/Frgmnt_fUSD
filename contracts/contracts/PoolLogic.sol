// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IManaged} from "./interfaces/IManaged.sol";
import {IPoolManagerLogic} from "./interfaces/IPoolManagerLogic.sol";
import {IAssetGuard} from "./interfaces/guards/IAssetGuard.sol";
import {IComplexAssetGuard} from "./interfaces/guards/IComplexAssetGuard.sol";
import {IGuard} from "./interfaces/guards/IGuard.sol";
import {ITxTrackingGuard} from "./interfaces/guards/ITxTrackingGuard.sol";
import {IHasSupportedAsset} from "./interfaces/IHasSupportedAsset.sol";

interface ITokenLogic is IERC20 {
    function burnFrom(address account, uint256 amount) external;
    function burn(uint256 amount) external;
    function getExitRemainingCooldown(address user) external view returns (uint256);
}

interface IPriceInfo {
    /// @notice Returns USD price (18 decimals) of the asset
    function getAssetPrice(address asset) external view returns (uint256);

    /// @notice Returns decimals of the asset
    function assetDecimal(address asset) external view returns (uint256);
}

contract PoolLogic is
    ERC20Upgradeable,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable
{
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

    struct ComplexAsset {
        address supportedAsset;
        bytes withdrawData;
        uint256 slippageTolerance;
    }

    enum RequestStatus { None, Pending, Finalized, Claimed }

    struct CashWithdrawRequest {
        address user;
        uint256 fusdAmountTotal;
        uint256 fusdNetForAsset;
        address asset;
        uint256 requestedAt;
        uint256 assetAmount;
        RequestStatus status;
    }

    // ============================================================
    // =                        STORAGE                           =
    // ============================================================

    address public fusd;
    address public poolManagerLogic;

    uint256 public creationTime;
    bool public privatePool;

    uint256 public rewardPerShare;
    mapping(address => UserReward) public userRewards;

    uint256 public lastMgmtFeeTimestamp;

    uint256 public lastRequestId;
    mapping(uint256 => CashWithdrawRequest) public cashWithdrawRequests;
    mapping(address => uint256[]) public userRequests;

    // ============================================================
    // =                         EVENTS                            =
    // ============================================================

    event Stake(address indexed user, uint256 fusdIn, uint256 sharesMinted, uint256 entryFeeFusd);
    event Unstake(address indexed user, uint256 sharesBurned, uint256 fusdOut);
    event RewardDistributed(address indexed by, uint256 total, uint256 toStakers, uint256 perfFee);
    event Harvest(address indexed user, uint256 amount);

    event CashWithdrawImmediate(
        address indexed user,
        uint256 fusdTotal,
        uint256 fusdNet,
        uint256 fee,
        address indexed asset,
        uint256 assetAmount
    );

    event CashWithdrawRequested(
        uint256 indexed requestId,
        address indexed user,
        uint256 fusdTotal,
        uint256 fusdNet,
        uint256 fee,
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

    event PoolPrivacyUpdated(bool isPoolPrivate);
    event ManagementFeesAccrued(uint256 shares, uint256 timestamp);

    // ============================================================
    // =                      INITIALIZATION                       =
    // ============================================================

    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _fusd,
        address _poolManagerLogic,
        address _owner
    ) external initializer {
        require(_fusd != address(0), "FUSD=0");
        require(_poolManagerLogic != address(0), "PML=0");
        require(_owner != address(0), "owner=0");

        __ERC20_init("Staked Frgmnt USD", "SFUSD");
        __Ownable_init(_owner);
        __ReentrancyGuard_init();

        fusd = _fusd;
        poolManagerLogic = _poolManagerLogic;
        creationTime = block.timestamp;
        lastMgmtFeeTimestamp = block.timestamp;
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
        internal view
        returns (
            uint256 perf,
            uint256 mgmt,
            uint256 entry,
            uint256 exit,
            uint256 denom
        )
    {
        return IPoolManagerLogic(poolManagerLogic).getFee();
    }

    function _totalValue() internal view returns (uint256) {
        return IPoolManagerLogic(poolManagerLogic).totalFundValue();
    }

    // ============================================================
    // =                MANAGEMENT FEES & REWARDS                  =
    // ============================================================

    modifier updateFeesAndRewards(address user) {
        _accrueManagementFee();
        _updateUserReward(user);
        _;
    }

    function _accrueManagementFee() internal {
        uint256 dt = block.timestamp - lastMgmtFeeTimestamp;
        if (dt == 0) return;

        ( , uint256 mgmtFee, , , uint256 denom) = _managerFees();
        if (mgmtFee == 0) {
            lastMgmtFeeTimestamp = block.timestamp;
            return;
        }

        uint256 supply = totalSupply();
        if (supply > 0) {
            uint256 shares =
                (supply * mgmtFee * dt) / (denom * 365 days);

            if (shares > 0) {
                _mint(_manager(), shares);
                emit ManagementFeesAccrued(shares, block.timestamp);
            }
        }
        lastMgmtFeeTimestamp = block.timestamp;
    }

    function _updateUserReward(address user) internal {
        if (user == address(0)) return;

        UserReward storage ur = userRewards[user];
        uint256 bal = balanceOf(user);
        uint256 acc = (bal * rewardPerShare) / 1e18;

        if (acc > ur.rewardDebt) {
            ur.pending += (acc - ur.rewardDebt);
        }

        ur.rewardDebt = (bal * rewardPerShare) / 1e18;
    }

    // ============================================================
    // =                         STAKE                            =
    // ============================================================

    function stake(uint256 amountFusd)
        external
        nonReentrant
    {
        require(amountFusd > 0, "zero");

        _accrueManagementFee();
        _updateUserReward(msg.sender);

        IERC20(fusd).transferFrom(msg.sender, address(this), amountFusd);

        ( , , uint256 entryFee, , uint256 denom) = _managerFees();

        uint256 fee = entryFee > 0 ? (amountFusd * entryFee) / denom : 0;
        if (fee > amountFusd) fee = amountFusd;

        uint256 net = amountFusd - fee;
        require(net > 0, "net=0");

        _mint(msg.sender, net);

        UserReward storage ur = userRewards[msg.sender];
        ur.rewardDebt = (balanceOf(msg.sender) * rewardPerShare) / 1e18;

        emit Stake(msg.sender, amountFusd, net, fee);
    }

    // ============================================================
    // =                        UNSTAKE                           =
    // ============================================================

    function unstake(uint256 shareAmount)
        external
        nonReentrant
    {
        require(shareAmount > 0, "zero");
        require(balanceOf(msg.sender) >= shareAmount, "insufficient");

        _accrueManagementFee();
        _updateUserReward(msg.sender);

        _burn(msg.sender, shareAmount);

        UserReward storage ur = userRewards[msg.sender];
        ur.rewardDebt = (balanceOf(msg.sender) * rewardPerShare) / 1e18;

        IERC20(fusd).transfer(msg.sender, shareAmount);

        emit Unstake(msg.sender, shareAmount, shareAmount);
    }

    // ============================================================
    // =                     REWARDS / HARVEST                    =
    // ============================================================

    function distributeReward(uint256 amountFusd)
        external
        nonReentrant
        updateFeesAndRewards(address(0))
    {
        require(msg.sender == _manager(), "only manager");
        require(amountFusd > 0, "zero");

        uint256 supply = totalSupply();
        require(supply > 0, "no supply");

        IERC20(fusd).transferFrom(msg.sender, address(this), amountFusd);

        (uint256 perfFee, , , , uint256 denom) = _managerFees();

        uint256 fee = perfFee > 0 ? (amountFusd * perfFee) / denom : 0;
        if (fee > amountFusd) fee = amountFusd;

        if (fee > 0) {
            IERC20(fusd).transfer(_manager(), fee);
        }

        uint256 reward = amountFusd - fee;
        rewardPerShare += (reward * 1e18) / supply;

        emit RewardDistributed(msg.sender, amountFusd, reward, fee);
    }

    function harvest()
        external
        nonReentrant
        updateFeesAndRewards(msg.sender)
    {
        UserReward storage ur = userRewards[msg.sender];
        uint256 amount = ur.pending;
        require(amount > 0, "none");

        ur.pending = 0;
        IERC20(fusd).transfer(msg.sender, amount);

        emit Harvest(msg.sender, amount);
    }
    
        // ============================================================
    // =              FUSD → ASSET CONVERSION HELPERS             =
    // ============================================================

    function _fusdToAssetAmount(uint256 fusdAmount, address asset)
        internal
        view
        returns (uint256 assetAmount)
    {
        if (fusdAmount == 0) return 0;

        require(
            IHasSupportedAsset(poolManagerLogic).isSupportedAsset(asset),
            "unsupported asset"
        );

        uint256 price = IPriceInfo(poolManagerLogic).getAssetPrice(asset);
        require(price > 0, "bad price");

        uint256 decimals = IPriceInfo(poolManagerLogic).assetDecimal(asset);

        uint256 assetAmount18 = (fusdAmount * 1e18) / price;

        if (decimals == 18) {
            assetAmount = assetAmount18;
        } else if (decimals < 18) {
            assetAmount = assetAmount18 / (10 ** (18 - decimals));
        } else {
            assetAmount = assetAmount18 * (10 ** (decimals - 18));
        }
    }

    function _applyWithdrawFeeFusd(uint256 fusdAmount)
        internal
        view
        returns (uint256 netFusd, uint256 feeFusd)
    {
        ( , , , uint256 exitFee, uint256 denom) = _managerFees();

        if (exitFee == 0) return (fusdAmount, 0);

        feeFusd = (fusdAmount * exitFee) / denom;
        if (feeFusd > fusdAmount) feeFusd = fusdAmount;
        netFusd = fusdAmount - feeFusd;
    }

    // ============================================================
    // =                CASH WITHDRAW — IMMEDIATE                  =
    // ============================================================

    /**
     * @notice Immediate withdraw uses FULL dHEDGE-style withdrawProcessing()
     *         with ComplexAsset support.
     */
    function withdrawCashImmediate(
        uint256 fusdAmount,
        address asset,
        ComplexAsset calldata complexData
    )
        external
        nonReentrant
        updateFeesAndRewards(msg.sender)
    {
        require(fusdAmount > 0, "zero fusd");
        require(
            IHasSupportedAsset(poolManagerLogic).isSupportedAsset(asset),
            "unsupported"
        );

        require(
            ITokenLogic(fusd).getExitRemainingCooldown(msg.sender) == 0,
            "cooldown"
        );

        // --- Compute withdraw fee ---
        (uint256 netFusd, uint256 feeFusd) = _applyWithdrawFeeFusd(fusdAmount);
        require(netFusd > 0, "net=0");

        // --- Burn FUSD ---
        ITokenLogic(fusd).burnFrom(msg.sender, fusdAmount);

        // --- Compute portion from net USD ---
        uint256 fundValue = _totalValue();
        require(fundValue > 0, "fund=0");

        uint256 portion = (netFusd * 1e18) / fundValue;

        // --- Perform guard/complex withdrawal ---
        (address withdrawAsset, uint256 withdrawAmount, ) =
            _withdrawProcessing(asset, msg.sender, portion, complexData);

        require(withdrawAsset != address(0), "invalid withdraw asset");
        require(withdrawAmount > 0, "zero withdraw");

        // --- Send asset to user ---
        IERC20(withdrawAsset).transfer(msg.sender, withdrawAmount);

        emit CashWithdrawImmediate(
            msg.sender,
            fusdAmount,
            netFusd,
            feeFusd,
            withdrawAsset,
            withdrawAmount
        );
    }

    // ============================================================
    // =                CASH WITHDRAW — QUEUED                     =
    // ============================================================

    function requestCashWithdraw(uint256 fusdAmount, address asset)
        external
        nonReentrant
        updateFeesAndRewards(msg.sender)
        returns (uint256 requestId)
    {
        require(fusdAmount > 0, "zero");
        require(
            IHasSupportedAsset(poolManagerLogic).isSupportedAsset(asset),
            "unsupported"
        );

        require(
            ITokenLogic(fusd).getExitRemainingCooldown(msg.sender) == 0,
            "cooldown"
        );

        IERC20(fusd).transferFrom(msg.sender, address(this), fusdAmount);

        (uint256 netFusd, uint256 feeFusd) = _applyWithdrawFeeFusd(fusdAmount);
        require(netFusd > 0, "net=0");

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

        emit CashWithdrawRequested(
            requestId,
            msg.sender,
            fusdAmount,
            netFusd,
            feeFusd,
            asset
        );
    }

    function finalizeCashWithdraw(uint256 requestId)
        external
        nonReentrant
    {
        require(msg.sender == _manager(), "only manager");

        CashWithdrawRequest storage r = cashWithdrawRequests[requestId];
        require(r.status == RequestStatus.Pending, "invalid");
        require(r.user != address(0), "bad user");

        uint256 totalFusd = r.fusdAmountTotal;
        require(totalFusd > 0, "zero fusd");

        ITokenLogic(fusd).burn(totalFusd);

        uint256 assetAmount = _fusdToAssetAmount(
            r.fusdNetForAsset, r.asset
        );

        require(
            IERC20(r.asset).balanceOf(address(this)) >= assetAmount,
            "insufficient"
        );

        r.assetAmount = assetAmount;
        r.status = RequestStatus.Finalized;

        emit CashWithdrawFinalized(
            requestId,
            r.fusdAmountTotal,
            r.fusdNetForAsset,
            r.asset,
            assetAmount
        );
    }

    function claimCashWithdraw(uint256 requestId)
        external
        nonReentrant
        updateFeesAndRewards(msg.sender)
    {
        CashWithdrawRequest storage r = cashWithdrawRequests[requestId];
        require(r.user == msg.sender, "not owner");
        require(r.status == RequestStatus.Finalized, "not ready");

        uint256 amt = r.assetAmount;
        require(amt > 0, "zero");

        r.assetAmount = 0;
        r.status = RequestStatus.Claimed;

        IERC20(r.asset).transfer(msg.sender, amt);

        emit CashWithdrawClaimed(
            requestId,
            msg.sender,
            r.asset,
            amt
        );
    }

    // ============================================================
    // =            dHEDGE-STYLE WITHDRAW PROCESSING               =
    // ============================================================

    /**
     * @dev FULL integration of dHEDGE withdrawProcessing, adapted to PoolManagerLogic
     */
    function _withdrawProcessing(
        address asset,
        address to,
        uint256 portion,
        ComplexAsset calldata complexData
    )
        internal
        returns (
            address withdrawAsset,
            uint256 withdrawAmount,
            bool externalProcessed
        )
    {
        // --- Retrieve guard ---
        address guard = IPoolManagerLogic(poolManagerLogic).getAssetGuard(asset);
        require(guard != address(0), "invalid guard");

        // --- Compute balance portion ---
        uint256 balance = IAssetGuard(guard).getBalance(address(this), asset);
        uint256 portionBalance = (balance * portion) / 1e18;

        uint256 expectedValue =
            IPoolManagerLogic(poolManagerLogic).assetValue(asset, portionBalance);

        IAssetGuard.MultiTransaction[] memory transactions;

        bool regular = true;

        // --- Complex asset path ---
        if (complexData.withdrawData.length > 0) {
            require(asset == complexData.supportedAsset, "invalid asset data");

            (withdrawAsset, withdrawAmount, transactions) =
                IComplexAssetGuard(guard).withdrawProcessing(
                    address(this),
                    asset,
                    portion,
                    to,
                    complexData.withdrawData
                );

            regular = false;

        } else {
            // --- Regular guarded withdraw ---
            (withdrawAsset, withdrawAmount, transactions) =
                IAssetGuard(guard).withdrawProcessing(
                    address(this),
                    asset,
                    portion,
                    to
                );
        }

        // --- Execute MultiTransactions if any ---
        uint256 txCount = transactions.length;
        if (txCount > 0) {
            uint256 beforeBal = 0;
            if (withdrawAsset != address(0)) {
                beforeBal = IERC20(withdrawAsset).balanceOf(address(this));
            }

            for (uint256 i = 0; i < txCount; ++i) {
                externalProcessed =
                    transactions[i].to.call(transactions[i].txData).length > 0;
            }

            if (withdrawAsset != address(0)) {
                uint256 afterBal = IERC20(withdrawAsset).balanceOf(address(this));
                if (afterBal > beforeBal) {
                    withdrawAmount += (afterBal - beforeBal);
                }
            }
        }

        // --- Slippage check for regular withdraws ---
        if (
            regular &&
            complexData.slippageTolerance != 0 &&
            withdrawAsset != address(0)
        ) {
            uint256 actualValue =
                IPoolManagerLogic(poolManagerLogic).assetValue(withdrawAsset, withdrawAmount);

            require(
                actualValue >=
                    (expectedValue * (10_000 - complexData.slippageTolerance)) / 10_000,
                "high slippage"
            );
        }

        return (withdrawAsset, withdrawAmount, externalProcessed);
    }

    // ============================================================
    // =            GUARDED TX EXECUTION (LIKE dHEDGE)             =
    // ============================================================

    function _execTransaction(
        address to,
        bytes memory data
    )
        private
        nonReentrant
        returns (bool success)
    {
        require(to != address(0), "to=0");

        // --- Try contract guard ---
        address contractGuard =
            IPoolManagerLogic(poolManagerLogic).getContractGuard(to);

        address guard;
        uint16 txType;
        bool isPublic;

        if (contractGuard != address(0)) {
            guard = contractGuard;
            (txType, isPublic) =
                IGuard(guard).txGuard(poolManagerLogic, to, data);
        }

        // --- If no txType found, try asset guard ---
        if (txType == 0) {
            address assetGuard =
                IPoolManagerLogic(poolManagerLogic).getAssetGuard(to);

            if (assetGuard == address(0)) {
                revert("no guard");
            } else {
                require(
                    IHasSupportedAsset(poolManagerLogic).isSupportedAsset(to),
                    "asset disabled"
                );
            }

            guard = assetGuard;
            (txType, isPublic) =
                IGuard(guard).txGuard(poolManagerLogic, to, data);
        }

        require(txType > 0, "invalid tx");
        require(
            isPublic ||
                msg.sender == _manager() ||
                msg.sender == _trader(),
            "not allowed"
        );

        success = to.call(data).length > 0;

        // --- Optional tracking ---
        if (ITxTrackingGuard(guard).isTxTrackingGuard()) {
            ITxTrackingGuard(guard).afterTxGuard(
                poolManagerLogic,
                to,
                data
            );
        }
    }

    function execTransaction(address to, bytes calldata data)
        external
        returns (bool)
    {
        return _execTransaction(to, data);
    }

    function execTransactions(address[] calldata tos, bytes[] calldata datas)
        external
    {
        require(tos.length == datas.length, "len mismatch");
        for (uint256 i = 0; i < tos.length; ++i) {
            require(_execTransaction(tos[i], datas[i]), "tx failed");
        }
    }
    
        // ============================================================
    // =                       VIEW HELPERS                        =
    // ============================================================

    function pendingReward(address user) external view returns (uint256) {
        UserReward memory ur = userRewards[user];
        uint256 bal = balanceOf(user);

        uint256 acc = (bal * rewardPerShare) / 1e18;
        if (acc > ur.rewardDebt) {
            return ur.pending + (acc - ur.rewardDebt);
        }
        return ur.pending;
    }

    function getUserRequests(address user)
        external
        view
        returns (uint256[] memory)
    {
        return userRequests[user];
    }

    // ============================================================
    // =               TOKEN PRICE / FUND SUMMARY                  =
    // ============================================================

    function _tokenPrice(uint256 fundValue, uint256 supply)
        internal
        pure
        returns (uint256)
    {
        if (supply == 0 || fundValue == 0) return 0;
        return (fundValue * 1e18) / supply;
    }

    function tokenPrice() external view returns (uint256) {
        uint256 value = _totalValue();
        uint256 supply = totalSupply();
        return _tokenPrice(value, supply);
    }

    function tokenPriceWithoutManagerFee() external view returns (uint256) {
        uint256 value = _totalValue();
        uint256 supply = totalSupply();
        return _tokenPrice(value, supply);
    }

    function calculateAvailableManagerFee(uint256)
        public
        pure
        returns (uint256)
    {
        return 0; // all fees are eagerly minted
    }

    function getFundSummary()
        external
        view
        returns (FundSummary memory)
    {
        (
            uint256 performanceFeeNumerator,
            uint256 managementFeeNumerator,
            uint256 entryFeeNumerator,
            uint256 exitFeeNumerator,
            uint256 denominator
        ) = _managerFees();

        return FundSummary({
            name: name(),
            totalSupply: totalSupply(),
            totalFundValue: _totalValue(),
            manager: _manager(),
            managerName: IManaged(poolManagerLogic).managerName(),
            creationTime: creationTime,
            privatePool: privatePool,
            performanceFeeNumerator: performanceFeeNumerator,
            managerFeeNumerator: managementFeeNumerator,
            managerFeeDenominator: denominator,
            exitFeeNumerator: exitFeeNumerator,
            exitFeeDenominator: denominator,
            entryFeeNumerator: entryFeeNumerator
        });
    }

    // ============================================================
    // =                       PRIVACY FLAG                        =
    // ============================================================

    function setPoolPrivate(bool _private) external {
        require(msg.sender == _manager(), "only manager");
        privatePool = _private;
        emit PoolPrivacyUpdated(_private);
    }

}
