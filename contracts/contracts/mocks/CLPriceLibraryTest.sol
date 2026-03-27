// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../utils/CLPriceLibrary.sol";

/// @notice Wrapper exposing internal CLPriceLibrary functions for testing.
contract CLPriceLibraryTest {
    function testCalculateSqrt(
        uint256 p0,
        uint256 p1,
        uint8 d0,
        uint8 d1
    ) external pure returns (uint160) {
        return CLPriceLibrary.calculateSqrtPrice(p0, p1, d0, d1);
    }

    function testFairPrice(
        address assetInfo,
        address token0,
        address token1
    ) external view returns (uint160) {
        return CLPriceLibrary.getFairSqrtPriceX96(assetInfo, token0, token1);
    }

    function testDeviation(
        uint24 fee,
        uint160 currentPrice,
        uint160 fairPrice
    ) external pure returns (bool) {
        return CLPriceLibrary.isSqrtPriceDeviationInRange(fee, currentPrice, fairPrice);
    }
}
