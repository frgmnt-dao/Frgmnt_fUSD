# AssetHandler

**Source:** `contracts/contracts/priceAggregators/AssetHandler.sol`
**Proxy Pattern:** Transparent proxy

---

## Overview

AssetHandler is the protocol's central oracle registry. It maps asset addresses to their Chainlink price feeds and asset type classifications, providing normalized 18-decimal prices to PoolManagerLogic and any other consumer.

For the EUR-pegged deployment, asset feeds remain USD-denominated and AssetHandler applies an optional Chainlink EUR/USD conversion feed. The `getUSDPrice()` ABI name is intentionally preserved for compatibility, but once `eurUsdAggregator` is configured its returned values are EUR-denominated.

It includes L2 sequencer uptime validation (critical for Base) and per-asset staleness timeout configuration.

---

## Responsibilities

- Store Chainlink aggregator addresses for all protocol-supported assets
- Classify each asset by type (used for guard dispatch)
- Return prices normalized to 18 decimals
- Optionally convert USD-denominated asset feeds into EUR-denominated prices
- Validate Chainlink data freshness (staleness timeout)
- Validate Base L2 sequencer is online and past the grace period
- Support batch asset registration

---

## State Variables

| Variable | Type | Description |
|----------|------|-------------|
| `assetTypes` | `mapping(address → uint16)` | Asset type classification per token address |
| `priceAggregators` | `mapping(address → address)` | Chainlink aggregator address per token |
| `chainlinkTimeouts` | `mapping(address → uint256)` | Per-asset staleness threshold in seconds |
| `sequencerUptimeFeed` | `address` | Chainlink L2 sequencer uptime feed address |
| `eurUsdAggregator` | `address` | Optional Chainlink EUR/USD conversion feed |
| `eurUsdTimeout` | `uint256` | Staleness threshold for the EUR/USD feed |
| `eurUsdModeLocked` | `bool` | CertiK FNA-40: set permanently by the first call to `setEurUsdAggregator()` or `clearEurUsdAggregator()` — see below |
| `SEQUENCER_GRACE_PERIOD` | `uint256` | Fixed 3600-second grace period after sequencer restart |

---

## Functions

### `initialize`

```solidity
function initialize(AssetConfig[] calldata assets) external initializer
```

Initializes the contract and batch-registers the initial asset list.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `assets` | `AssetConfig[]` | Array of `{asset, assetType, aggregator}` structs |

---

### `getUSDPrice`

```solidity
function getUSDPrice(address asset) external view returns (uint256)
```

Returns the price of `asset` normalized to 18 decimals.

**Returns:** Price in 18-decimal format. If `eurUsdAggregator` is unset, the value is USD-denominated. If `eurUsdAggregator` is set, the value is EUR-denominated.

EUR conversion formula:

```
assetEUR = assetUSD / EURUSD
```

Example: `USDC/USD = 1.00`, `EUR/USD = 1.08`, so `USDC/EUR = 0.9259`.

**Reverts if:**
- L2 sequencer is down or within grace period
- Price data is stale (age > `chainlinkTimeouts[asset]`)
- EUR/USD data is stale when conversion is enabled
- Price is zero or negative

**Side effects:** None (view only)

---

### `addAsset`

```solidity
function addAsset(address asset, uint16 assetType, address aggregator) external onlyOwner
```

Registers a single asset with its type and Chainlink aggregator.

**Side effects:** Sets `assetTypes[asset]`, `priceAggregators[asset]`. Emits `AddedAsset`.

---

### `addAssets`

```solidity
function addAssets(AssetConfig[] calldata assets) external onlyOwner
```

Batch-registers multiple assets. Each entry is `{asset, assetType, aggregator}`.

---

### `removeAsset`

```solidity
function removeAsset(address asset) external onlyOwner
```

Removes an asset from the registry, deleting its type, aggregator, and timeout.

**Side effects:** Emits `RemovedAsset`.

---

### `setChainlinkTimeout`

```solidity
function setChainlinkTimeout(address asset, uint256 newTimeout) external onlyOwner
```

Updates the staleness window for a specific asset's price feed.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `asset` | `address` | Target asset address |
| `newTimeout` | `uint256` | New maximum acceptable age of price data in seconds |

**Side effects:** Emits `SetChainlinkTimeout`.

