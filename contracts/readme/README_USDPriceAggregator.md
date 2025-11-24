# USDPriceAggregator — README

This document provides a complete, self-contained description of the `USDPriceAggregator` contract. It is written as a single markdown file, without including the Solidity source code, and is intended to be dropped directly into your repository as `README.md` or similar documentation.

---

## 1. Overview

`USDPriceAggregator` is a **Chainlink-compatible USD price oracle stub** used in the **Frgmnt** project.

It is designed to:

- Behave like a real **Chainlink USD feed** implementing `IAggregatorV3Interface`
- Always return a **fixed price of exactly $1.00**
- Use **8 decimal places**, just like standard Chainlink USD feeds (e.g., ETH/USD, BTC/USD, etc.)

This makes it ideal for:

- Local development
- Unit and integration tests
- Simulation environments
- Any scenario where a predictable, stable USD price is desired

It is **not** intended for production usage where real-time, market-based USD prices are required.

---

## 2. Key Properties

The `USDPriceAggregator` contract mimics a Chainlink feed with the following fixed characteristics:

- **Price (answer)**:  
  Always returns `1e8`  
  → Represents `$1.00000000` in 8-decimal format

- **Decimals**:  
  Always returns `8`  
  → Compatible with the most common Chainlink USD feeds

- **Data freshness**:  
  Uses the current `block.timestamp` as the `updatedAt` value  
  → Consumers that check for staleness will see data as current

- **Round data fields**:  
  - `roundId` = `0`  
  - `startedAt` = `0`  
  - `answeredInRound` = `0`  
  These are dummy placeholders, sufficient for test/stub use cases.

- **No external calls**:  
  All values are computed locally within the contract.

---

## 3. Implemented Interface

The contract implements the **Chainlink Aggregator V3 interface**: `IAggregatorV3Interface`.

The important functions for consumers are:

### 3.1 `decimals()`

- **Visibility**: `external`, `pure`
- **Returns**: `uint8`
- **Behavior**:  
  Always returns `8`, indicating that the price returned by the oracle uses 8 decimal places.

This matches the standard used by Chainlink USD oracles, so upstream contracts that integrate with Chainlink feeds can treat this stub exactly like a real USD feed from a decimals perspective.

### 3.2 `latestRoundData()`

- **Visibility**: `external`, `view`
- **Returns**:  
  - `roundId` (`uint80`)
  - `answer` (`int256`)
  - `startedAt` (`uint256`)
  - `updatedAt` (`uint256`)
  - `answeredInRound` (`uint80`)

- **Behavior**:
  - `answer` is always `1e8`, representing `$1.00` with 8 decimals.
  - `updatedAt` is set to `block.timestamp` at the moment of the call.
  - `roundId`, `startedAt`, and `answeredInRound` are static zeros.

The return signature is fully compatible with Chainlink’s `latestRoundData()`, allowing any upstream consumer that expects a Chainlink aggregator to use this contract without changes.

---

## 4. How Consumers Should Use It

Contracts that rely on Chainlink feeds typically:

1. Call `decimals()` to know how many decimals the `answer` uses.
2. Call `latestRoundData()` and extract the `answer` and `updatedAt` fields.
3. Possibly enforce:
   - `answer > 0`
   - `updatedAt` not too old

`USDPriceAggregator` satisfies all these expectations.

### 4.1 Converting to 18-Decimal Scale

Many DeFi protocols use **18-decimal precision** internally. Since the aggregator returns a price with 8 decimals, you may need to scale it.

Given:

- `answer = 1e8` (8 decimals)
- Desired: 18 decimals

Conversion:

- `price_18_decimals = answer * 1e10`

This is the standard conversion step when moving from 8 → 18 decimals.

### 4.2 Example Logical Uses (Conceptual)

- As a **mock stablecoin oracle** for testing protocols that handle stable assets.
- As a **fixed USD peg oracle** for verifying logic around price-dependent rewards, collateral, or liquidation without fluctuation.
- As part of integration tests in Frgmnt’s **asset handler** or **portfolio valuation** modules, where price volatility would otherwise complicate deterministic assertions.

---

## 5. Design Goals and Rationale

The main goals of `USDPriceAggregator` are:

- **Determinism**:  
  Every call to `latestRoundData()` returns the same price (`$1.00`) and a fresh timestamp.
- **Compatibility**:  
  By following `IAggregatorV3Interface`, existing Chainlink-consuming code can use this contract without adaptation.
- **Simplicity**:  
  No owner, no admin, no upgradability, no external dependencies. This reduces attack surface in test environments and makes the behavior easy to reason about.
- **Isolation**:  
  No external network calls to Chainlink or off-chain infrastructure, ensuring reliability in local testnets, CI pipelines, or forks without Chainlink support.

---

## 6. Limitations

While highly useful for development and testing, this contract has clear limitations:

- **No real price data**:  
  It always returns a fixed $1.00 price and ignores real market conditions.

- **No historical rounds**:  
  The fields `roundId`, `startedAt`, and `answeredInRound` are constant or trivial values. This is acceptable for most tests but does not emulate historical oracle behavior.

- **Not suitable for production**:  
  Using a constant price feed in production would create serious economic risks. It should only be used in controlled environments where all participants understand its static nature.

- **No configurability**:  
  The price cannot be changed at runtime. If you need a configurable testing oracle, another contract (e.g., a mock with `setAnswer`) should be used instead.

---

## 7. Typical Integration in Frgmnt

In the context of the Frgmnt project, `USDPriceAggregator` can be used:

- As a **default USD oracle** for development assets
- For **unit testing asset handlers** that expect Chainlink feeds
- In **local deployments** where external Chainlink infrastructure is not available

It provides a stable testing baseline and ensures that price-related logic can be validated without dealing with external systems.

---

## 8. Summary

`USDPriceAggregator` is a **fixed-price, Chainlink-compatible USD oracle stub**:

- Always returns $1.00 in 8-decimal format (`1e8`)
- Implements `IAggregatorV3Interface` (`decimals()` and `latestRoundData()`)
- Uses `block.timestamp` as the update time to appear fresh
- Has no external dependencies, no configuration, and no admin
- Intended for **development and testing**, not for production

This README contains all the conceptual and behavioral information for `USDPriceAggregator` in a single markdown document, without including the Solidity source code, and is ready for direct use as file-based documentation.
