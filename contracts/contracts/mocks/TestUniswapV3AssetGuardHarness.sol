// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { INonfungiblePositionManager } from "@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol";
import { UniswapV3AssetGuard } from "../guards/assetGuards/UniswapV3AssetGuard.sol";

contract TestUniswapV3AssetGuardHarness is UniswapV3AssetGuard {
    function exposedAssetValue(
        address factory,
        address token,
        uint256 amount
    ) external view returns (uint256) {
        return _assetValue(factory, token, amount);
    }

    function exposedGetV3Pool(
        address uniswapFactory,
        address token0,
        address token1,
        uint24 fee
    ) external view returns (address) {
        return _getV3Pool(uniswapFactory, token0, token1, fee);
    }

    function exposedCalcLiquidityPortion(
        uint128 liquidity,
        uint256 portion
    ) external pure returns (uint128) {
        return _calcLiquidityPortion(liquidity, portion);
    }

    function exposedCheckSpotPriceDeviation(
        uint160 spotSqrtPriceX96,
        uint160 twapSqrtPriceX96
    ) external view returns (bool) {
        return _checkSpotPriceDeviation(spotSqrtPriceX96, twapSqrtPriceX96);
    }

    function exposedPositionFees(
        INonfungiblePositionManager nonfungiblePositionManager,
        uint256 tokenId
    ) external view returns (uint256 fee0, uint256 fee1) {
        return _positionFees(nonfungiblePositionManager, tokenId);
    }

    function exposedCalcDecreaseLiquidity(
        INonfungiblePositionManager nonfungiblePositionManager,
        uint256 tokenId,
        uint256 portion
    )
        external
        view
        returns (
            uint128 lpAmount,
            uint256 amount0,
            uint256 amount1,
            uint256 principal0,
            uint256 principal1
        )
    {
        DecreaseLiquidity memory dec = _calcDecreaseLiquidity(
            nonfungiblePositionManager,
            tokenId,
            portion
        );
        return (dec.lpAmount, dec.amount0, dec.amount1, dec.principal0, dec.principal1);
    }
}
