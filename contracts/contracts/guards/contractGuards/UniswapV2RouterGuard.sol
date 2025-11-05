pragma solidity ^0.8.24;

import "../../utils/TxDataUtils.sol";
import "../../interfaces/guards/IGuard.sol";
import "../../interfaces/uniswapV2/IUniswapV2Factory.sol";
import "../../interfaces/uniswapV2/IUniswapV2Router.sol";
import "../../interfaces/IPoolManagerLogic.sol";
import "../../interfaces/IHasSupportedAsset.sol";

/**
 * @title Frgmnt Uniswap V2 Router Guard
 * @notice Validates & classifies swaps and liquidity ops routed via Uniswap V2–style routers (incl. Sushi).
 * @dev Supports:
 *      - swapExactTokensForTokens
 *      - swapTokensForExactTokens
 *      - addLiquidity
 *      - removeLiquidity
 *      Emits standard Exchange/Add/Remove events used by PoolLogic analytics.
 * @custom:project Frgmnt
 */
contract UniswapV2RouterGuard is TxDataUtils, IGuard {
  struct SwapData {
    address recipient;
    address srcAsset;
    address dstAsset;
    uint256 srcAmount;
    uint256 dstAmount;
    address to;
  }

  event AddLiquidity(
    address fundAddress,
    address tokenA,
    address tokenB,
    address pair,
    uint256 amountADesired,
    uint256 amountBDesired,
    uint256 amountAMin,
    uint256 amountBMin,
    uint256 time
  );

  event RemoveLiquidity(
    address fundAddress,
    address tokenA,
    address tokenB,
    address pair,
    uint256 liquidity,
    uint256 amountAMin,
    uint256 amountBMin,
    uint256 time
  );

  /**
   * @notice Router tx guard entrypoint.
   * @param _poolManagerLogic PoolManagerLogic contract
   * @param to                Router address
   * @param data              Encoded function call
   * @return txType           2 Exchange, 3 Add Liquidity, 4 Remove Liquidity
   * @return isPublic         Always false
   */
  function txGuard(
    address _poolManagerLogic,
    address to,
    bytes calldata data
  )
    external
    override
    returns (uint16 txType, bool)
  {
    IPoolManagerLogic poolManagerLogic = IPoolManagerLogic(_poolManagerLogic);
    IHasSupportedAsset poolManagerLogicAssets = IHasSupportedAsset(_poolManagerLogic);

    bytes4 method = getMethod(data);

    if (method == bytes4(keccak256("swapExactTokensForTokens(uint256,uint256,address[],address,uint256)"))) {
      _verifyExchange(
        SwapData(
          convert32toAddress(getInput(data, 3)),                  // recipient
          convert32toAddress(getArrayIndex(data, 2, 0)),          // path[0]
          convert32toAddress(getArrayLast(data, 2)),              // path[last]
          uint256(getInput(data, 0)),                             // amountIn
          uint256(getInput(data, 1)),                             // amountOutMin
          to
        ),
        poolManagerLogicAssets,
        poolManagerLogic,
        2 // ExchangeFrom event
      );
      txType = 2;

    } else if (method == bytes4(keccak256("swapTokensForExactTokens(uint256,uint256,address[],address,uint256)"))) {
      _verifyExchange(
        SwapData(
          convert32toAddress(getInput(data, 3)),                  // recipient
          convert32toAddress(getArrayIndex(data, 2, 0)),          // path[0]
          convert32toAddress(getArrayLast(data, 2)),              // path[last]
          uint256(getInput(data, 0)),                             // amountOut (target)
          uint256(getInput(data, 1)),                             // amountInMax
          to
        ),
        poolManagerLogicAssets,
        poolManagerLogic,
        1 // ExchangeTo event
      );
      txType = 2;

    } else if (method == bytes4(keccak256("addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)"))) {
      address tokenA = convert32toAddress(getInput(data, 0));
      address tokenB = convert32toAddress(getInput(data, 1));
      uint256 amountADesired = uint256(getInput(data, 2));
      uint256 amountBDesired = uint256(getInput(data, 3));
      uint256 amountAMin     = uint256(getInput(data, 4));
      uint256 amountBMin     = uint256(getInput(data, 5));

      require(poolManagerLogicAssets.isSupportedAsset(tokenA), "Frgmnt: unsupported tokenA");
      require(poolManagerLogicAssets.isSupportedAsset(tokenB), "Frgmnt: unsupported tokenB");

      address pair = IUniswapV2Factory(IUniswapV2Router(to).factory()).getPair(tokenA, tokenB);
      require(poolManagerLogicAssets.isSupportedAsset(pair), "Frgmnt: unsupported LP");

      require(poolManagerLogic.poolLogic() == convert32toAddress(getInput(data, 6)), "Frgmnt: recipient != pool");

      emit AddLiquidity(
        poolManagerLogic.poolLogic(),
        tokenA,
        tokenB,
        pair,
        amountADesired,
        amountBDesired,
        amountAMin,
        amountBMin,
        block.timestamp
      );
      txType = 3;

    } else if (method == bytes4(keccak256("removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)"))) {
      address tokenA = convert32toAddress(getInput(data, 0));
      address tokenB = convert32toAddress(getInput(data, 1));
      uint256 liquidity  = uint256(getInput(data, 2));
      uint256 amountAMin = uint256(getInput(data, 3));
      uint256 amountBMin = uint256(getInput(data, 4));

      require(poolManagerLogicAssets.isSupportedAsset(tokenA), "Frgmnt: unsupported tokenA");
      require(poolManagerLogicAssets.isSupportedAsset(tokenB), "Frgmnt: unsupported tokenB");

      address pair = IUniswapV2Factory(IUniswapV2Router(to).factory()).getPair(tokenA, tokenB);
      require(poolManagerLogicAssets.isSupportedAsset(pair), "Frgmnt: unsupported LP");

      require(poolManagerLogic.poolLogic() == convert32toAddress(getInput(data, 5)), "Frgmnt: recipient != pool");

      emit RemoveLiquidity(
        poolManagerLogic.poolLogic(),
        tokenA,
        tokenB,
        pair,
        liquidity,
        amountAMin,
        amountBMin,
        block.timestamp
      );
      txType = 4;
    }

    // Final authorization: only the poolLogic may invoke guarded router txs.
    require(poolManagerLogic.poolLogic() == msg.sender, "Frgmnt: caller not poolLogic");

    return (txType, false);
  }

  /**
   * @dev Verifies swap arguments and emits the corresponding Exchange event.
   * @param swapData        Struct of parsed swap parameters
   * @param poolAssets      Supported-assets registry
   * @param poolManager     Pool manager (to fetch poolLogic)
   * @param exchangeType    1 = ExchangeTo (amountOut-targeted) | 2 = ExchangeFrom (amountIn-fixed)
   */
  function _verifyExchange(
    SwapData memory swapData,
    IHasSupportedAsset poolAssets,
    IPoolManagerLogic poolManager,
    uint8 exchangeType
  ) internal {
    address poolLogic = poolManager.poolLogic();

    require(poolAssets.isSupportedAsset(swapData.dstAsset), "Frgmnt: unsupported dst asset");
    require(poolLogic == swapData.recipient, "Frgmnt: recipient != pool");

    if (exchangeType == 1) {
      emit ExchangeTo(poolLogic, swapData.srcAsset, swapData.dstAsset, swapData.dstAmount, block.timestamp);
    } else if (exchangeType == 2) {
      emit ExchangeFrom(poolLogic, swapData.srcAsset, swapData.srcAmount, swapData.dstAsset, block.timestamp);
    }
  }
}
