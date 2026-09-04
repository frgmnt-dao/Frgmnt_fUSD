# USDPriceAggregator

**Source:** `contracts/contracts/priceAggregators/USDPriceAggregator.sol`
**Kind:** Chainlink-compatible price feed stub

---

## Overview

A fixed-price oracle for assets that are USD-denominated by construction — most notably fUSD itself and any other asset the protocol treats as a $1.00 peg for valuation purposes. Implements `IAggregatorV3Interface` so it slots directly into `AssetHandler`'s existing feed lookup, exactly like a real Chainlink feed would.

---

## Functions

### `decimals`

```solidity
function decimals() external pure returns (uint8)
```

Always returns `8`, matching the standard Chainlink USD-feed convention.

### `latestRoundData`

```solidity
function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
```

Always returns `answer = 1e8` ($1.00 at 8 decimals) with `updatedAt = block.timestamp` — the feed is never stale by construction, since it has no external data source to go stale against. `roundId`/`startedAt`/`answeredInRound` are all `0`; no caller in this codebase relies on those fields for a fixed-price feed.

---

## Configuration

None — the contract is fully stateless with no constructor arguments.

---

## Related

- [AssetHandler](AssetHandler.md) — registers this feed against the asset(s) it prices
