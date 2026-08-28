// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { CLPriceLibrary } from "../utils/CLPriceLibrary.sol";
import { FundCalculationLibrary } from "../utils/FundCalculationLibrary.sol";
import { AddressHelper } from "../utils/AddressHelper.sol";
import { MorphoChecksLib } from "../utils/MorphoChecksLib.sol";
import { MorphoMathLib } from "../utils/MorphoMathLib.sol";
import { PrecisionHelper } from "../utils/PrecisionHelper.sol";
import { SafeERC20 } from "../utils/SafeERC20.sol";
import { IERC20 } from "../interfaces/IERC20.sol";
import { TxDataUtils } from "../utils/TxDataUtils.sol";

contract TestCLPriceLibrary {
    function isSqrtPriceDeviationInRange(
        uint24 fee,
        uint160 sqrtPriceX96,
        uint160 fairSqrtPriceX96
    ) external pure returns (bool) {
        return CLPriceLibrary.isSqrtPriceDeviationInRange(fee, sqrtPriceX96, fairSqrtPriceX96);
    }

    function calculateSqrtPrice(
        uint256 token0Price,
        uint256 token1Price,
        uint8 token0Decimals,
        uint8 token1Decimals
    ) external pure returns (uint160) {
        return CLPriceLibrary.calculateSqrtPrice(
            token0Price,
            token1Price,
            token0Decimals,
            token1Decimals
        );
    }
}

/// @notice Simulates a PoolManagerLogic implementation from before the FNA-04 fix — has
///         totalFundValue() but not totalFundValueWithCompleteness() — so tests can exercise
///         FundCalculationLibrary.totalValueWithCompleteness()'s low-level-call fallback against
///         a target that genuinely lacks the new function, not just one that hasn't been asked
///         for it yet.
contract TestLegacyPoolManagerLogic {
    uint256 public totalFundValue_;

    function setTotalFundValue(uint256 v) external {
        totalFundValue_ = v;
    }

    function totalFundValue() external view returns (uint256) {
        return totalFundValue_;
    }
}

/// @notice Minimal configurable IPoolLogic stand-in for isolated FundCalculationLibrary tests
///         (computeImmediateWithdrawPortion / computeFinalizeAssetAmount, FNA-05) — exposes just
///         the fusd()/poolManagerLogic()/reservedAssetBalance() surface those functions read.
contract TestPoolLogicForFundCalc {
    address public fusd;
    address public poolManagerLogic;
    mapping(address => uint256) public reservedAssetBalance;
    // FNA-34: lets a test simulate outstanding, unharvested staking rewards that
    // computeImmediateWithdrawPortion/computeFinalizeAssetAmount must add to totalClaims.
    uint256 public totalRewardAccrued;
    uint256 public totalRewardHarvested;
    // FNA-38: lets a test simulate a coexisting finalized-but-unclaimed request's FUSD that
    // computeImmediateWithdrawPortion/computeFinalizeAssetAmount must exclude from totalClaims.
    uint256 public finalizedUnclaimedFusd;

    function setFusd(address _fusd) external {
        fusd = _fusd;
    }

    function setPoolManagerLogic(address _poolManagerLogic) external {
        poolManagerLogic = _poolManagerLogic;
    }

    function setReservedAssetBalance(address asset, uint256 amount) external {
        reservedAssetBalance[asset] = amount;
    }

    function setTotalRewardAccrued(uint256 amount) external {
        totalRewardAccrued = amount;
    }

    function setTotalRewardHarvested(uint256 amount) external {
        totalRewardHarvested = amount;
    }

    function setFinalizedUnclaimedFusd(uint256 amount) external {
        finalizedUnclaimedFusd = amount;
    }
}

