// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////
                            IMPORTS
//////////////////////////////////////////////////////////////*/

import { MorphoBalancesLib } from "@morpho-org/morpho-blue/src/libraries/periphery/MorphoBalancesLib.sol";

import {
    IMorpho,
    IMorphoBase,
    Id,
    MarketParams,
    Position,
    Market
} from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";
import { SharesMathLib } from "@morpho-org/morpho-blue/src/libraries/SharesMathLib.sol";
import { IMorphoBlueLendingPoolAssetGuard } from "../../interfaces/guards/IMorphoBlueLendingPoolAssetGuard.sol";
import { IAssetGuard } from "../../interfaces/guards/IAssetGuard.sol";
import { ISlippageCheckingGuard } from "../../interfaces/guards/ISlippageCheckingGuard.sol";
import { IPreValuedAssetGuard } from "../../interfaces/guards/IPreValuedAssetGuard.sol";
import { IDeficitReportingGuard } from "../../interfaces/guards/IDeficitReportingGuard.sol";
import { IPoolLogic } from "../../interfaces/IPoolLogic.sol";
import { IMorphoBlueManager } from "../../interfaces/IMorphoBlueManager.sol";
import { IERC20Extended } from "../../interfaces/IERC20Extended.sol";
import { IHasAssetInfo } from "../../interfaces/IHasAssetInfo.sol";
import { IV3SwapRouter } from "../../interfaces/IV3SwapRouter.sol";
import { ClosedAssetGuard } from "./ClosedAssetGuard.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { MorphoMathLib } from "../../utils/MorphoMathLib.sol";
import { MorphoChecksLib } from "../../utils/MorphoChecksLib.sol";
import { MorphoCollectLib } from "../../utils/MorphoCollectLib.sol";

/*//////////////////////////////////////////////////////////////
                MORPHO BLUE LENDING POOL ASSET GUARD
//////////////////////////////////////////////////////////////*/

