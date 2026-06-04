// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { CLPriceLibrary } from "../utils/CLPriceLibrary.sol";
import { FundCalculationLibrary } from "../utils/FundCalculationLibrary.sol";
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
}

contract TestTxDataUtils is TxDataUtils {
    function exposedSliceUint(bytes memory data, uint256 start) external pure returns (uint256) {
        return sliceUint(data, start);
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
