// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-periphery/contracts/libraries/OracleLibrary.sol";

import "../interfaces/IAggregatorV3Interface.sol";
import "../interfaces/IERC20Extended.sol";

/// @title Frgmnt Finance — Uniswap V3 TWAP USD Price Aggregator
/// @notice Returns the USD price of `mainToken` using:
///         1) Uniswap V3 TWAP quote: mainToken -> pairToken
///         2) A Chainlink-style USD feed for `pairToken` (pairToken/USD)
/// @dev Implements Chainlink AggregatorV3Interface `latestRoundData()`.
///      Output decimals are fixed to 8 to match common Chainlink consumers.
contract UniV3TWAPAggregator is IAggregatorV3Interface {
  /// @notice Uniswap V3 pool used for TWAP.
  IUniswapV3Pool public immutable pool;

  /// @notice Token priced by this oracle.
  address public immutable mainToken;

  /// @notice The other token in the pool used for quoting.
  address public immutable pairToken;

  /// @notice USD feed for `pairToken` (e.g., WETH/USD).
  IAggregatorV3Interface public immutable pairTokenUsdAggregator;

  /// @notice Cached decimals of the USD feed (read from the aggregator).
  uint8 public immutable pairUsdDecimals;

  /// @notice 1 unit of mainToken in smallest units.
  uint256 public immutable mainTokenUnit;

  /// @notice 1 unit of pairToken in smallest units.
  uint256 public immutable pairTokenUnit;

  /// @notice Optional lower bound for `answer` (8 decimals). Set to 0 to disable.
  int256 public immutable priceLowerLimit;

  /// @notice Optional upper bound for `answer` (8 decimals). Set to 0 to disable.
  int256 public immutable priceUpperLimit;

  /// @notice TWAP lookback window in seconds.
  uint32 public immutable updateInterval;

  /// @param _pool Uniswap V3 pool address
  /// @param _mainToken Token to price in USD
  /// @param _pairTokenUsdAggregator USD feed for the pair token
  /// @param _priceLowerLimit Optional min price bound (8 decimals), or 0 to disable
  /// @param _priceUpperLimit Optional max price bound (8 decimals), or 0 to disable
  /// @param _updateInterval TWAP lookback (seconds). Must be > 0
  constructor(
    IUniswapV3Pool _pool,
    address _mainToken,
    IAggregatorV3Interface _pairTokenUsdAggregator,
    int256 _priceLowerLimit,
    int256 _priceUpperLimit,
    uint32 _updateInterval
  ) {
    require(address(_pool) != address(0), "pool=0");
    require(_mainToken != address(0), "mainToken=0");
    require(address(_pairTokenUsdAggregator) != address(0), "agg=0");
    require(_updateInterval > 0, "interval=0");
    require(
    (_priceLowerLimit == 0 && _priceUpperLimit == 0) ||
    (_priceLowerLimit > 0 && _priceUpperLimit > 0 && _priceLowerLimit < _priceUpperLimit),
    "invalid price limit");
    pool = _pool;
    mainToken = _mainToken;
    pairTokenUsdAggregator = _pairTokenUsdAggregator;

    priceLowerLimit = _priceLowerLimit;
    priceUpperLimit = _priceUpperLimit;
    updateInterval = _updateInterval;

    // ---- Verify mainToken is actually one of the pool tokens ----
    address t0 = _pool.token0();
    address t1 = _pool.token1();
    require(_mainToken == t0 || _mainToken == t1, "mainToken not in pool");

    // Select the opposite token as pairToken.
    address _pairToken = (_mainToken == t0) ? t1 : t0;
    pairToken = _pairToken;

    // ---- Cache token units safely (avoid 10 ** decimals overflow) ----
    uint8 mainDec = IERC20Extended(_mainToken).decimals();
    require(mainDec <= 77, "main decimals too large");
    mainTokenUnit = 10 ** mainDec;

    uint8 pairDec = IERC20Extended(_pairToken).decimals();
    require(pairDec <= 77, "pair decimals too large");
    pairTokenUnit = 10 ** pairDec;

    // ---- Read and cache the USD feed decimals (NOT fixed) ----
    pairUsdDecimals = _pairTokenUsdAggregator.decimals();
    // Safety: absurdly large decimals can break scaling. 0..18 is typical; allow up to 36.
    require(pairUsdDecimals <= 36, "feed decimals too large");
  }

  /* ========== CHAINLINK-LIKE METADATA ========== */

  /// @notice This oracle outputs USD prices with 8 decimals.
  function decimals() external pure override returns (uint8) {
    return 8;
  }

  /// @notice Chainlink-style latest round data.
  /// @dev We return `updatedAt` from the pair USD feed; round ids are set to 0.
  function latestRoundData()
    external
    view
    override
    returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
  {
    // 1) Uniswap TWAP tick
    (int24 tick, ) = OracleLibrary.consult(address(pool), updateInterval);
    require(mainTokenUnit <= uint256(type(uint128).max), "mainTokenUnit overflow");

    // 2) Quote 1 mainToken into pairToken amount (in smallest units)
    uint256 quoteAmount = OracleLibrary.getQuoteAtTick(
      tick,
      uint128(mainTokenUnit),
      mainToken,
      pairToken
    );
    require(quoteAmount > 0, "zero quote");

    // Safety: prevent int256 cast overflow below
    require(quoteAmount <= uint256(type(int256).max), "quote overflow");

    // 3) Pair token USD price from feed
    int256 pairUsdPrice;
    (, pairUsdPrice, , updatedAt, ) = pairTokenUsdAggregator.latestRoundData();
    require(pairUsdPrice > 0, "bad pair price");
    require(updatedAt != 0, "stale feed");
    require(pairTokenUnit <=  uint256(type(int256).max), "pairTokenUnit overflow");

    // 4) Convert to USD(main):
    //    raw = pairUsdPrice (10^pairUsdDecimals) * quoteAmount / pairTokenUnit
    //    then rescale to 8 decimals output.
    int256 raw = (pairUsdPrice * int256(quoteAmount)) / int256(pairTokenUnit);

    if (pairUsdDecimals > 8) {
      answer = raw / int256(10 ** uint256(pairUsdDecimals - 8));
    } else if (pairUsdDecimals < 8) {
      answer = raw * int256(10 ** uint256(8 - pairUsdDecimals));
    } else {
      answer = raw;
    }

    // 5) Optional bounds (still expressed in 8 decimals)
    require(priceLowerLimit == 0 || answer >= priceLowerLimit, "answer below lower limit");
    require(priceUpperLimit == 0 || answer <= priceUpperLimit, "answer above upper limit");

    return (0, answer, 0, updatedAt, 0);
  }
}
