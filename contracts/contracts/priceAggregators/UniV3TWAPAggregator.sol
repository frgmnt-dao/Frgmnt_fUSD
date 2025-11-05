pragma solidity ^0.8.24;

import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-periphery/contracts/libraries/OracleLibrary.sol";

import "../interfaces/IAggregatorV3Interface.sol";
import "../interfaces/IERC20Extended.sol";

/**
 * @title Frgmnt Uniswap V3 TWAP USD Aggregator
 * @notice Chainlink-compatible USD oracle that prices `mainToken` via a Uniswap V3 pool TWAP,
 *         then converts to USD using a Chainlink USD feed for the paired token.
 * @dev    - Output decimals: 8 (Chainlink-style)
 *         - `latestRoundData()` mirrors Chainlink’s interface
 *         - Enforces optional lower/upper price bounds (8 decimals)
 * @custom:project Frgmnt
 */
contract UniV3TWAPAggregator is IAggregatorV3Interface {
  IUniswapV3Pool public immutable pool;

  /// @notice Token being priced (e.g., an ERC20 like DHT).
  address public immutable mainToken;

  /// @notice The other token in the UniV3 pool (WETH/USDC/etc.).
  address public immutable pairToken;

  /// @notice Chainlink USD aggregator for `pairToken` (e.g., ETH/USD).
  IAggregatorV3Interface public immutable pairTokenUsdAggregator;

  /// @notice 1 unit of each token in raw units (10**decimals).
  uint256 public immutable mainTokenUnit;
  uint256 public immutable pairTokenUnit;

  /// @notice Optional price guardrails (8 decimals). Set 0 to disable a bound.
  int256 public immutable priceLowerLimit;
  int256 public immutable priceUpperLimit;

  /// @notice TWAP window (seconds) used in `OracleLibrary.consult`.
  uint32 public immutable updateInterval;

  /**
   * @param _pool                    Uniswap V3 pool for (mainToken, pairToken)
   * @param _mainToken               Token being priced
   * @param _pairTokenUsdAggregator  Chainlink USD feed for `pairToken` (8 decimals expected)
   * @param _priceLowerLimit         Min allowed USD price (8dp); 0 = no lower bound
   * @param _priceUpperLimit         Max allowed USD price (8dp); 0 = no upper bound
   * @param _updateInterval          TWAP window (seconds)
   */
  constructor(
    IUniswapV3Pool _pool,
    address _mainToken,
    IAggregatorV3Interface _pairTokenUsdAggregator,
    int256 _priceLowerLimit,
    int256 _priceUpperLimit,
    uint32 _updateInterval
  ) {
    require(_priceLowerLimit < _priceUpperLimit, "invalid price limit");

    pool = _pool;
    pairTokenUsdAggregator = _pairTokenUsdAggregator;
    priceLowerLimit = _priceLowerLimit;
    priceUpperLimit = _priceUpperLimit;
    updateInterval = _updateInterval;

    mainToken = _mainToken;
    mainTokenUnit = 10 ** IERC20Extended(_mainToken).decimals();

    // Determine the paired token from the pool
    address _pairToken = _pool.token0();
    if (_mainToken == _pairToken) {
      _pairToken = _pool.token1();
    }
    pairToken = _pairToken;
    pairTokenUnit = 10 ** IERC20Extended(_pairToken).decimals();
  }

  /* ========================= Views ========================= */

  /// @inheritdoc IAggregatorV3Interface
  function decimals() external pure override returns (uint8) {
    return 8;
  }

  /**
   * @inheritdoc IAggregatorV3Interface
   * @dev
   * 1) Reads the UniV3 TWAP tick over `updateInterval`.
   * 2) Converts 1 unit of `mainToken` into `pairToken` via `getQuoteAtTick`.
   * 3) Multiplies by the Chainlink USD price of `pairToken` (8dp).
   * 4) Applies optional min/max bounds.
   * Returns Chainlink-compatible tuple; `updatedAt` mirrors the pair feed’s timestamp.
   */
  function latestRoundData()
    external
    view
    override
    returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
  {
    // Step 1: Get TWAP tick for desired window
    (int24 tick, ) = OracleLibrary.consult(address(pool), updateInterval);

    // Step 2: Quote 1 mainToken (in raw units) into pairToken using the TWAP tick
    uint256 quoteAmount = OracleLibrary.getQuoteAtTick(tick, uint128(mainTokenUnit), mainToken, pairToken);

    // Step 3: Fetch pair token USD price from Chainlink (8dp)
    int256 pairUsdPrice;
    (, pairUsdPrice, , updatedAt, ) = pairTokenUsdAggregator.latestRoundData();

    // Combine: price(mainToken in USD, 8dp) = pairUsdPrice(8dp) * (quoteAmount / pairTokenUnit)
    // Keep int math to match Chainlink interface semantics
    answer = (pairUsdPrice * int256(quoteAmount)) / int256(pairTokenUnit);

    // Step 4: Optional bounds
    require(priceLowerLimit == 0 || answer >= priceLowerLimit, "answer below lower limit");
    require(priceUpperLimit == 0 || answer <= priceUpperLimit, "answer above upper limit");

    return (0, answer, 0, updatedAt, 0);
  }
}
