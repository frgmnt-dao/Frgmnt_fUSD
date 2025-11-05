pragma solidity ^0.8.24;

import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol";
import "@uniswap/v3-periphery/contracts/libraries/OracleLibrary.sol";
import "@uniswap/v3-periphery/contracts/libraries/PositionValue.sol";
import "@uniswap/v3-periphery/contracts/libraries/LiquidityAmounts.sol";
import "@uniswap/v3-core/contracts/libraries/TickMath.sol";

import "./ERC20Guard.sol";
import "../../interfaces/IHasAssetInfo.sol";
import "../../interfaces/IPoolLogic.sol";
import "../../interfaces/IERC20Extended.sol";
import "../contractGuards/uniswapV3/UniswapV3NonfungiblePositionGuard.sol";
import "../../utils/uniswap/UniswapV3PriceLibrary.sol";

/**
 * @title Frgmnt Uniswap V3 Asset Guard
 * @notice Values and withdraws Uniswap V3 LP NFT positions held by a pool.
 * @dev Asset type = 7
 *      - Aggregates USD value of all owned Uniswap V3 NFT positions (token0 + token1).
 *      - For withdrawals, proportionally decreases liquidity and collects fees/principals to the recipient.
 *      - Skips NFTs whose underlying tokens are not valid assets in the factory.
 * @custom:project Frgmnt
 */
