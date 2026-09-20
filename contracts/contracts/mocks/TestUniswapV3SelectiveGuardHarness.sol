// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    INonfungiblePositionManager
} from "@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol";
import { IPoolLogic } from "../interfaces/IPoolLogic.sol";
import { IHasGuardInfo } from "../interfaces/guards/IHasGuardInfo.sol";
import {
    UniswapV3NonfungiblePositionGuard
} from "../guards/contractGuards/uniswapV3/UniswapV3NonfungiblePositionGuard.sol";
import {
    UniswapV3SelectiveAssetGuard
} from "../guards/assetGuards/UniswapV3SelectiveAssetGuard.sol";

/// @notice Test-only: exercises the REAL UniswapV3SelectiveAssetGuard (validation + filtering) by
///         replacing only the validated base withdrawProcessing() with a synthetic plan that uses
///         the exact same calldata encoding the base uses (decreaseLiquidity then collect, params
///         struct with tokenId first). The Uniswap math itself is validated code and is not
///         re-tested here.
contract TestUniswapV3SelectiveGuardHarness is UniswapV3SelectiveAssetGuard {
    bool public injectUnexpected;

    function setInjectUnexpected(bool v) external {
        injectUnexpected = v;
    }

    function withdrawProcessing(
        address pool,
        address asset,
        uint256 portion,
        address to
    ) external view override returns (address, uint256, MultiTransaction[] memory transactions) {
        address factory = IPoolLogic(pool).factory();
        uint256[] memory ids = UniswapV3NonfungiblePositionGuard(
            IHasGuardInfo(factory).getContractGuard(asset)
        ).getOwnedTokenIds(pool);

        transactions = new MultiTransaction[](ids.length * 2 + (injectUnexpected ? 1 : 0));
        uint256 n;
        for (uint256 i; i < ids.length; ++i) {
            transactions[n].to = asset;
            transactions[n++].txData = abi.encodeWithSelector(
                INonfungiblePositionManager.decreaseLiquidity.selector,
                INonfungiblePositionManager.DecreaseLiquidityParams(
                    ids[i],
                    uint128(portion / 1e12),
                    0,
                    0,
                    block.timestamp + 1
                )
            );
            transactions[n].to = asset;
            transactions[n++].txData = abi.encodeWithSelector(
                INonfungiblePositionManager.collect.selector,
                INonfungiblePositionManager.CollectParams(
                    ids[i],
                    to,
                    type(uint128).max,
                    type(uint128).max
                )
            );
        }
        if (injectUnexpected) {
            transactions[n].to = asset;
            transactions[n++].txData = abi.encodeWithSelector(
                INonfungiblePositionManager.burn.selector,
                ids.length > 0 ? ids[0] : 0
            );
        }
        return (address(0), 0, transactions);
    }
}
