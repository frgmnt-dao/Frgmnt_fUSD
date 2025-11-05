pragma solidity ^0.8.24;

import "../interfaces/IAggregatorV3Interface.sol";
import "../interfaces/uniswapV2/IUniswapV2Pair.sol";
import "../interfaces/IERC20Extended.sol"; // includes decimals()
import "../interfaces/IHasAssetInfo.sol";
import "../utils/FrgmntMath.sol";

/**
 * @title Frgmnt Uniswap V2 LP Aggregator
 * @notice Chainlink-compatible oracle that returns the USD price of a Uniswap V2 LP token.
 * @dev    Output is 8 decimals to match Chainlink conventions.
 *         Pricing follows the common formula used by Kashi / Homora oracles:
 *           priceLP ≈ 2 * sqrt(reserve0 * reserve1) * sqrt(price0 * price1) / totalSupply
 *         where reserves are normalized to 1e18 and token prices are 1e18 USD.
 * @custom:project Frgmnt
 */
contract UniV2LPAggregator is IAggregatorV3Interface {
  /// @notice LP pair address.
  address public pair;
  /// @notice Underlying tokens.
  address public token0;
  address public token1;
  /// @notice Registry providing USD prices for underlying tokens.
  address public factory;

  constructor(address _pair, address _factory) {
    require(_pair != address(0), "Frgmnt: pair=0");
    require(_factory != address(0), "Frgmnt: factory=0");
    pair = _pair;
    token0 = IUniswapV2Pair(pair).token0();
    token1 = IUniswapV2Pair(pair).token1();
    factory = _factory;
  }

  /* ─────────────────────────────── Views ─────────────────────────────── */

  /// @inheritdoc IAggregatorV3Interface
  function decimals() external pure override returns (uint8) {
    return 8;
  }

  /**
   * @inheritdoc IAggregatorV3Interface
   * @dev Steps:
   *  1) Fetch token USD prices from the asset registry (1e18).
   *  2) Read reserves & totalSupply from the LP.
   *  3) Normalize reserves to 1e18 using each token's decimals.
   *  4) priceLP(1e8) = 2 * sqrt(r0 * r1) * sqrt(p0 * p1) / totalSupply / 1e10.
   *     (the final /1e10 converts 1e18 → 1e8).
   *  Returns Chainlink-compatible tuple; we set `updatedAt` to block.timestamp.
   */
  function latestRoundData()
    external
    view
    override
    returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80)
  {
    (uint256 p0, uint256 p1) = _getTokenPrices(); // both 1e18

    uint256 totalSupply = IUniswapV2Pair(pair).totalSupply();
    (uint256 r0, uint256 r1, ) = IUniswapV2Pair(pair).getReserves();

    uint256 d0 = IERC20Extended(token0).decimals();
    uint256 d1 = IERC20Extended(token1).decimals();

    // Normalize reserves to 1e18
    r0 = (r0 * 1e18) / (10 ** d0); // 1e18
    r1 = (r1 * 1e18) / (10 ** d1); // 1e18

    // Geometric means (both 1e18)
    uint256 r = DhedgeMath.sqrt(r0 * r1);      // 1e18
    uint256 p = DhedgeMath.sqrt(p0 * p1);      // 1e18

    // LP price:  (r * p * 2 / totalSupply) scaled from 1e18 → 1e8
    uint256 lpPrice1e18 = (r * p * 2) / totalSupply; // 1e18
    uint256 lpPrice1e8  = lpPrice1e18 / 1e10;        // 1e8

    updatedAt = block.timestamp;
    return (0, int256(lpPrice1e8), 0, updatedAt, 0);
  }

  /* ───────────────────────────── Internals ───────────────────────────── */

  function _getTokenPrices() internal view returns (uint256, uint256) {
    // Expect registry to return prices scaled to 1e18 USD.
    return (
      IHasAssetInfo(factory).getAssetPrice(token0),
      IHasAssetInfo(factory).getAssetPrice(token1)
    );
  }
}