contract UniswapV3AssetGuard is ERC20Guard {
  using PositionValue for INonfungiblePositionManager;

  struct UniV3PoolParams {
    address token0;
    address token1;
    uint24 fee;
    uint160 sqrtPriceX96;
  }

  /**
   * @notice Returns the pool’s total Uniswap V3 position value in USD.
   * @dev For each owned NFT:
   *      - Validates underlying tokens against the factory’s asset list.
   *      - Pulls a fair TWAP price via UniswapV3PriceLibrary.
   *      - Computes amounts and values of token0 and token1 and sums them.
   * @param pool PoolLogic address
   * @param asset The Uniswap V3 NonfungiblePositionManager (NFT manager) address
   */
  function getBalance(address pool, address asset) public view override returns (uint256 balance) {
    address factory = IPoolLogic(pool).factory();
    INonfungiblePositionManager nonfungiblePositionManager = INonfungiblePositionManager(asset);

    UniswapV3NonfungiblePositionGuard guard = UniswapV3NonfungiblePositionGuard(
      IHasGuardInfo(factory).getContractGuard(asset)
    );

    uint256[] memory tokenIds = guard.getOwnedTokenIds(pool);
    for (uint256 i = 0; i < tokenIds.length; ++i) {
      uint256 tokenId = tokenIds[i];

      UniV3PoolParams memory params;
      (, , params.token0, params.token1, params.fee, , , , , , , ) = nonfungiblePositionManager.positions(tokenId);

      // Skip NFTs where either underlying token is not supported by the factory
      if (
        !IHasAssetInfo(factory).isValidAsset(params.token0) ||
        !IHasAssetInfo(factory).isValidAsset(params.token1)
      ) {
        continue;
      }

      // Load conservative fair price (TWAP) for the pool
      params.sqrtPriceX96 = UniswapV3PriceLibrary.assertFairPrice(
        factory,
        nonfungiblePositionManager.factory(),
        params.token0,
        params.token1,
        params.fee
      );

      // Total amounts for this NFT at current sqrtPrice
      (uint256 amount0, uint256 amount1) = nonfungiblePositionManager.total(tokenId, params.sqrtPriceX96);

      balance =
        balance +
        _assetValue(factory, params.token0, amount0) +
        _assetValue(factory, params.token1, amount1);
    }
  }

  /// @dev Helper to convert a token amount to USD using the factory price + token decimals.
  function _assetValue(address factory, address token, uint256 amount) internal view returns (uint256) {
    if (IHasAssetInfo(factory).isValidAsset(token)) {
      uint256 tokenPriceInUsd = IHasAssetInfo(factory).getAssetPrice(token);
      uint256 dec = IERC20Extended(token).decimals();
      return (tokenPriceInUsd * amount) / (10 ** dec);
    } else {
      return 0;
    }
  }

  /// @notice Synthetic valuation uses 18 decimals.
  function getDecimals(address) external pure override returns (uint256 decimals) {
    decimals = 18;
  }

  /**
   * @notice Builds transactions to withdraw a portion of all Uniswap V3 NFT positions.
   * @dev For each NFT owned by the pool:
   *      1) Decrease liquidity by `portion` of current NFT liquidity (if > 0)
   *      2) Collect fees + decreased principals directly to `to`
   * @param pool PoolLogic address
   * @param asset Uniswap V3 NonfungiblePositionManager address
   * @param portion Portion in 1e18 precision (1e18 = 100%)
   * @param to Recipient of collected tokens
   * @return withdrawAsset Always zero address for this guard (payout occurs via transactions)
   * @return withdrawBalance Always zero for this guard (payout occurs via transactions)
   * @return transactions Encoded calls to decreaseLiquidity and collect for each NFT
   */
  function withdrawProcessing(
    address pool,
    address asset,
    uint256 portion,
    address to
  )
    external
    view
    virtual
    override
    returns (address withdrawAsset, uint256 withdrawBalance, MultiTransaction[] memory transactions)
  {
    INonfungiblePositionManager nonfungiblePositionManager = INonfungiblePositionManager(asset);

    address factory = IPoolLogic(pool).factory();
    UniswapV3NonfungiblePositionGuard guard = UniswapV3NonfungiblePositionGuard(
      IHasGuardInfo(factory).getContractGuard(asset)
    );

    uint256[] memory tokenIds = guard.getOwnedTokenIds(pool);

    uint256 txCount;
    transactions = new MultiTransaction[](tokenIds.length * 2);

    for (uint256 i = 0; i < tokenIds.length; ++i) {
      DecreaseLiquidity memory dec = _calcDecreaseLiquidity(
        nonfungiblePositionManager,
        tokenIds[i],
        portion
      );

      // 1) Decrease liquidity, if any
      if (dec.lpAmount != 0) {
        transactions[txCount].to = address(nonfungiblePositionManager);
        transactions[txCount].txData = abi.encodeWithSelector(
          INonfungiblePositionManager.decreaseLiquidity.selector,
          INonfungiblePositionManager.DecreaseLiquidityParams(
            tokenIds[i],
            dec.lpAmount,
            0,
            0,
            type(uint256).max
          )
        );
        txCount++;
      }

      // 2) Collect fees + principals to `to`, if any
      if (dec.amount0 != 0 || dec.amount1 != 0) {
        transactions[txCount].to = address(nonfungiblePositionManager);
        transactions[txCount].txData = abi.encodeWithSelector(
          INonfungiblePositionManager.collect.selector,
          INonfungiblePositionManager.CollectParams(
            tokenIds[i],
            to,
            uint128(dec.amount0),
            uint128(dec.amount1)
          )
        );
        txCount++;
      }
    }

    // Shrink array to actual size
    uint256 reduceLength = (tokenIds.length * 2) - txCount;
    assembly {
      mstore(transactions, sub(mload(transactions), reduceLength))
    }

    // No direct asset/amount return — all value is realized via the transactions above
    return (withdrawAsset, withdrawBalance, transactions);
  }

  // For stack-too-deep friendliness
  struct DecreaseLiquidity {
    uint128 lpAmount;
    uint256 amount0;
    uint256 amount1;
  }

  /**
   * @notice Calculates the decreaseLiquidity share and expected amounts for an NFT.
   * @param nonfungiblePositionManager Uniswap V3 position manager
   * @param tokenId NFT position id
   * @param portion Portion in 1e18 precision
   */
  function _calcDecreaseLiquidity(
    INonfungiblePositionManager nonfungiblePositionManager,
    uint256 tokenId,
    uint256 portion
  ) internal view returns (DecreaseLiquidity memory dec) {
    IUniswapV3Factory uniswapV3Factory = IUniswapV3Factory(nonfungiblePositionManager.factory());

    (
      ,
      ,
      address token0,
      address token1,
      uint24 fee,
      int24 tickLower,
      int24 tickUpper,
      uint128 liquidity,
      ,
      ,
      ,

    ) = nonfungiblePositionManager.positions(tokenId);

    // LP portion to remove
    dec.lpAmount = uint128((uint256(liquidity) * portion) / 1e18);

    // Current pool sqrtPrice
    (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(uniswapV3Factory.getPool(token0, token1, fee)).slot0();

    // Amounts corresponding to the lp portion
    (dec.amount0, dec.amount1) = LiquidityAmounts.getAmountsForLiquidity(
      sqrtPriceX96,
      TickMath.getSqrtRatioAtTick(tickLower),
      TickMath.getSqrtRatioAtTick(tickUpper),
      dec.lpAmount
    );

    // Include proportional share of uncollected fees
    (uint256 feeAmount0, uint256 feeAmount1) = nonfungiblePositionManager.fees(tokenId);
    dec.amount0 = dec.amount0 + ((feeAmount0 * portion) / 1e18);
    dec.amount1 = dec.amount1 + ((feeAmount1 * portion) / 1e18);
  }
}