/// @title Morpho Blue Lending Pool Asset Guard
/// @notice dHEDGE-compatible AssetGuard for Morpho Blue
/// @dev
///  - Tracks explicit Morpho market Ids per pool
///  - Net balance = collateral + supply − debt (USD, 18 decimals)
///  - Withdrawals are pro-rata
///  - Uses Morpho flashloans to safely unwind debt
contract MorphoBlueLendingPoolAssetGuard is
    Ownable,
    ClosedAssetGuard,
    IMorphoBlueLendingPoolAssetGuard,
    ISlippageCheckingGuard,
    IPreValuedAssetGuard,
    IDeficitReportingGuard
{
    /// @notice Required flag for dHEDGE slippage guards
    bool public override isSlippageCheckingGuard = true;

    /*//////////////////////////////////////////////////////////////
                            IMMUTABLES
  //////////////////////////////////////////////////////////////*/

    /// @notice Morpho Blue core contract (stored as address)
    address public immutable morpho;

    /// @notice Morpho Blue Manager contract
    address public immutable morphoManager;

    /// @notice Uniswap V3 router used for swaps
    address public immutable swapRouter;

    /// @notice Default flashloan settlement asset
    address public immutable preferredSettlementAsset;

    /*//////////////////////////////////////////////////////////////
                            CONFIGURATION
  //////////////////////////////////////////////////////////////*/

    /// @notice Default slippage tolerance (bps)
    uint256 public defaultSlippageBps = 70; // 0.70%

    /// @notice Extra buffer added on flashloan amount
    uint256 public flashAmountBufferBps = 40; // 0.40%

    uint256 public repayDebtBufferBps = 20; // 0.20%

    /// @notice Uniswap V3 fee tiers per token pair
    mapping(address => mapping(address => uint24)) public uniV3Fee;

    /// @notice Tokens requiring approve(0) before approve(amount)
    mapping(address => bool) public requiresApproveReset;

    /*//////////////////////////////////////////////////////////////
                            STRUCTS
  //////////////////////////////////////////////////////////////*/

    /// @notice Parameters forwarded through Morpho flashloan callback
    struct FlashloanParams {
        uint256 withdrawPortion; // Withdraw portion (1e18 = 100%)
        address settlementToken; // Flashloan asset
        uint256 slippageBps; // Slippage tolerance
        MorphoCollectLib.DebtPlan[] debts; // Debt plans
        MorphoCollectLib.SupplyPlan[] supplies; // Supply plans
        MorphoCollectLib.CollateralPlan[] collaterals; // Collateral plans
    }

    /*//////////////////////////////////////////////////////////////
                        EVENTS
  //////////////////////////////////////////////////////////////*/

    /// @notice Emitted when a Uniswap V3 fee tier is set for a token pair
    /// @param tokenIn Input token address
    /// @param tokenOut Output token address
    /// @param fee Fee tier in bps (500, 3000, 10000)
    event UniV3FeeUpdated(address indexed tokenIn, address indexed tokenOut, uint24 fee);

    /// @notice Emitted when the default slippage tolerance is updated
    /// @param oldBps Previous slippage tolerance (bps)
    /// @param newBps New slippage tolerance (bps)
    event DefaultSlippageBpsUpdated(uint256 oldBps, uint256 newBps);

    /// @notice Emitted when the flashloan buffer is updated
    /// @param oldBps Previous flashloan buffer (bps)
    /// @param newBps New flashloan buffer (bps)
    event FlashAmountBufferBpsUpdated(uint256 oldBps, uint256 newBps);

    /// @notice Emitted when the Morpho repayment Debt buffer is updated
    /// @param oldBps Previous repayment allowance buffer (bps)
    /// @param newBps New repayment allowance buffer (bps)
    event RepayDebtBufferBpsUpdated(uint256 oldBps, uint256 newBps);

    /// @notice Emitted when a token's approve reset requirement is updated
    /// @param token Token address
    /// @param oldValue Previous value
    /// @param newValue New value
    event RequiresApproveResetUpdated(address indexed token, bool oldValue, bool newValue);

    // ============================================================
    // =                         ERRORS                           =
    // ============================================================
    error MorphoZero();
    error MorphoManagerZero();
    error RouterZero();
    error SettlementZero();
    error InvalidToken();
    error InvalidFee();
    error SlippageTooHigh();
    error FlashBufferTooHigh();
    error RepayBufferTooHigh();
    error TokenZero();
    error BadPortion();
    error ToZero();
    error FeeNotSet();
    error SettlementMismatch();

    /*//////////////////////////////////////////////////////////////
                            CONSTRUCTOR
  //////////////////////////////////////////////////////////////*/

    /// @param morpho_ Morpho Blue core contract
    /// @param swapRouter_ Uniswap V3 router
    /// @param preferredSettlementAsset_ Default flashloan token
    constructor(
        address morpho_,
        address morphoManager_,
        address swapRouter_,
        address preferredSettlementAsset_
    ) Ownable(msg.sender) {
        if (morpho_ == address(0)) revert MorphoZero();
        if (morphoManager_ == address(0)) revert MorphoManagerZero();
        if (swapRouter_ == address(0)) revert RouterZero();
        if (preferredSettlementAsset_ == address(0)) revert SettlementZero();
        morpho = morpho_;
        morphoManager = morphoManager_;
        swapRouter = swapRouter_;
        preferredSettlementAsset = preferredSettlementAsset_;
    }

    /// @notice Sets Uniswap V3 fee tier for a token pair
    /// @dev fee must be one of the valid Uniswap V3 fees (e.g., 500, 3000, 10000)
    function setUniV3Fee(address tokenIn, address tokenOut, uint24 fee) external onlyOwner {
        if (tokenIn == address(0) || tokenOut == address(0)) revert InvalidToken();
        if (fee != 500 && fee != 3000 && fee != 10000) revert InvalidFee();
        uniV3Fee[tokenIn][tokenOut] = fee;
        emit UniV3FeeUpdated(tokenIn, tokenOut, fee);
    }

    function setDefaultSlippageBps(uint256 _bps) external onlyOwner {
        if (_bps > MorphoMathLib.BPS_DENOMINATOR) revert SlippageTooHigh();
        emit DefaultSlippageBpsUpdated(defaultSlippageBps, _bps);
        defaultSlippageBps = _bps;
    }

    function setFlashAmountBufferBps(uint256 _bps) external onlyOwner {
        if (_bps > MorphoMathLib.BPS_DENOMINATOR) revert FlashBufferTooHigh();
        emit FlashAmountBufferBpsUpdated(flashAmountBufferBps, _bps);
        flashAmountBufferBps = _bps;
    }

    function setRepayDebtBufferBps(uint256 _bps) external onlyOwner {
        if (_bps > MorphoMathLib.BPS_DENOMINATOR) revert RepayBufferTooHigh();
        emit RepayDebtBufferBpsUpdated(repayDebtBufferBps, _bps);
        repayDebtBufferBps = _bps;
    }

    /// @notice Sets whether a token requires approve(0) before approve(amount)
    /// @param token Token address
    /// @param value True if approve reset is required, false otherwise
    function setRequiresApproveReset(address token, bool value) external onlyOwner {
        if (token == address(0)) revert TokenZero();
        bool oldValue = requiresApproveReset[token];
        requiresApproveReset[token] = value;
        emit RequiresApproveResetUpdated(token, oldValue, value);
    }

    /*//////////////////////////////////////////////////////////////
                        BALANCE LOGIC
  //////////////////////////////////////////////////////////////*/

    /// @notice Returns the pool's net USD exposure on Morpho
    /// @dev USD value is returned with 18 decimals
    function getBalance(address pool, address) public view override returns (uint256 balanceUsd18) {
        balanceUsd18 = MorphoCollectLib.getBalance(morphoManager, morpho, pool);
    }

    /// @notice FNA-54: see IDeficitReportingGuard — an underwater position (aggregate debt
    ///         exceeding aggregate collateral+supply across this pool's tracked Morpho Blue
    ///         markets) is a real liability, not a zero-value asset. getBalance() above must
    ///         still clamp at 0 (every NAV consumer sums non-negative uint256 balances), but
    ///         that silently *omits* the shortfall instead of *subtracting* it from the rest of
    ///         the pool's positive balances. Every aggregate NAV/withdrawal-sizing consumer sums
    ///         this alongside its gross positive total and subtracts it (floored at 0) — see this
    ///         interface's own docs.
    function isDeficitReportingGuard() external pure override returns (bool) {
        return true;
    }

    function getDeficit(address pool, address) external view override returns (uint256 deficitUsd18) {
        deficitUsd18 = MorphoCollectLib.getDeficit(morphoManager, morpho, pool);
    }

    /// @notice AssetGuard balances are always expressed in USD (18 decimals)
    function getDecimals(address) external pure override returns (uint256) {
        return 18;
    }

    /// @notice getBalance() already returns a fully priced base-currency value; see
    ///         IPreValuedAssetGuard and PoolManagerLogic.assetValue().
    function isPreValuedAssetGuard() external pure override returns (bool) {
        return true;
    }

    /// @notice Ensures no open Morpho position exists before asset removal
    function removeAssetCheck(address pool, address) public view override {
        MorphoChecksLib.removeAssetCheck(morpho, morphoManager, pool);
    }

    function removeTokenCheck(
        address pool,
        address,
        address token
    ) public view override returns (bool) {
        return MorphoChecksLib.removeTokenCheck(morpho, morphoManager, pool, token);
    }

    /*//////////////////////////////////////////////////////////////
                      WITHDRAW PROCESSING
  //////////////////////////////////////////////////////////////*/

    /// @notice Builds a deterministic withdrawal execution plan
    /// @dev Called by PoolLogic before executing withdrawal
    function withdrawProcessing(
        address pool,
        address,
        uint256 withdrawPortion,
        address to
    ) external view override returns (address, uint256, MultiTransaction[] memory txs) {
        if (withdrawPortion > MorphoMathLib.PORTION_DENOMINATOR) {
            revert BadPortion();
        }
        if (to == address(0)) revert ToZero();

        // Collect debt and supply plans
        (MorphoCollectLib.DebtPlan[] memory debts, bool hasDebt) = _collectDebts(
            pool,
            withdrawPortion
        );
        MorphoCollectLib.SupplyPlan[] memory supplies = _collectSupplies(pool, withdrawPortion);

        MorphoCollectLib.CollateralPlan[] memory collaterals = _collectCollaterals(
            pool,
            withdrawPortion
        );

        // No debt → direct withdraw
        if (!hasDebt) {
            txs = _withdrawNoDebt(pool, supplies, collaterals, to);
            return (address(0), 0, txs);
        }

        // Debt exists → flashloan unwind
        address settlementToken = _chooseSettlementToken(debts);
        uint256 flashAmount = _estimateFlashAmount(
            pool,
            debts,
            settlementToken,
            defaultSlippageBps
        );

        FlashloanParams memory fp = FlashloanParams({
            withdrawPortion: withdrawPortion,
            settlementToken: settlementToken,
            slippageBps: defaultSlippageBps,
            debts: debts,
            supplies: supplies,
            collaterals: collaterals
        });

        txs = new MultiTransaction[](1);
        txs[0].to = morpho;
        txs[0].txData = abi.encodeWithSelector(
            IMorphoBase.flashLoan.selector,
            settlementToken,
            flashAmount,
            abi.encode(settlementToken, abi.encode(fp))
        );

        return (settlementToken, 0, txs);
    }

    /*//////////////////////////////////////////////////////////////
                    FLASHLOAN CALLBACK
  //////////////////////////////////////////////////////////////*/

    /// @notice Builds the execution plan after receiving a flashloan
    function flashloanProcessing(
        address pool,
        address repayAsset,
        uint256 repayAmount,
        bytes calldata params
    ) external view override returns (MultiTransaction[] memory out) {
        FlashloanParams memory fp = abi.decode(params, (FlashloanParams));
        if (fp.settlementToken != repayAsset) revert SettlementMismatch();
        MultiTransaction[] memory p1 = _swapSettlementToDebts(pool, fp);
        // approve ALL loanTokens instead of only settlement token
        MultiTransaction[] memory p1b = _approveMorphoForAllDebts(fp);
        MultiTransaction[] memory p2 = _repayDebts(pool, fp.debts);

        (
            MultiTransaction[] memory p3,
            address[] memory tokens,
            uint256[] memory amounts
        ) = _withdrawAllAssets(pool, fp);

        MultiTransaction[] memory p4 = _swapAssetsToSettlement(pool, tokens, amounts, fp);

        MultiTransaction[] memory p5 = _approveFlashRepay(fp.settlementToken, repayAmount);

        out = _concat5(p1, p1b, p2, p3, p4, p5);
    }

    /*//////////////////////////////////////////////////////////////
                    DEBT COLLECTION
  //////////////////////////////////////////////////////////////*/

    /// @notice Builds pro-rata debt repayment plans
    function _collectDebts(
        address pool,
        uint256 portion
    ) internal view returns (MorphoCollectLib.DebtPlan[] memory plans, bool hasDebt) {
        (plans, hasDebt) = MorphoCollectLib.collectDebts(morphoManager, morpho, pool, portion);
    }

    /// @notice Builds pro-rata supply withdrawal plans
    function _collectSupplies(
        address pool,
        uint256 portion
    ) internal view returns (MorphoCollectLib.SupplyPlan[] memory plans) {
        plans = MorphoCollectLib.collectSupplies(morphoManager, morpho, pool, portion);
    }

    function _collectCollaterals(
        address pool,
        uint256 portion
    ) internal view returns (MorphoCollectLib.CollateralPlan[] memory plans) {
        plans = MorphoCollectLib.collectCollaterals(morphoManager, morpho, pool, portion);
    }

    /// @notice Withdraws supplies directly when no debt exists
    function _withdrawNoDebt(
        address pool,
        MorphoCollectLib.SupplyPlan[] memory supplies,
        MorphoCollectLib.CollateralPlan[] memory collaterals,
        address to
    ) internal view returns (MultiTransaction[] memory txs) {
        txs = new MultiTransaction[](supplies.length + collaterals.length);
        uint256 n;

        for (uint256 i; i < supplies.length; i++) {
            if (supplies[i].withdrawSupplyShares == 0) continue;

            txs[n].to = morpho;
            txs[n++].txData = abi.encodeWithSelector(
                IMorphoBase.withdraw.selector,
                supplies[i].mp,
                uint256(0),
                supplies[i].withdrawSupplyShares,
                pool,
                to
            );
        }

        // Withdraw collaterals
        for (uint256 i; i < collaterals.length; i++) {
            if (collaterals[i].withdrawCollateral == 0) continue;
            txs[n].to = morpho;
            txs[n++].txData = abi.encodeWithSelector(
                IMorphoBase.withdrawCollateral.selector,
                collaterals[i].mp,
                collaterals[i].withdrawCollateral,
                pool,
                to,
                bytes("")
            );
        }

        assembly {
            mstore(txs, n)
        }
    }

    /// @notice Chooses the settlement token

    function _chooseSettlementToken(
        MorphoCollectLib.DebtPlan[] memory debts
    ) internal view returns (address) {
        address firstToken;
        bool found;

        for (uint256 i; i < debts.length; i++) {
            if (debts[i].repayAssetsEst == 0) continue;

            address token = debts[i].mp.loanToken;

            if (!found) {
                firstToken = token;
                found = true;
            } else if (token != firstToken) {
                // Two different tokens exist → fallback
                return preferredSettlementAsset;
            }
        }

        // All non-zero debts use the same token, or none exist
        return found ? firstToken : preferredSettlementAsset;
    }

    /// @notice Estimates flashloan amount required to repay all debts
    function _estimateFlashAmount(
        address pool,
        MorphoCollectLib.DebtPlan[] memory debts,
        address settlement,
        uint256 slippageBps
    ) internal view returns (uint256 amt) {
        address factory = IPoolLogic(pool).factory();
        uint256 repayAssets;
        uint24 fee;
        uint256 totalMaxIn;
        for (uint256 i; i < debts.length; i++) {
            repayAssets = debts[i].repayAssetsEst;
            if (repayAssets == 0) continue;

            // Skip  swap calculation if debt token is the same as settlement token
            if (debts[i].mp.loanToken == settlement) {
                totalMaxIn += _bufferedRepay(repayAssets);
                continue;
            }
            repayAssets = _bufferedRepay(repayAssets);
            fee = uniV3Fee[settlement][debts[i].mp.loanToken];
            if (fee == 0) revert FeeNotSet();
            totalMaxIn += MorphoMathLib.oracleMaxIn(
                factory,
                settlement,
                debts[i].mp.loanToken,
                repayAssets,
                slippageBps,
                fee
            );
        }
        uint256 BPS_DENOMINATOR = MorphoMathLib.BPS_DENOMINATOR;
        amt = (totalMaxIn * (BPS_DENOMINATOR + flashAmountBufferBps)) / BPS_DENOMINATOR;
    }

    /// @notice Swaps settlement asset into debt tokens
    function _swapSettlementToDebts(
        address pool,
        FlashloanParams memory fp
    ) internal view returns (MultiTransaction[] memory txs) {
        txs = new MultiTransaction[](fp.debts.length * 3);
        uint256 n;
        uint24 fee;
        uint256 repayAmount;
        MorphoCollectLib.DebtPlan memory d;
        uint256 maxIn;
        uint256 totalBorrowAssets;
        uint256 totalBorrowShares;

        for (uint256 i; i < fp.debts.length; i++) {
            d = fp.debts[i];
            if (d.repayAssetsEst == 0) continue;
            if (d.mp.loanToken == fp.settlementToken) continue;
            (, , totalBorrowAssets, totalBorrowShares) = MorphoCollectLib._getAccruedMarketTotals(
                morpho,
                d.mp
            );

            repayAmount = SharesMathLib.toAssetsUp(
                d.repayBorrowShares,
                totalBorrowAssets,
                totalBorrowShares
            );
            repayAmount = _bufferedRepay(repayAmount);

            fee = uniV3Fee[fp.settlementToken][d.mp.loanToken];
            if (fee == 0) revert FeeNotSet();

            maxIn = MorphoMathLib.oracleMaxIn(
                IPoolLogic(pool).factory(),
                fp.settlementToken,
                d.mp.loanToken,
                repayAmount,
                fp.slippageBps,
                fee
            );

            if (requiresApproveReset[fp.settlementToken]) {
                txs[n] = MultiTransaction({
                    to: fp.settlementToken,
                    txData: abi.encodeWithSelector(IERC20Extended.approve.selector, swapRouter, 0)
                });
                n++;
            }

            txs[n] = MultiTransaction({
                to: fp.settlementToken,
                txData: abi.encodeWithSelector(
                    IERC20Extended.approve.selector,
                    swapRouter,
                    type(uint256).max
                )
            });
            n++;
            txs[n] = MultiTransaction({
                to: swapRouter,
                txData: abi.encodeWithSelector(
                    IV3SwapRouter.exactOutputSingle.selector,
                    IV3SwapRouter.ExactOutputSingleParams({
                        tokenIn: fp.settlementToken,
                        tokenOut: d.mp.loanToken,
                        fee: fee,
                        recipient: pool,
                        amountOut: repayAmount,
                        amountInMaximum: maxIn,
                        sqrtPriceLimitX96: 0
                    })
                )
            });

            n++;
        }

        assembly {
            mstore(txs, n)
        }
    }

    /// @notice Repays all Morpho debts
    function _repayDebts(
        address pool,
        MorphoCollectLib.DebtPlan[] memory debts
    ) internal view returns (MultiTransaction[] memory txs) {
        txs = new MultiTransaction[](debts.length);
        uint256 n;

        for (uint256 i; i < debts.length; i++) {
            if (debts[i].repayBorrowShares == 0) continue;

            txs[n].to = morpho;
            txs[n++].txData = abi.encodeWithSelector(
                IMorphoBase.repay.selector,
                debts[i].mp,
                0, // assets = 0
                debts[i].repayBorrowShares, //  repay by shares
                pool,
                bytes("") // empty data
            );
        }

        assembly {
            mstore(txs, n)
        }
    }

    /// @notice Withdraws all supplies and collaterals after debts are repaid
    function _withdrawAllAssets(
        address pool,
        FlashloanParams memory fp
    )
        internal
        view
        returns (MultiTransaction[] memory txs, address[] memory tokens, uint256[] memory amounts)
    {
        uint256 size = fp.supplies.length + fp.collaterals.length;
        txs = new MultiTransaction[](size);
        tokens = new address[](size);
        amounts = new uint256[](size);

        uint256 n;
        for (uint256 i; i < fp.supplies.length; i++) {
            MorphoCollectLib.SupplyPlan memory s = fp.supplies[i];
            if (s.withdrawSupplyShares == 0) continue;

            txs[n].to = morpho;
            txs[n].txData = abi.encodeWithSelector(
                IMorphoBase.withdraw.selector,
                s.mp,
                uint256(0),
                s.withdrawSupplyShares,
                pool,
                pool
            );

            tokens[n] = s.mp.loanToken;
            amounts[n] = s.withdrawAssetsEst;
            n++;
        }

        // --- Withdraw collaterals ---
        for (uint256 i; i < fp.collaterals.length; i++) {
            MorphoCollectLib.CollateralPlan memory c = fp.collaterals[i];
            if (c.withdrawCollateral == 0) continue;

            txs[n].to = morpho;
            txs[n].txData = abi.encodeWithSelector(
                IMorphoBase.withdrawCollateral.selector,
                c.mp,
                c.withdrawCollateral,
                pool,
                pool,
                bytes("") // empty data
            );

            tokens[n] = c.mp.collateralToken;
            amounts[n] = c.withdrawCollateral;
            n++;
        }

        assembly {
            mstore(txs, n)
            mstore(tokens, n)
            mstore(amounts, n)
        }
    }

    /// @notice Swaps withdrawn assets back to settlement token
    function _swapAssetsToSettlement(
        address pool,
        address[] memory tokens,
        uint256[] memory amounts,
        FlashloanParams memory fp
    ) internal view returns (MultiTransaction[] memory txs) {
        txs = new MultiTransaction[](tokens.length * 3);
        uint256 n;
        uint24 fee;
        address factory = IPoolLogic(pool).factory();

        for (uint256 i; i < tokens.length; i++) {
            if (tokens[i] == fp.settlementToken || amounts[i] == 0) continue;

            fee = uniV3Fee[tokens[i]][fp.settlementToken];
            if (fee == 0) revert FeeNotSet();

            uint256 minOut = MorphoMathLib.oracleMinOut(
                factory,
                tokens[i],
                fp.settlementToken,
                amounts[i],
                fp.slippageBps,
                fee
            );

            if (requiresApproveReset[tokens[i]]) {
                txs[n] = MultiTransaction({
                    to: tokens[i],
                    txData: abi.encodeWithSelector(IERC20Extended.approve.selector, swapRouter, 0)
                });

                n++;
            }

            txs[n] = MultiTransaction({
                to: tokens[i],
                txData: abi.encodeWithSelector(
                    IERC20Extended.approve.selector,
                    swapRouter,
                    type(uint256).max
                )
            });

            n++;

            txs[n] = MultiTransaction({
                to: swapRouter,
                txData: abi.encodeWithSelector(
                    IV3SwapRouter.exactInputSingle.selector,
                    IV3SwapRouter.ExactInputSingleParams({
                        tokenIn: tokens[i],
                        tokenOut: fp.settlementToken,
                        fee: fee,
                        recipient: pool,
                        amountIn: amounts[i],
                        amountOutMinimum: minOut,
                        sqrtPriceLimitX96: 0
                    })
                )
            });

            n++;
        }

        assembly {
            mstore(txs, n)
        }
    }

    /// @notice Approves Morpho to pull flashloan repayment
    function _approveFlashRepay(
        address token,
        uint256 amount
    ) internal view returns (MultiTransaction[] memory txs) {
        return _approveMorphoForToken(token, amount);
    }

    /// @notice approve Morpho for ALL loanTokens involved in debt repayment
    function _approveMorphoForAllDebts(
        FlashloanParams memory fp
    ) internal view returns (MultiTransaction[] memory txs) {
        uint256 len = fp.debts.length;

        if (len == 0) return new MultiTransaction[](0);

        // temporary arrays for token aggregation
        address[] memory tokens = new address[](len);
        uint256[] memory amounts = new uint256[](len);
        uint256 unique;
        address loanToken;
        uint256 exactAssets;
        bool found;
        uint256 totalBorrowAssets;
        uint256 totalBorrowShares;

        // -------------------------------------------------
        // STEP 1 — aggregate buffered repay per loanToken
        // -------------------------------------------------
        for (uint256 i; i < len; i++) {
            found = false; // MUST reset
            loanToken = fp.debts[i].mp.loanToken;
            (, , totalBorrowAssets, totalBorrowShares) = MorphoCollectLib._getAccruedMarketTotals(
                morpho,
                fp.debts[i].mp
            );

            exactAssets = SharesMathLib.toAssetsUp(
                fp.debts[i].repayBorrowShares,
                totalBorrowAssets,
                totalBorrowShares
            );
            exactAssets = _bufferedRepay(exactAssets);

            for (uint256 j; j < unique; j++) {
                if (tokens[j] == loanToken) {
                    amounts[j] += exactAssets;
                    found = true;
                    break;
                }
            }

            if (!found) {
                tokens[unique] = loanToken;
                amounts[unique] = exactAssets;
                unique++;
            }
        }

        // -------------------------------------------------
        // STEP 2 — build approvals using shared helper
        // -------------------------------------------------
        MultiTransaction[] memory temp = new MultiTransaction[](unique * 2);
        uint256 n;
        for (uint256 i; i < unique; i++) {
            MultiTransaction[] memory approvals = _approveMorphoForToken(tokens[i], amounts[i]);
            for (uint256 j; j < approvals.length; j++) {
                temp[n++] = approvals[j];
            }
        }

        // -------------------------------------------------
        // STEP 3 — trim result array
        // -------------------------------------------------
        assembly {
            mstore(temp, n)
        }
        txs = temp;
    }

    /// @notice Shared approve Morpho for a token amount (handles USDT reset when needed).
    function _approveMorphoForToken(
        address token,
        uint256 amount
    ) internal view returns (MultiTransaction[] memory txs) {
        if (requiresApproveReset[token]) {
            txs = new MultiTransaction[](2);
            txs[0].to = token;
            txs[0].txData = abi.encodeWithSelector(IERC20Extended.approve.selector, morpho, 0);
            txs[1].to = token;
            txs[1].txData = abi.encodeWithSelector(IERC20Extended.approve.selector, morpho, amount);
        } else {
            txs = new MultiTransaction[](1);
            txs[0].to = token;
            txs[0].txData = abi.encodeWithSelector(IERC20Extended.approve.selector, morpho, amount);
        }
    }

    function _bufferedRepay(uint256 amount) internal view returns (uint256) {
        uint256 BPS_DENOMINATOR = MorphoMathLib.BPS_DENOMINATOR;
        return (amount * (BPS_DENOMINATOR + repayDebtBufferBps)) / BPS_DENOMINATOR;
    }

    function _concat5(
        MultiTransaction[] memory a,
        MultiTransaction[] memory b,
        MultiTransaction[] memory c,
        MultiTransaction[] memory d,
        MultiTransaction[] memory e,
        MultiTransaction[] memory f
    ) internal pure returns (MultiTransaction[] memory out) {
        out = new MultiTransaction[](
            a.length + b.length + c.length + d.length + e.length + f.length
        );
        uint256 k;
        for (uint256 i; i < a.length; i++) out[k++] = a[i];
        for (uint256 i; i < b.length; i++) out[k++] = b[i];
        for (uint256 i; i < c.length; i++) out[k++] = c[i];
        for (uint256 i; i < d.length; i++) out[k++] = d[i];
        for (uint256 i; i < e.length; i++) out[k++] = e[i];
        for (uint256 i; i < f.length; i++) out[k++] = f[i];
    }
}
