# UniV3TWAPAggregator

**Source:** `contracts/contracts/priceAggregators/UniV3TWAPAggregator.sol`
**Kind:** Chainlink-compatible price feed, backed by a Uniswap V3 TWAP

---

## Overview

Prices `mainToken` in USD by composing two legs: (1) a Uniswap V3 time-weighted-average quote from `mainToken` into `pairToken`, and (2) a genuine Chainlink-style USD feed for `pairToken`. Used for assets that have deep Uniswap V3 liquidity against a well-priced pair token (typically WETH) but no direct USD feed of their own. Implements `IAggregatorV3Interface`, output fixed at 8 decimals regardless of the underlying feed's own decimals (rescaled in `latestRoundData()`).

---

## Functions

### Constructor

```solidity
constructor(IUniswapV3Pool _pool, address _mainToken, IAggregatorV3Interface _pairTokenUsdAggregator, int256 _priceLowerLimit, int256 _priceUpperLimit, uint32 _updateInterval, uint128 _minimumLiquidity)
```

Validates every address argument is non-zero, that `_mainToken` is actually one of the pool's two tokens (the other becomes `pairToken` automatically), that `_updateInterval > 0`, and that the optional price bounds are either both disabled (`0`) or a valid, correctly-ordered pair. Caches both tokens' decimals (capped at 77, to keep `10**decimals` from overflowing) and the pair feed's own decimals (capped at 36) as immutables, so `latestRoundData()` never needs an external decimals lookup at read time.

### `latestRoundData` (CertiK FNA-16)

```solidity
function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
```

1. Calls `OracleLibrary.consult(pool, updateInterval)`, which returns both the TWAP tick **and** the pool's harmonic-mean liquidity over that same lookback window.
2. **Reverts** if that liquidity is below `minimumLiquidity` (`"liquidity too low"`) — see the field's own doc below for why this matters.
3. Converts the tick into a `pairToken`-denominated quote for one whole unit of `mainToken` via `OracleLibrary.getQuoteAtTick`.
4. Reads the pair token's own USD price from `pairTokenUsdAggregator.latestRoundData()`, requiring a positive price and a non-zero `updatedAt` (rejects a feed reporting a stale/uninitialized round).
5. Combines both legs and rescales from the pair feed's native decimals to this aggregator's fixed 8-decimal output.
6. Applies the optional `priceLowerLimit`/`priceUpperLimit` sanity bounds if configured, reverting outside that range.

`updatedAt` in the returned tuple is passed through from the pair feed's own `updatedAt` — so a stale pair feed is visible to any downstream staleness check exactly as it would be for a direct feed lookup.

---

## `minimumLiquidity` (CertiK FNA-16)

`OracleLibrary.consult()` always returned the pool's harmonic-mean liquidity over the window, but it was previously discarded — this aggregator kept accepting TWAP observations even after the pool's active liquidity fell far below what was assumed safe at deployment. In a sufficiently thin pool, an attacker can move and sustain an adverse tick over `updateInterval` at reduced cost, since less capital is needed to move price when liquidity is low. Reverting below this pool-specific floor makes that materially more expensive rather than silently pricing off a manipulable observation. Set to `0` to disable (not recommended) — this is a per-deployment, per-pool judgment call made at construction time, not something this contract can determine on its own.

---

## Configuration Parameters

| Parameter | Set at | Description |
|-----------|--------|-------------|
| `pool` | constructor (immutable) | The Uniswap V3 pool consulted for the TWAP |
| `mainToken` / `pairToken` | constructor (immutable) | The priced token and its TWAP counterpart (auto-derived from the pool) |
| `pairTokenUsdAggregator` | constructor (immutable) | Chainlink-style USD feed for `pairToken` |
| `updateInterval` | constructor (immutable) | TWAP lookback window in seconds |
| `minimumLiquidity` | constructor (immutable) | CertiK FNA-16 harmonic-mean liquidity floor — see above |
| `priceLowerLimit` / `priceUpperLimit` | constructor (immutable) | Optional sanity bounds on the final 8-decimal answer, `0` to disable both |

No owner-settable parameters — every configuration value is fixed at deploy time; changing any of them requires deploying a new aggregator instance and re-registering it in `AssetHandler`.

---

## Related

- [AssetHandler](AssetHandler.md) — registers this feed against `mainToken`
- [SlippageAccumulator](SlippageAccumulator.md) — a downstream consumer of on-chain USD pricing during router-guarded swaps, same manipulation-resistance concern class as this aggregator's own `minimumLiquidity` floor
