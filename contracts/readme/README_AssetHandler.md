# AssetHandler Contract

The **AssetHandler** contract is part of the Frgmnt protocol and serves as a centralized registry for:

- Mapping assets to **asset types** (project-specific classification)
- Mapping assets to **Chainlink USD price aggregators**
- Providing **normalized USD prices** (scaled to `1e18`) for registered assets

It is implemented as an **upgradeable** contract using OpenZeppelin’s `OwnableUpgradeable`.

---

## Contract Purpose

From the original contract header:

> Central registry mapping assets → (type, Chainlink USD aggregator).  
> Returns USD prices scaled to 18 decimals.  
> The `assetTypes` enum is project-specific.

---

## Key Responsibilities

1. **Registry of Asset Types**  
   Stores a `uint16` type ID for each asset address.

2. **Registry of Price Aggregators**  
   Stores a Chainlink USD price feed address for each asset.

3. **USD Price Retrieval**  
   Uses Chainlink’s `latestRoundData()` to fetch the latest price, checks for staleness, and normalizes it to 18 decimals.

4. **Freshness Control via `chainlinkTimeout`**  
   Ensures prices are not older than a configurable timeout window.

5. **Owner-Only Management**  
   Only the owner can add, batch-add, or remove assets, and update the Chainlink timeout.

6. **Upgradeable Pattern Support**  
   Uses an `initialize` function instead of a constructor and includes a storage gap.

---

## State Variables

- `uint256 public chainlinkTimeout;`  
  Chainlink oracle freshness window in seconds (default ≈ 25 hours → `90_000`).

- `mapping(address => uint16) public override assetTypes;`  
  Maps each asset to a project-specific `uint16` asset type.

- `mapping(address => address) public override priceAggregators;`  
  Maps each asset to the Chainlink USD price feed address.

- `uint256[50] private __gap;`  
  Reserved storage for future upgrades (upgradeable pattern).

---

## Initialization

### `initialize(Asset[] memory assets) external initializer`

- Sets the contract owner via `__Ownable_init(msg.sender)` (OpenZeppelin v5 signature).
- Sets `chainlinkTimeout` to `90_000` seconds (~25 hours).
- Calls `addAssets(assets)` to batch-register the provided assets.

**Parameters**

- `assets`: An array of `Asset` structs (defined in `IAssetHandler`), each containing:
  - `asset` (address)
  - `assetType` (`uint16`)
  - `aggregator` (address of Chainlink USD feed)

---

## Price Retrieval

### `getUSDPrice(address asset) external view override returns (uint256 price)`

Returns the **Chainlink USD price** of the given `asset`, normalized to 18 decimals.

**Behavior:**

1. Reads the price aggregator from `priceAggregators[asset]`.
2. Requires the aggregator to be non-zero:
   - `require(aggregator != address(0), "Frgmnt: aggregator not found");`
3. Calls Chainlink’s:
   ```solidity
   latestRoundData()
