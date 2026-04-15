# AssetHandler

**Source:** `contracts/contracts/priceAggregators/AssetHandler.sol`
**Proxy Pattern:** UUPS

---

## Overview

AssetHandler is the protocol's central oracle registry. It maps asset addresses to their Chainlink price feeds and asset type classifications, providing normalized 18-decimal USD prices to PoolManagerLogic and any other consumer.

It includes L2 sequencer uptime validation (critical for Base) and per-asset staleness timeout configuration.

---

## Responsibilities

- Store Chainlink aggregator addresses for all protocol-supported assets
- Classify each asset by type (used for guard dispatch)
- Return USD prices normalized to 18 decimals
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

Returns the USD price of `asset` normalized to 18 decimals.

**Returns:** Price in 18-decimal format (e.g., `1e18` = $1.00)

**Reverts if:**
- L2 sequencer is down or within grace period
- Price data is stale (age > `chainlinkTimeouts[asset]`)
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

## Events

| Event | Parameters | Emitted When |
|-------|-----------|-------------|
| `AddedAsset` | `asset, assetType, aggregator` | Asset registered |
| `RemovedAsset` | `asset` | Asset removed |
| `SetChainlinkTimeout` | `asset, timeout` | Staleness window updated |
| `SetSequencerUptimeFeed` | `feed` | Sequencer feed updated |

---

## Access Control

| Role | Permissions |
|------|------------|
| Owner (Factory Owner / Timelock) | Register/remove assets, update timeouts, set sequencer feed |
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
