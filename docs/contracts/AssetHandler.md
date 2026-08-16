# AssetHandler

**Source:** `contracts/contracts/priceAggregators/AssetHandler.sol`
**Proxy Pattern:** Transparent proxy (dedicated `ProxyAdmin`)

---

## Overview

AssetHandler is the protocol's central oracle registry. It maps asset addresses to their Chainlink price feeds and asset type classifications, providing normalized 18-decimal prices to PoolManagerLogic and any other consumer.

Asset feeds are expected to be USD-denominated. An optional Chainlink EUR/USD conversion feed (`eurUsdAggregator`) can be configured so `getUSDPrice()` returns EUR-denominated prices instead, while keeping the same function name and ABI for backward compatibility. This is off by default (no conversion applied) and is what lets the EUR-pegged and USD-pegged products share this exact contract source — the conversion feed is simply left unset on the USD deployment.

It includes L2 sequencer uptime validation (critical for Base) and per-asset staleness timeout configuration.

---

## Responsibilities

- Store Chainlink aggregator addresses for all protocol-supported assets
- Classify each asset by type (used for guard dispatch)
- Return prices normalized to 18 decimals, optionally EUR-converted
- Validate Chainlink data freshness (staleness timeout), including for the EUR/USD conversion feed itself when configured
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
| `eurUsdAggregator` | `address` | Optional Chainlink EUR/USD feed; when set, `getUSDPrice()` returns EUR-denominated prices |
| `eurUsdTimeout` | `uint256` | Staleness threshold for the EUR/USD conversion feed, seconds |
| `SEQUENCER_GRACE_PERIOD` | `uint256` | Fixed 3600-second grace period after sequencer restart |

---

## Functions

### `initialize`

```solidity
function initialize(Asset[] memory assets) external initializer
```

Initializes the contract and batch-registers the initial asset list.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `assets` | `Asset[]` | Array of `{asset, assetType, aggregator}` structs |

---

### `getUSDPrice`

```solidity
function getUSDPrice(address asset) external view returns (uint256)
```

Returns the price of `asset` normalized to 18 decimals. USD by default; if `eurUsdAggregator` is configured, the USD price is converted to EUR before being returned, via `assetEUR = assetUSD / EURUSD` (e.g. `USDC/USD = 1.00`, `EUR/USD = 1.08` ⇒ `USDC/EUR ≈ 0.9259`). The function name and ABI stay `getUSDPrice()` regardless, for backward compatibility with existing callers.

**Returns:** Price in 18-decimal format (e.g., `1e18` = $1.00, or €1.00 if EUR conversion is active)

**Reverts if:**
- L2 sequencer is down or within grace period
- Price data is stale (age > `chainlinkTimeouts[asset]`), or the EUR/USD conversion feed's data is stale (age > `eurUsdTimeout`), when conversion is active
- Price is zero or negative, for either the asset feed or the EUR/USD conversion feed

**Side effects:** None (view only)

---

### `addAsset`

```solidity
function addAsset(address asset, uint16 assetType, address aggregator) public override onlyOwner
```

Registers a single asset with its type and Chainlink aggregator.

**Side effects:** Sets `assetTypes[asset]`, `priceAggregators[asset]`. Emits `AddedAsset`.

---

### `addAssets`

```solidity
function addAssets(Asset[] memory assets) public override onlyOwner
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

Configures the optional EUR/USD conversion feed. Once set, `getUSDPrice()` returns EUR-denominated prices for every asset. The feed must return USD per 1 EUR, as standard Chainlink EUR/USD feeds do.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `feed` | `address` | Chainlink EUR/USD aggregator address |
| `timeout` | `uint256` | Maximum acceptable age of the EUR/USD feed's data, in seconds |

**Side effects:** Sets `eurUsdAggregator`, `eurUsdTimeout`. Emits `SetEurUsdAggregator`.

---

### `clearEurUsdAggregator`

```solidity
function clearEurUsdAggregator() external onlyOwner
```

Disables USD-to-EUR conversion; `getUSDPrice()` goes back to returning raw USD asset-feed prices.

**Side effects:** Resets `eurUsdAggregator` to the zero address and `eurUsdTimeout` to 0. Emits `ClearedEurUsdAggregator`.

---

## Events

| Event | Parameters | Emitted When |
|-------|-----------|-------------|
| `AddedAsset` | `asset, assetType, aggregator` | Asset registered |
| `RemovedAsset` | `asset` | Asset removed |
| `SetChainlinkTimeout` | `asset, timeout` | Staleness window updated |
| `SetSequencerUptimeFeed` | `feed` | Sequencer feed updated |
| `SetEurUsdAggregator` | `feed, timeout` | EUR/USD conversion feed configured |
| `ClearedEurUsdAggregator` | `oldFeed` | EUR/USD conversion disabled |

---

## Access Control

| Role | Permissions |
|------|------------|
| Owner (Factory Owner / Timelock) | Register/remove assets, update timeouts, set sequencer feed, configure/clear EUR/USD conversion |
| Any caller | `getUSDPrice()` (view) |

---

## Price Normalization

Chainlink aggregators return prices with varying decimal precision (typically 8 decimals). AssetHandler normalizes all prices to 18 decimals:

```
normalizedPrice = rawPrice × 10^(18 - aggregatorDecimals)
```

Consumers can then calculate USD value as:

```
usdValue = assetAmount × normalizedPrice / 10^assetDecimals
```

---

## L2 Sequencer Safety

On Base (an optimistic rollup), transactions can be silently queued if the sequencer goes offline, allowing stale state to persist. AssetHandler prevents price consumption when:

1. The sequencer is currently offline (`answer == 1`)
2. The sequencer restarted less than `SEQUENCER_GRACE_PERIOD` (3600 seconds) ago

This prevents oracle exploitation during sequencer downtime/restarts.