contract TestFundCalculationLibrary {
    function calculatePerformanceFee(
        uint256 totalValue,
        uint256 accountedAssets,
        uint256 performanceFeeNumerator,
        uint256 feeDenominator
    ) external pure returns (uint256 performanceFee, uint256 netYield) {
        return
            FundCalculationLibrary.calculatePerformanceFee(
                totalValue,
                accountedAssets,
                performanceFeeNumerator,
                feeDenominator
            );
    }

    function calculateManagementFee(
        uint256 totalFusd,
        uint256 lastFeeMintTime,
        uint256 managementFeeNumerator,
        uint256 feeDenominator
    ) external view returns (uint256 managementFee, uint256 updatedLastFeeMintTime) {
        return
            FundCalculationLibrary.calculateManagementFee(
                totalFusd,
                lastFeeMintTime,
                managementFeeNumerator,
                feeDenominator
            );
    }

    function fusdToAssetAmount(
        address poolManagerLogic,
        uint256 fusdAmount,
        address asset
    ) external view returns (uint256) {
        return FundCalculationLibrary.fusdToAssetAmount(poolManagerLogic, fusdAmount, asset);
    }

    function computeYieldAccrual(
        uint256 totalValue,
        bool navComplete,
        uint256 accountedAssets,
        uint256 totalFusd,
        uint256 lastFeeMintTime,
        uint256 performanceFeeNumerator,
        uint256 managementFeeNumerator,
        uint256 feeDenominator,
        bool applyClamp
    )
        external
        view
        returns (
            uint256 performanceFee,
            uint256 managementFee,
            uint256 netYield,
            uint256 newAccountedAssets,
            uint256 newLastFeeMintTime
        )
    {
        return
            FundCalculationLibrary.computeYieldAccrual(
                totalValue,
                navComplete,
                accountedAssets,
                totalFusd,
                lastFeeMintTime,
                performanceFeeNumerator,
                managementFeeNumerator,
                feeDenominator,
                applyClamp
            );
    }

    function totalValueWithCompleteness(
        address poolManagerLogic
    ) external view returns (uint256 total, bool complete) {
        return FundCalculationLibrary.totalValueWithCompleteness(poolManagerLogic);
    }

    function activeTotalValueWithCompleteness(
        address pool,
        address poolManagerLogic
    ) external view returns (uint256 total, bool complete) {
        return FundCalculationLibrary.activeTotalValueWithCompleteness(pool, poolManagerLogic);
    }

    function applyClaimsHaircut(
        uint256 grossFusd,
        uint256 fundValue,
        uint256 totalClaims
    ) external pure returns (uint256) {
        return FundCalculationLibrary.applyClaimsHaircut(grossFusd, fundValue, totalClaims);
    }

    function computeImmediateWithdrawPortion(
        address pool,
        uint256 netFusd,
        uint256 withdrawableFundValue
    ) external view returns (uint256 portion) {
        (portion, , ) = FundCalculationLibrary.computeImmediateWithdrawPortion(
            pool,
            netFusd,
            withdrawableFundValue
        );
    }

    function computeAccountedAssetsReduction(
        uint256 netFusd,
        uint256 totalClaimsBeforeWithdrawal,
        uint256 accountedAssetsBefore,
        uint256 valueBefore,
        uint256 valueDelta
    ) external pure returns (uint256) {
        return
            FundCalculationLibrary.computeAccountedAssetsReduction(
                netFusd,
                totalClaimsBeforeWithdrawal,
                accountedAssetsBefore,
                valueBefore,
                valueDelta
            );
    }

    function computeFinalizeAssetAmount(
        address pool,
        address asset,
        uint256 grossFusd
    ) external view returns (uint256 assetAmount) {
        (assetAmount, , ) = FundCalculationLibrary.computeFinalizeAssetAmount(pool, asset, grossFusd);
    }
}

contract TestTxDataUtils is TxDataUtils {
    function exposedSliceUint(bytes memory data, uint256 start) external pure returns (uint256) {
        return sliceUint(data, start);
    }
}

contract TestAddressHelper {
    uint256 public value;

    function tryCall(address to, bytes memory data) external returns (bool) {
        return AddressHelper.tryAssemblyCall(to, data);
    }

    function tryDelegateCall(address to, bytes memory data) external returns (bool) {
        return AddressHelper.tryAssemblyDelegateCall(to, data);
    }
}

contract TestAddressHelperTarget {
    uint256 public value;

    function setValue(uint256 newValue) external {
        value = newValue;
    }

    function failWithReason() external pure {
        revert("target failed");
    }
}

