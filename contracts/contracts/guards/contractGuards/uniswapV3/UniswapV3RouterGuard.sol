// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Path } from "@uniswap/v3-periphery/contracts/libraries/Path.sol";

import { IPoolManagerLogic } from "../../../interfaces/IPoolManagerLogic.sol";
import { IHasSupportedAsset } from "../../../interfaces/IHasSupportedAsset.sol";
import { ITransactionTypes } from "../../../interfaces/ITransactionTypes.sol";
import { IV3SwapRouter } from "../../../interfaces/IV3SwapRouter.sol";
import { SlippageAccumulator } from "../../../utils/SlippageAccumulator.sol";
import { SlippageAccumulatorUser } from "../../../utils/SlippageAccumulatorUser.sol";
import { TxDataUtils } from "../../../utils/TxDataUtils.sol";

/**
 * @title Frgmnt Uniswap V3 Router Guard
 * @notice Validates and classifies swaps executed via Uniswap V3 SwapRouter.
 * @dev Supports: exactInput, exactInputSingle, exactOutput, exactOutputSingle, and multicall (single swap only).
 *      Tracks pre/post balances for slippage accounting via SlippageAccumulatorUser.
 * @custom:project Frgmnt
 */
contract UniswapV3RouterGuard is TxDataUtils, ITransactionTypes, SlippageAccumulatorUser {
    using Path for bytes;

    /// @notice Emitted for exact-input style swaps where the input amount is known.
    event ExchangeFrom(
        address indexed poolLogic,
        address indexed srcAsset,
        uint256 amountIn,
        address indexed dstAsset,
        uint256 time
    );

    /// @notice Emitted for exact-output style swaps where the output amount is known.
    event ExchangeTo(
        address indexed poolLogic,
        address indexed srcAsset,
        address indexed dstAsset,
        uint256 amountOut,
        uint256 time
    );

    constructor(address _slippageAccumulator) SlippageAccumulatorUser(_slippageAccumulator) {}

    /**
     * @notice Transaction guard for Uniswap V3 Swap Router.
     * @dev FNA-47: `intermediateSwapData` writes below are keyed by `msg.sender` (== `poolLogic`,
     *      per the require immediately above) rather than a single shared slot — see
     *      SlippageAccumulatorUser's own docs for why this closes the cross-caller
     *      snapshot-replacement/underflow-DoS exposure without needing a trusted pool registry.
     * @param poolManagerLogic Pool manager logic address
     * @param to               Swap router address
     * @param data             Encoded function call
     * @return txType          Transaction type described in PoolLogic
     * @return isPublic        Always false for swaps
     */
    function txGuard(
        address poolManagerLogic,
        address to,
        bytes memory data
    ) public override returns (uint16 txType, bool) {
        address poolLogic = IPoolManagerLogic(poolManagerLogic).poolLogic();
        require(msg.sender == poolLogic, "Frgmnt: not pool logic");

        bytes4 method = getMethod(data);
        IHasSupportedAsset poolManagerLogicAssets = IHasSupportedAsset(poolManagerLogic);

        if (method == IV3SwapRouter.exactInput.selector) {
            IV3SwapRouter.ExactInputParams memory params = abi.decode(
                getParams(data),
                (IV3SwapRouter.ExactInputParams)
            );

            (address srcAsset, address dstAsset) = _decodePath(params.path);

            require(
                poolManagerLogicAssets.isSupportedAsset(dstAsset),
                "Frgmnt: unsupported destination asset"
            );
            require(poolLogic == params.recipient, "Frgmnt: recipient is not pool");

            intermediateSwapData[msg.sender] = SlippageAccumulator.SwapData({
                srcAsset: srcAsset,
                dstAsset: dstAsset,
                srcAmount: _getBalance(srcAsset, poolLogic),
                dstAmount: _getBalance(dstAsset, poolLogic)
            });

            emit ExchangeFrom(poolLogic, srcAsset, params.amountIn, dstAsset, block.timestamp);
            txType = uint16(TransactionType.Exchange);
        } else if (method == IV3SwapRouter.exactInputSingle.selector) {
            IV3SwapRouter.ExactInputSingleParams memory params = abi.decode(
                getParams(data),
                (IV3SwapRouter.ExactInputSingleParams)
            );

            require(
                poolManagerLogicAssets.isSupportedAsset(params.tokenOut),
                "Frgmnt: unsupported destination asset"
            );
            require(poolLogic == params.recipient, "Frgmnt: recipient is not pool");

            intermediateSwapData[msg.sender] = SlippageAccumulator.SwapData({
                srcAsset: params.tokenIn,
                dstAsset: params.tokenOut,
                srcAmount: _getBalance(params.tokenIn, poolLogic),
                dstAmount: _getBalance(params.tokenOut, poolLogic)
            });

            emit ExchangeFrom(
                poolLogic,
                params.tokenIn,
                params.amountIn,
                params.tokenOut,
                block.timestamp
            );
            txType = uint16(TransactionType.Exchange);
        } else if (method == IV3SwapRouter.exactOutput.selector) {
            IV3SwapRouter.ExactOutputParams memory params = abi.decode(
                getParams(data),
                (IV3SwapRouter.ExactOutputParams)
            );

            (address dstAsset, address srcAsset) = _decodePath(params.path);

            require(
                poolManagerLogicAssets.isSupportedAsset(dstAsset),
                "Frgmnt: unsupported destination asset"
            );
            require(poolLogic == params.recipient, "Frgmnt: recipient is not pool");

            intermediateSwapData[msg.sender] = SlippageAccumulator.SwapData({
                srcAsset: srcAsset,
                dstAsset: dstAsset,
                srcAmount: _getBalance(srcAsset, poolLogic),
                dstAmount: _getBalance(dstAsset, poolLogic)
            });

            emit ExchangeTo(poolLogic, srcAsset, dstAsset, params.amountOut, block.timestamp);
            txType = uint16(TransactionType.Exchange);
        } else if (method == IV3SwapRouter.exactOutputSingle.selector) {
            IV3SwapRouter.ExactOutputSingleParams memory params = abi.decode(
                getParams(data),
                (IV3SwapRouter.ExactOutputSingleParams)
            );

            require(
                poolManagerLogicAssets.isSupportedAsset(params.tokenOut),
                "Frgmnt: unsupported destination asset"
            );
            require(poolLogic == params.recipient, "Frgmnt: recipient is not pool");

            intermediateSwapData[msg.sender] = SlippageAccumulator.SwapData({
                srcAsset: params.tokenIn,
                dstAsset: params.tokenOut,
                srcAmount: _getBalance(params.tokenIn, poolLogic),
                dstAmount: _getBalance(params.tokenOut, poolLogic)
            });

            emit ExchangeTo(
                poolLogic,
                params.tokenIn,
                params.tokenOut,
                params.amountOut,
                block.timestamp
            );
            txType = uint16(TransactionType.Exchange);
        } else if (method == bytes4(keccak256("multicall(uint256,bytes[])"))) {
            // There are multiple multicall overloads; match via signature string.
            (, bytes[] memory transactions) = abi.decode(getParams(data), (uint256, bytes[]));

            // Allow exactly one swap inside multicall so slippage can be computed reliably.
            require(transactions.length == 1, "Frgmnt: invalid multicall");

            for (uint256 i = 0; i < transactions.length; ++i) {
                (txType, ) = txGuard(poolManagerLogic, to, transactions[i]);
                require(txType > 0, "Frgmnt: invalid transaction");
            }

            txType = uint16(TransactionType.UniswapV3Multicall);
        }

        return (txType, false);
    }

    /// @dev Decodes a UniswapV3 path to the first (src) and final (dst) assets.
    function _decodePath(
        bytes memory path
    ) internal pure returns (address srcAsset, address dstAsset) {
        (srcAsset, , ) = path.decodeFirstPool();

        address asset;

        // Walk the path to find the final token
        while (path.hasMultiplePools()) {
            path = path.skipToken();
            (asset, , ) = path.decodeFirstPool();
        }

        // Destination is the token of the last pool in the path
        (, dstAsset, ) = path.decodeFirstPool();

        if (dstAsset == address(0)) {
            // If residual bytes are zeros, use asset captured from the last hop
            dstAsset = asset;
        }
    }
}
