// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "../../utils/TxDataUtils.sol";
import "../../interfaces/guards/IGuard.sol";
import "../../interfaces/guards/ITxTrackingGuard.sol";
import "../../interfaces/aave/IAaveProtocolDataProvider.sol";
import "../../interfaces/aave/v3/IAaveV3Pool.sol";
import "../../interfaces/IPoolManagerLogic.sol";
import "../../interfaces/IHasAssetInfo.sol";
import "../../interfaces/IHasSupportedAsset.sol";
import "../../interfaces/ITransactionTypes.sol";

/**
 * -------------------------------------------------------------------------
 * @title  Frgmnt Aave V3 Lending Pool Guard (Unified)
 * @notice Guard contract responsible for validating Aave V3 pool operations
 *         executed by a Frgmnt-managed pool through PoolManagerLogic.
 *
 * @dev    This guard:
 *         - Inspects calldata received by PoolManagerLogic.
 *         - Parses the method signature and parameters.
 *         - Ensures the asset + protocol being interacted with is supported.
 *         - Enforces strict borrow/collateralization rules.
 *         - Prevents multi-asset debt positions (Frgmnt rule).
 *         - Emits classification events consumed by PoolLogic.
 *         - Returns a txType code to PoolLogic for execution.
 *
 * @dev    This implementation supports ONLY Aave V3, simplifying logic and
 *         removing dependency on the Governance name registry.
 *
 * @custom:project  Frgmnt Protocol
 * -------------------------------------------------------------------------
 */