---

### `setSequencerUptimeFeed`

```solidity
function setSequencerUptimeFeed(address feed) external onlyOwner
```

Configures the Chainlink L2 sequencer uptime feed address.

**Side effects:** Emits `SetSequencerUptimeFeed`.

---

### `setEurUsdAggregator`

```solidity
function setEurUsdAggregator(address feed, uint256 timeout) external onlyOwner
```

Configures the Chainlink EUR/USD conversion feed. The feed must return USD per 1 EUR.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `feed` | `address` | Chainlink EUR/USD aggregator address |
| `timeout` | `uint256` | Maximum acceptable age of the EUR/USD feed's data, in seconds |

**Side effects:** Sets `eurUsdAggregator`, `eurUsdTimeout`. Emits `SetEurUsdAggregator`. **Permanently sets `eurUsdModeLocked = true`** — see the one-shot lock note below.

---

### `clearEurUsdAggregator`

```solidity
function clearEurUsdAggregator() external onlyOwner
```

Disables EUR conversion and returns raw USD-denominated asset prices again.

**Side effects:** Resets `eurUsdAggregator` to the zero address and `eurUsdTimeout` to 0. Emits `ClearedEurUsdAggregator`. **Permanently sets `eurUsdModeLocked = true`** — see the one-shot lock note below.

---

### One-Shot EUR/USD Mode Lock (CertiK FNA-40)

`eurUsdModeLocked` is set permanently by the **first** call to either `setEurUsdAggregator()` or `clearEurUsdAggregator()`; both functions revert if it is already `true`, so the USD/EUR valuation basis can only ever be chosen once. This registry's basis feeds every pool's NAV, deposit, fee, and withdrawal accounting — toggling it later, after any pool has recorded real activity in the old basis, would reprice existing fUSD supply, `accountedAssets`, and pending queued withdrawals to a different unit without migrating any of them, letting a pure conversion-basis change be minted as pool yield or otherwise corrupt live accounting. The intended flow is a single bootstrap-time decision (`deploy_core_contracts.ts`, called immediately after deploy, before any pool exists) — not a runtime toggle. On this EUR-pegged product, that means `setEurUsdAggregator()` is expected to be the very first of the two calls; on a live, already-deployed `AssetHandler` predating this lock, a post-upgrade call to whichever function matches the product's intended mode is required to actually lock it in.

---

## Events

| Event | Parameters | Emitted When |
|-------|-----------|-------------|
| `AddedAsset` | `asset, assetType, aggregator` | Asset registered |
| `RemovedAsset` | `asset` | Asset removed |
| `SetChainlinkTimeout` | `asset, timeout` | Staleness window updated |
| `SetSequencerUptimeFeed` | `feed` | Sequencer feed updated |
| `SetEurUsdAggregator` | `feed, timeout` | EUR/USD conversion feed configured |
| `ClearedEurUsdAggregator` | `oldFeed` | EUR/USD conversion feed disabled |

---

## Access Control

| Role | Permissions |
|------|------------|
| Owner (Factory Owner / Timelock) | Register/remove assets, update timeouts, set sequencer feed, configure EUR/USD conversion |
| Any caller | `getUSDPrice()` (view) |

---

## Price Normalization

Chainlink aggregators return prices with varying decimal precision (typically 8 decimals). AssetHandler normalizes all prices to 18 decimals:

```
normalizedPrice = rawPrice × 10^(18 - aggregatorDecimals)
```

Consumers can then calculate value as:

```
assetValue = assetAmount × normalizedPrice / 10^assetDecimals
```

For EUR deployments, deployment and governance operations must preserve this oracle invariant:

- Asset feeds are USD-denominated
- `eurUsdAggregator` is Chainlink EUR/USD, meaning USD per 1 EUR
- Direct EUR-denominated asset feeds are not registered while `eurUsdAggregator` is enabled

---

## L2 Sequencer Safety

On Base (an optimistic rollup), transactions can be silently queued if the sequencer goes offline, allowing stale state to persist. AssetHandler prevents price consumption when:

1. The sequencer is currently offline (`answer == 1`)
2. The sequencer restarted less than `SEQUENCER_GRACE_PERIOD` (3600 seconds) ago

This prevents oracle exploitation during sequencer downtime/restarts.
