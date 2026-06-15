// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IHasAssetInfo } from "../interfaces/IHasAssetInfo.sol";
import { IHasGuardInfo } from "../interfaces/IHasGuardInfo.sol";
import { IPoolLogic } from "../interfaces/IPoolLogic.sol";
import { IERC20Extended } from "../interfaces/IERC20Extended.sol";

import { UniswapV3NonfungiblePositionGuard } from "../guards/contractGuards/uniswapV3/UniswapV3NonfungiblePositionGuard.sol";
import "@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol";

/// @notice Test-only stub that mimics UniswapV3AssetGuard without calling Uniswap math.
contract TestUniswapV3AssetGuardStubbed {
    struct MultiTransaction {
        address to;
        bytes txData;
    }

    struct DecreaseLiquidity {
        uint128 lpAmount;
        uint256 amount0;
        uint256 amount1;
    }

    mapping(address => uint256[]) private _ownedTokenIdsOverride;
    mapping(uint256 => address) public token0Override;
    mapping(uint256 => address) public token1Override;
    mapping(uint256 => uint256) public amount0Override;
    mapping(uint256 => uint256) public amount1Override;
    mapping(uint256 => DecreaseLiquidity) public decOverride;

    function setOwnedTokenIds(address pool, uint256[] calldata ids) external {
        _ownedTokenIdsOverride[pool] = ids;
    }

    function setPositionData(
        uint256 tokenId,
        address token0,
        address token1,
        uint256 amount0,
        uint256 amount1
    ) external {
        token0Override[tokenId] = token0;
        token1Override[tokenId] = token1;
        amount0Override[tokenId] = amount0;
        amount1Override[tokenId] = amount1;
    }

    function setDecData(uint256 tokenId, uint128 lpAmount, uint256 amount0, uint256 amount1) external {
        decOverride[tokenId] = DecreaseLiquidity({ lpAmount: lpAmount, amount0: amount0, amount1: amount1 });
    }

    function getDecimals(address) external pure returns (uint256 decimals) {
        decimals = 18;
    }

    function _assetValue(address factory, address token, uint256 amount) internal view returns (uint256) {
        if (IHasAssetInfo(factory).isSupportedAsset(token)) {
            uint256 tokenPriceInUsd = IHasAssetInfo(factory).getAssetPrice(token);
            uint256 dec = IERC20Extended(token).decimals();
            return (tokenPriceInUsd * amount) / (10 ** dec);
        }
        return 0;
    }

    function getBalance(address pool, address /*asset*/) public view returns (uint256 balance) {
        address factory = IPoolLogic(pool).factory();

        uint256[] memory tokenIds = _ownedTokenIdsOverride[pool];
        for (uint256 i = 0; i < tokenIds.length; ++i) {
            uint256 tokenId = tokenIds[i];
            address token0 = token0Override[tokenId];
            address token1 = token1Override[tokenId];

            if (!IHasAssetInfo(factory).isSupportedAsset(token0) || !IHasAssetInfo(factory).isSupportedAsset(token1)) {
                continue;
            }

            balance =
                balance +
                _assetValue(factory, token0, amount0Override[tokenId]) +
                _assetValue(factory, token1, amount1Override[tokenId]);
        }
    }

    function withdrawProcessing(
        address pool,
        address asset,
        uint256 /*portion*/,
        address to
    ) external view returns (address withdrawAsset, uint256 withdrawBalance, MultiTransaction[] memory transactions) {
        INonfungiblePositionManager nfpm = INonfungiblePositionManager(asset);
        address factory = IPoolLogic(pool).factory();

        UniswapV3NonfungiblePositionGuard guard = UniswapV3NonfungiblePositionGuard(
            IHasGuardInfo(factory).getContractGuard(asset)
        );

        uint256[] memory tokenIds = guard.getOwnedTokenIds(pool);

        uint256 txCount;
        transactions = new MultiTransaction[](tokenIds.length * 2);

        for (uint256 i = 0; i < tokenIds.length; ++i) {
            uint256 tokenId = tokenIds[i];
            DecreaseLiquidity memory dec = decOverride[tokenId];

            if (dec.lpAmount != 0) {
                transactions[txCount].to = address(nfpm);
                transactions[txCount].txData = abi.encodeWithSelector(
                    INonfungiblePositionManager.decreaseLiquidity.selector,
                    INonfungiblePositionManager.DecreaseLiquidityParams(tokenId, dec.lpAmount, 0, 0, type(uint256).max)
                );
                txCount++;
            }

            if (dec.amount0 != 0 || dec.amount1 != 0) {
                transactions[txCount].to = address(nfpm);
                transactions[txCount].txData = abi.encodeWithSelector(
                    INonfungiblePositionManager.collect.selector,
                    INonfungiblePositionManager.CollectParams(tokenId, to, uint128(dec.amount0), uint128(dec.amount1))
                );
                txCount++;
            }
        }

        uint256 reduceLength = (tokenIds.length * 2) - txCount;
        assembly {
            mstore(transactions, sub(mload(transactions), reduceLength))
        }

        return (withdrawAsset, withdrawBalance, transactions);
    }
}