contract AaveLendingPoolGuardV3 is TxDataUtils, IGuard, ITxTrackingGuard, ITransactionTypes {
    uint256 public constant HEALTH_FACTOR_LOWER_BOUNDARY = 1.01e18;
    bool public override isTxTrackingGuard = true;

    /*//////////////////////////////////////////////////////////////////////////
                                  EVENTS
  //////////////////////////////////////////////////////////////////////////*/

    /// @dev Emitted for V3 supply() or V2-equivalent deposit()
    event Deposit(
        address fundAddress,
        address asset,
        address lendingPool,
        uint256 amount,
        uint256 time
    );

    /// @dev Emitted when withdrawing from Aave V3
    event Withdraw(
        address fundAddress,
        address asset,
        address lendingPool,
        uint256 amount,
        uint256 time
    );

    /// @dev Emitted when toggling collateralization for an asset
    event SetUserUseReserveAsCollateral(
        address fundAddress,
        address asset,
        bool useAsCollateral,
        uint256 time
    );

    /// @dev Emitted for borrow operations
    event Borrow(
        address fundAddress,
        address asset,
        address lendingPool,
        uint256 amount,
        uint256 time
    );

    /// @dev Emitted for repay() or repayWithATokens()
    event Repay(
        address fundAddress,
        address asset,
        address lendingPool,
        uint256 amount,
        uint256 time
    );

    /// @dev Emitted when switching stable to variable rate
    event SwapBorrowRateMode(address fundAddress, address asset, uint256 rateMode);

    /// @dev Emitted for rebalanceStableBorrowRate
    event RebalanceStableBorrowRate(address fundAddress, address asset);

    /*//////////////////////////////////////////////////////////////////////////
                              PROTOCOL CONFIG
  //////////////////////////////////////////////////////////////////////////*/

    /// @notice Immutable reference to Aave V3 data provider (per-chain)
    /// @dev Used to fetch stored debt token addresses for borrow validation.
    address public immutable aaveProtocolDataProviderV3;

    /*//////////////////////////////////////////////////////////////////////////
                                 CONSTRUCTOR
  //////////////////////////////////////////////////////////////////////////*/

    /**
     * @notice  Instantiates the Aave V3 guard.
     * @param   dataProviderV3  Address of Aave V3 `IAaveProtocolDataProvider`
     *
     * @dev     The Frgmnt Governance system simply attaches this guard to the
     *          Aave V3 lending pool via setContractGuard().
     *          Governance does NOT need to store or map names for Aave contracts.
     */
    constructor(address dataProviderV3) {
        require(dataProviderV3 != address(0), "Frgmnt: zero V3 provider");
        aaveProtocolDataProviderV3 = dataProviderV3;
    }

    /*//////////////////////////////////////////////////////////////////////////
                                TX DISPATCHER
  //////////////////////////////////////////////////////////////////////////*/

    /**
     * @notice Main guard dispatcher called by PoolManagerLogic.
     *
     * @param _poolManagerLogic   The pool's manager logic contract
     * @param to                  Target Aave V3 Pool (actual pool contract)
     * @param data                Encoded function call forwarded from PoolLogic
     *
     * @return txType             Classification code used by PoolLogic
     * @return isPublic           Always false for restricted DeFi interactions
     *
     * @dev    The `txGuard` method MUST NOT revert unless the operation is invalid.
     *         Pools rely on return codes, not catching reverts, for logic handling.
     */
    function txGuard(
        address _poolManagerLogic,
        address to,
        bytes calldata data
    ) public virtual override returns (uint16 txType, bool isPublic) {
        address pool = IPoolManagerLogic(_poolManagerLogic).poolLogic();
        require(msg.sender == pool, "Frgmnt: not pool logic");
        bytes4 method = getMethod(data);

        /*
         * -----------------
         * Aave V3 SUPPLY()
         * -----------------
         *
         * supply(asset, amount, onBehalfOf, referralCode)
         */
        if (method == bytes4(keccak256("supply(address,uint256,address,uint16)"))) {
            (address depositAsset, uint256 amount, address onBehalfOf, ) = abi.decode(
                getParams(data),
                (address, uint256, address, uint16)
            );

            txType = _deposit(pool, _poolManagerLogic, to, depositAsset, amount, onBehalfOf);

            /*
             * ---------------
             * WITHDRAW()
             * ---------------
             */
        } else if (method == bytes4(keccak256("withdraw(address,uint256,address)"))) {
            (address withdrawAsset, uint256 amount, address onBehalfOf) = abi.decode(
                getParams(data),
                (address, uint256, address)
            );

            txType = _withdraw(pool, _poolManagerLogic, to, withdrawAsset, amount, onBehalfOf);

            /*
             * -------------------------------------------
             * SET ASSET AS COLLATERAL (TRUE / FALSE)
             * -------------------------------------------
             */
        } else if (method == bytes4(keccak256("setUserUseReserveAsCollateral(address,bool)"))) {
            (address asset, bool useAsCollateral) = abi.decode(getParams(data), (address, bool));

            txType = _setUserUseReserveAsCollateral(
                pool,
                _poolManagerLogic,
                to,
                asset,
                useAsCollateral
            );

            /*
             * ---------------
             * BORROW()
             * ---------------
             *
             * borrow(asset, amount, interestRateMode, referralCode, onBehalfOf)
             */
        } else if (method == bytes4(keccak256("borrow(address,uint256,uint256,uint16,address)"))) {
            (
                address borrowAsset,
                uint256 amount,
                uint256 interestRateMode,
                ,
                address onBehalfOf
            ) = abi.decode(getParams(data), (address, uint256, uint256, uint16, address));

            txType = _borrow(
                pool,
                _poolManagerLogic,
                to,
                borrowAsset,
                amount,
                interestRateMode,
                onBehalfOf
            );

            /*
             * ---------------
             * REPAY()
             * ---------------
             */
        } else if (method == bytes4(keccak256("repay(address,uint256,uint256,address)"))) {
            (address repayAsset, uint256 amount, , address onBehalfOf) = abi.decode(
                getParams(data),
                (address, uint256, uint256, address)
            );

            txType = _repay(pool, _poolManagerLogic, to, repayAsset, amount, onBehalfOf);

            /*
             * --------------------------------------
             * V3-ONLY: repayWithATokens()
             * --------------------------------------
             */
        } else if (method == bytes4(keccak256("repayWithATokens(address,uint256,uint256)"))) {
            (address asset, uint256 amount, ) = abi.decode(
                getParams(data),
                (address, uint256, uint256)
            );

            txType = _repayWithATokens(pool, _poolManagerLogic, to, asset, amount);

            /*
             * -------------------------
             * swapBorrowRateMode()
             * -------------------------
             *
             * Swaps STABLE → VARIABLE (rateMode=1 means current is stable)
             */
        } else if (method == bytes4(keccak256("swapBorrowRateMode(address,uint256)"))) {
            (address asset, uint256 rateMode) = abi.decode(getParams(data), (address, uint256));

            txType = _swapBorrowRateMode(pool, _poolManagerLogic, to, asset, rateMode);

            /*
             * --------------------------------------------
             * rebalanceStableBorrowRate(asset, user)
             * --------------------------------------------
             */
        } else if (method == bytes4(keccak256("rebalanceStableBorrowRate(address,address)"))) {
            (address asset, address user) = abi.decode(getParams(data), (address, address));

            txType = _rebalanceStableBorrowRate(pool, _poolManagerLogic, to, asset, user);
        }

        return (txType, false); // Aave ops are never public
    }

    /**
     * @notice Post-transaction hook: assert HF above threshold after risky operations.
     * @dev Guards against actions that would push HF below 1.01.
     */
    function afterTxGuard(
        address poolManagerLogic,
        address to,
        bytes memory data
    ) external view override {
        address poolLogic = IPoolManagerLogic(poolManagerLogic).poolLogic();
        require(msg.sender == poolLogic, "Frgmnt: not pool logic");

        bytes4 method = getMethod(data);

        bool riskIncreasing = false;

        // -------------------------
        // BORROW always increases risk
        // -------------------------
        if (method == bytes4(keccak256("borrow(address,uint256,uint256,uint16,address)"))) {
            riskIncreasing = true;
        }

        // -------------------------
        // WITHDRAW: risky only if asset is collateral
        // -------------------------
        if (method == bytes4(keccak256("withdraw(address,uint256,address)"))) {
            (address asset, , ) = abi.decode(getParams(data), (address, uint256, address));

            (, , , , , , , , bool usageAsCollateralEnabled) = IAaveProtocolDataProvider(
                aaveProtocolDataProviderV3
            ).getUserReserveData(asset, poolLogic);

            if (usageAsCollateralEnabled) {
                riskIncreasing = true;
            }
        }

        // -------------------------
        // DISABLING collateral increases risk
        // -------------------------
        if (method == bytes4(keccak256("setUserUseReserveAsCollateral(address,bool)"))) {
            (, bool useAsCollateral) = abi.decode(getParams(data), (address, bool));

            if (!useAsCollateral) {
                riskIncreasing = true;
            }
        }

        // -------------------------
        // Enforce HF only if risk increased
        // -------------------------
        if (riskIncreasing) {
            (, , , , , uint256 healthFactor) = IAaveV3Pool(to).getUserAccountData(poolLogic);

            require(healthFactor > HEALTH_FACTOR_LOWER_BOUNDARY, "Frgmnt: health factor too low");
        }
    }

    /*//////////////////////////////////////////////////////////////////////////
                           INTERNAL HANDLERS (VALIDATION)
  //////////////////////////////////////////////////////////////////////////*/

    /**
     * ---------------------
     * SUPPLY / DEPOSIT
     * ---------------------
     *
     * V3's supply() is equivalent to Aave V2 deposit().
     */
    function _deposit(
        address pool,
        address poolManagerLogic,
        address to,
        address depositAsset,
        uint256 amount,
        address onBehalfOf
    ) internal returns (uint16 txType) {
        IHasSupportedAsset mgr = IHasSupportedAsset(poolManagerLogic);

        // Must be a recognized “lending-enabled” asset
        uint16 assetType = IHasAssetInfo(poolManagerLogic).getAssetType(depositAsset);
        require(assetType == 4, "Frgmnt: not lending-enabled");

        require(mgr.isSupportedAsset(to), "Frgmnt: aave not enabled");
        require(mgr.isSupportedAsset(depositAsset), "Frgmnt: unsupported deposit asset");
        require(onBehalfOf == pool, "Frgmnt: recipient not pool");

        emit Deposit(pool, depositAsset, to, amount, block.timestamp);
        txType = uint16(TransactionType.AaveDeposit);
    }

    /**
     * ---------------------
     * WITHDRAW
     * ---------------------
     */
    function _withdraw(
        address pool,
        address poolManagerLogic,
        address to,
        address withdrawAsset,
        uint256 amount,
        address onBehalfOf
    ) internal returns (uint16 txType) {
        IHasSupportedAsset mgr = IHasSupportedAsset(poolManagerLogic);

        require(mgr.isSupportedAsset(to), "Frgmnt: aave not enabled");
        require(mgr.isSupportedAsset(withdrawAsset), "Frgmnt: unsupported withdraw asset");
        uint16 assetType = IHasAssetInfo(poolManagerLogic).getAssetType(withdrawAsset);
        require(assetType == 4, "Frgmnt: not lending-enabled");

        require(onBehalfOf == pool, "Frgmnt: recipient not pool");

        emit Withdraw(pool, withdrawAsset, to, amount, block.timestamp);
        txType = uint16(TransactionType.AaveWithdraw);
    }

    /**
     * ---------------------
     * SET COLLATERAL
     * ---------------------
     */
    function _setUserUseReserveAsCollateral(
        address pool,
        address poolManagerLogic,
        address to,
        address asset,
        bool useAsCollateral
    ) internal returns (uint16 txType) {
        IHasSupportedAsset mgr = IHasSupportedAsset(poolManagerLogic);

        // Must be borrow-enabled
        uint16 assetType = IHasAssetInfo(poolManagerLogic).getAssetType(asset);
        require(assetType == 4, "Frgmnt: not borrow-enabled");

        require(mgr.isSupportedAsset(to), "Frgmnt: aave not enabled");
        require(mgr.isSupportedAsset(asset), "Frgmnt: unsupported asset");

        emit SetUserUseReserveAsCollateral(pool, asset, useAsCollateral, block.timestamp);
        txType = uint16(TransactionType.AaveSetUserUseReserveAsCollateral);
    }

    /**
     * ---------------------
     * BORROW
     * ---------------------
     *
     * @dev Enforces Frgmnt rule:
     *      → A pool may have **only one** active debt asset.
     */
    function _borrow(
        address pool,
        address poolManagerLogic,
        address to,
        address borrowAsset,
        uint256 amount,
        uint256 interestRateMode,
        address onBehalfOf
    ) internal returns (uint16 txType) {
        // Only variable rate (Aave: 1=stable, 2=variable)
        require(interestRateMode == 2, "Frgmnt: only variable rate");

        uint16 assetType = IHasAssetInfo(poolManagerLogic).getAssetType(borrowAsset);
        require(assetType == 4, "Frgmnt: not borrow-enabled");

        IHasSupportedAsset mgr = IHasSupportedAsset(poolManagerLogic);
        require(mgr.isSupportedAsset(to), "Frgmnt: aave not enabled");
        require(mgr.isSupportedAsset(borrowAsset), "Frgmnt: unsupported borrow asset");
        require(onBehalfOf == pool, "Frgmnt: recipient not pool");

        // -------------------------
        // Single debt-asset rule
        // -------------------------
        IHasSupportedAsset.Asset[] memory supportedAssets = mgr.getSupportedAssets();

        address dataProvider = aaveProtocolDataProviderV3;

        for (uint256 i = 0; i < supportedAssets.length; i++) {
            // Skip the asset we're about to borrow
            if (supportedAssets[i].asset == borrowAsset) continue;

            (
                , // aToken address (ignore)
                address stableDebtToken,
                address variableDebtToken
            ) = IAaveProtocolDataProvider(dataProvider).getReserveTokensAddresses(
                    supportedAssets[i].asset
                );

            // MUST have zero outstanding debt in all other assets
            require(
                (stableDebtToken == address(0) ||
                    IERC20(stableDebtToken).balanceOf(onBehalfOf) == 0) &&
                    (variableDebtToken == address(0) ||
                        IERC20(variableDebtToken).balanceOf(onBehalfOf) == 0),
                "Frgmnt: borrowing asset exists"
            );
        }

        emit Borrow(pool, borrowAsset, to, amount, block.timestamp);
        txType = uint16(TransactionType.AaveBorrow);
    }

    /**
     * ---------------------
     * REPAY
     * ---------------------
     */
    function _repay(
        address pool,
        address poolManagerLogic,
        address to,
        address repayAsset,
        uint256 amount,
        address onBehalfOf
    ) internal returns (uint16 txType) {
        IHasSupportedAsset mgr = IHasSupportedAsset(poolManagerLogic);

        require(mgr.isSupportedAsset(to), "Frgmnt: aave not enabled");
        require(mgr.isSupportedAsset(repayAsset), "Frgmnt: unsupported repay asset");

        uint16 assetType = IHasAssetInfo(poolManagerLogic).getAssetType(repayAsset);
        require(assetType == 4, "Frgmnt: not borrow-enabled");
        require(onBehalfOf == pool, "Frgmnt: recipient not pool");

        emit Repay(pool, repayAsset, to, amount, block.timestamp);
        txType = uint16(TransactionType.AaveRepay);
    }

    /**
     * -----------------------------
     * REPAY USING aTOKENS (V3-only)
     * -----------------------------
     *
     * @dev Similar to standard repay() except:
     *      - The repayment is executed using the accrued aToken balance.
     *      - Regulatory & risk controls remain identical.
     */
    function _repayWithATokens(
        address pool,
        address poolManagerLogic,
        address to,
        address repayAsset,
        uint256 amount
    ) internal returns (uint16 txType) {
        IHasSupportedAsset mgr = IHasSupportedAsset(poolManagerLogic);

        require(mgr.isSupportedAsset(to), "Frgmnt: aave not enabled");
        require(mgr.isSupportedAsset(repayAsset), "Frgmnt: unsupported repay asset");

        uint16 assetType = IHasAssetInfo(poolManagerLogic).getAssetType(repayAsset);
        require(assetType == 4, "Frgmnt: not borrow-enabled");

        emit Repay(pool, repayAsset, to, amount, block.timestamp);
        txType = uint16(TransactionType.AaveRepay);
    }

    /**
     * -----------------------------
     * SWAP RATE MODE (stable -> variable)
     * -----------------------------
     *
     * @dev rateMode = current rate mode:
     *      - 1 = stable
     *      - 2 = variable
     *
     *      Only a stable → variable swap is allowed for risk control.
     */
    function _swapBorrowRateMode(
        address pool,
        address poolManagerLogic,
        address to,
        address asset,
        uint256 rateMode
    ) internal returns (uint16 txType) {
        require(rateMode == 1, "Frgmnt: only stable->variable");
        IHasSupportedAsset mgr = IHasSupportedAsset(poolManagerLogic);
        require(mgr.isSupportedAsset(asset), "Frgmnt: unsupported asset");
        require(mgr.isSupportedAsset(to), "Frgmnt: aave not enabled");

        emit SwapBorrowRateMode(pool, asset, rateMode);
        txType = uint16(TransactionType.AaveSwapBorrowRateMode);
    }

    /**
     * -----------------------------
     * REBALANCE STABLE BORROW RATE
     * -----------------------------
     *
     * @dev Ensures the rebalance can only occur on the pool account itself.
     */
    function _rebalanceStableBorrowRate(
        address pool,
        address poolManagerLogic,
        address to,
        address asset,
        address user
    ) internal returns (uint16 txType) {
        require(user == pool, "Frgmnt: user not pool");
        IHasSupportedAsset mgr = IHasSupportedAsset(poolManagerLogic);
        require(mgr.isSupportedAsset(asset), "Frgmnt: unsupported asset");
        require(mgr.isSupportedAsset(to), "Frgmnt: aave not enabled");
        emit RebalanceStableBorrowRate(pool, asset);
        txType = uint16(TransactionType.AaveRebalanceStableBorrowRate);
    }
}