contract TestMorphoMathLib {
    function oracleMinOut(
        address factory,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 slippageBps,
        uint24 fee
    ) external view returns (uint256) {
        return MorphoMathLib.oracleMinOut(factory, tokenIn, tokenOut, amountIn, slippageBps, fee);
    }

    function oracleMaxIn(
        address factory,
        address tokenIn,
        address tokenOut,
        uint256 amountOut,
        uint256 slippageBps,
        uint24 fee
    ) external view returns (uint256) {
        return MorphoMathLib.oracleMaxIn(factory, tokenIn, tokenOut, amountOut, slippageBps, fee);
    }

    function effectiveSlippageExactIn(
        uint256 slippageBps,
        uint256 fee
    ) external pure returns (uint256) {
        return MorphoMathLib._effectiveSlippageExactIn(slippageBps, fee);
    }

    function effectiveSlippageExactOut(
        uint256 slippageBps,
        uint256 fee
    ) external pure returns (uint256) {
        return MorphoMathLib._effectiveSlippageExactOut(slippageBps, fee);
    }

    function mulPortionRoundUp(uint256 x, uint256 p) external pure returns (uint256) {
        return MorphoMathLib.mulPortionRoundUp(x, p);
    }

    function mulPortionRoundDown(uint256 x, uint256 p) external pure returns (uint256) {
        return MorphoMathLib.mulPortionRoundDown(x, p);
    }
}

contract TestMorphoChecksLib {
    function removeAssetCheck(address morpho, address morphoManager, address pool) external view {
        MorphoChecksLib.removeAssetCheck(morpho, morphoManager, pool);
    }

    function removeTokenCheck(
        address morpho,
        address morphoManager,
        address pool,
        address token
    ) external view returns (bool) {
        return MorphoChecksLib.removeTokenCheck(morpho, morphoManager, pool, token);
    }
}

contract TestPrecisionHelper {
    function getPrecisionForConversion(address token) external view returns (uint256) {
        return PrecisionHelper.getPrecisionForConversion(token);
    }
}

contract TestSafeERC20 {
    using SafeERC20 for IERC20;

    function safeTransfer(IERC20 token, address to, uint256 value) external {
        token.safeTransfer(to, value);
    }

    function safeTransferFrom(IERC20 token, address from, address to, uint256 value) external {
        token.safeTransferFrom(from, to, value);
    }

    function safeApprove(IERC20 token, address spender, uint256 value) external {
        token.safeApprove(spender, value);
    }

    function safeIncreaseAllowance(IERC20 token, address spender, uint256 value) external {
        token.safeIncreaseAllowance(spender, value);
    }

    function safeDecreaseAllowance(IERC20 token, address spender, uint256 value) external {
        token.safeDecreaseAllowance(spender, value);
    }
}

contract TestFalseReturnERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function totalSupply() external pure returns (uint256) {
        return 0;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return false;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

contract TestNoReturnERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function totalSupply() external pure returns (uint256) {
        return 0;
    }

    function transfer(address to, uint256 value) external {
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
    }

    function approve(address spender, uint256 value) external {
        allowance[msg.sender][spender] = value;
    }

    function transferFrom(address from, address to, uint256 value) external {
        uint256 currentAllowance = allowance[from][msg.sender];
        require(currentAllowance >= value, "allowance");
        allowance[from][msg.sender] = currentAllowance - value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }
}

contract TestTxGuardMissingTrackingFunction {
    uint16 public txType = 1;
    bool public isPublic = true;

    function setTxType(uint16 t, bool publicTx) external {
        txType = t;
        isPublic = publicTx;
    }

    function txGuard(
        address,
        address,
        bytes calldata
    ) external view returns (uint16, bool) {
        return (txType, isPublic);
    }
}

contract TestTxGuardShortTrackingReturn {
    uint16 public txType = 1;
    bool public isPublic = true;

    function txGuard(
        address,
        address,
        bytes calldata
    ) external view returns (uint16, bool) {
        return (txType, isPublic);
    }

    function isTxTrackingGuard() external pure {
        assembly {
            mstore(0, 1)
            return(31, 1)
        }
    }
}
