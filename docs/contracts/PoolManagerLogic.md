# PoolManagerLogic

**Source:** `contracts/contracts/PoolManagerLogic.sol`
**Proxy Pattern:** UUPS

---

## Overview

PoolManagerLogic is the configuration and accounting hub for the Frgmnt vault. It maintains the registry of supported assets, manages the fee structure, provides USD valuation for all vault positions, and enforces access control for the manager and factory owner roles.

It serves as the single source of truth for what assets the vault holds, what fees apply, and who is authorized to act on behalf of the vault.

---

## Responsibilities

- Maintain the list of assets the vault can hold and trade
- Sum USD values of all vault positions to produce `totalFundValue()`
- Store and enforce fee parameters (performance, management, entry, exit)
- Implement fee announcement and delay mechanism for fee increases
- Look up guard contracts from Governance for a given asset or external contract
- Manage pool privacy, membership, and callback sender whitelists
- Propagate factory-level configuration: fee caps, pool registration, asset handler

---

## State Variables

### Core References

| Variable | Type | Description |
|----------|------|-------------|
| `poolLogic` | `address` | Linked PoolLogic vault address |
| `governance` | `address` | Governance contract (guard registry) |
| `assetHandler` | `address` | AssetHandler contract (Chainlink prices) |
| `factoryOwner` | `address` | Factory-level administrator |

### Asset Registry

| Variable | Type | Description |
|----------|------|-------------|
| `supportedAssets` | `Asset[]` | Ordered array of assets the vault supports |
| `assetPosition` | `mapping(address → uint256)` | 1-based position of each asset in `supportedAssets` |
| `allowedCallbackSenders` | `mapping(address → bool)` | Protocol addresses permitted to call back into the vault |
| `nftMembershipCollectionAddress` | `address` | Optional ERC721 for pool membership gating |
| `privatePool` | `bool` | Whether the pool restricts stakers to members |
| `traderAssetChangeDisabled` | `bool` | Whether traders are restricted from modifying the asset list |

### Fee Parameters

| Variable | Type | Description |
|----------|------|-------------|
| `performanceFeeNumerator` | `uint256` | Current performance fee rate |
| `managerFeeNumerator` | `uint256` | Current annual management fee rate |
| `entryFeeNumerator` | `uint256` | Current stake entry fee rate |
| `exitFeeNumerator` | `uint256` | Current unstake/withdrawal exit fee rate |
| `_managerFeeDenominator` | `uint256` | Denominator for all fee calculations |
| `announcedPerformanceFeeNumerator` | `uint256` | Pending performance fee (announced but not yet active) |
| `announcedManagerFeeNumerator` | `uint256` | Pending management fee |
| `announcedEntryFeeNumerator` | `uint256` | Pending entry fee |
| `announcedExitFeeNumerator` | `uint256` | Pending exit fee |
| `announcedFeeIncreaseTimestamp` | `uint256` | Timestamp when announced fees become active |

### Fee Caps (Factory-set)

| Variable | Type | Description |
|----------|------|-------------|
| `_maximumPerformanceFeeNumerator` | `uint256` | Hard cap on performance fee |
| `_maximumManagerFeeNumerator` | `uint256` | Hard cap on management fee |
| `_maximumEntryFeeNumerator` | `uint256` | Hard cap on entry fee |
| `_maximumExitFeeNumerator` | `uint256` | Hard cap on exit fee |
| `_maximumPerformanceFeeNumeratorChange` | `uint256` | Maximum allowed single fee increase |
| `_performanceFeeNumeratorChangeDelay` | `uint256` | Required delay before announced fees activate |
| `_maximumSupportedAssetCount` | `uint256` | Cap on number of simultaneously supported assets |

---

## Functions

### `initialize`

```solidity
function initialize(
    address _factoryOwner,
    address _manager,
    string calldata _managerName,
    address _poolLogic,
    address _assetHandler,
    address _governance,
    uint256 _performanceFeeNumerator,
    uint256 _managerFeeNumerator,
    uint256 _entryFeeNumerator,
    uint256 _exitFeeNumerator
) external initializer
```

Initializes the contract, validates cross-references between pool logic and manager logic, and sets initial fee rates.

---

### Asset Valuation

#### `totalFundValue`

```solidity
function totalFundValue() external view returns (uint256)
```

Returns the total USD value of all vault assets by summing `assetValue(asset)` for each entry in `supportedAssets`.

#### `assetValue`

```solidity
function assetValue(address asset) public view returns (uint256)
function assetValue(address asset, uint256 amount) public view returns (uint256)
```

Returns USD value of the vault's current balance of an asset, or the USD value of a specific `amount`.

#### `assetBalance`

```solidity
function assetBalance(address asset) public view returns (uint256)
```

Returns the vault's balance of `asset` as reported by the asset's guard contract.

#### `getAssetPrice`

```solidity
function getAssetPrice(address asset) external view returns (uint256)
```

Returns the Chainlink USD price of `asset` (18 decimals) via AssetHandler.

---

### Asset Management

#### `changeAssets`

```solidity
function changeAssets(Asset[] calldata _addAssets, address[] calldata _removeAssets) external
```

**Access control:** Manager, Trader (if not disabled), or Factory Owner.

Adds and removes assets from the vault's supported list. Insertion-sorted by asset type. Ensures at least one deposit-eligible asset remains after changes.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `_addAssets` | `Asset[]` | Assets to add `{asset: address, isDeposit: bool}` |
| `_removeAssets` | `address[]` | Asset addresses to remove |

**Side effects:** Calls `guard.removeAssetCheck()` for each removal. Emits `AssetAdded` / `AssetRemoved`.

---

### Fee Management

#### `setFeeNumerator`

```solidity
function setFeeNumerator(
    uint256 _performanceFeeNumerator,
    uint256 _managerFeeNumerator,
    uint256 _entryFeeNumerator,
    uint256 _exitFeeNumerator
) external
```

**Access control:** Manager only.

Decreases fees immediately (no delay required). Reverts if any fee exceeds the current value or the factory cap.

---

#### `announceFeeIncrease`

```solidity
function announceFeeIncrease(
    uint256 _performanceFeeNumerator,
    uint256 _managerFeeNumerator,
    uint256 _entryFeeNumerator,
    uint256 _exitFeeNumerator
) external
```

**Access control:** Manager only.

Announces a fee increase. Sets `announcedFeeIncreaseTimestamp = now + _performanceFeeNumeratorChangeDelay`. The increase must not exceed `_maximumPerformanceFeeNumeratorChange`.

---

#### `commitFeeIncrease`

```solidity
function commitFeeIncrease() external
```

**Access control:** Manager only.

Activates the announced fee increase after the delay has elapsed. Calls `PoolLogic.mintManagerFee()` first to settle fees at the old rate.

---

#### `renounceFeeIncrease`

```solidity
function renounceFeeIncrease() external
```

**Access control:** Manager only.

Cancels the pending fee increase.

---

### Pool Configuration

| Function | Access | Description |
|----------|--------|-------------|
| `setPoolPrivate(bool)` | Manager | Toggle pool membership restriction |
| `setTraderAssetChangeDisabled(bool)` | Manager | Restrict traders from modifying assets |
| `setNftMembershipCollectionAddress(address)` | Manager | Configure ERC721 membership NFT |
| `setAllowedCallbackSender(address, bool)` | Manager | Whitelist protocol callback addresses |
| `changeManager(address, string)` | Manager | Transfer manager role; mints pending fees first |

### Factory Configuration

| Function | Access | Description |
|----------|--------|-------------|
| `setFactoryConfig(...)` | Factory Owner | Set asset cap and all fee maximums |
| `setIsPool(address, bool)` | Factory Owner | Register/deregister pool addresses |
| `setFactoryOwner(address)` | Factory Owner | Transfer factory ownership |
| `setAssetHandler(address)` | Factory Owner | Update price feed contract |
| `setGovernance(address)` | Factory Owner | Update guard registry |
| `setPoolLogic(address)` | Factory Owner | Update vault reference (validates cross-reference) |

---

## Events

| Event | Parameters | Emitted When |
|-------|-----------|-------------|
| `AssetAdded` | `fund, manager, asset, isDeposit` | Asset added to supported list |
| `AssetRemoved` | `fund, manager, asset` | Asset removed |
| `ManagerFeeSet` | `fund, manager, perf, mgr, entry, exit, denom` | Fee rates changed |
| `ManagerFeeIncreaseAnnounced` | all fees + timestamp | Fee increase announced |
| `ManagerFeeIncreaseCommitted` | all fees | Announced fees activated |
| `ManagerFeeIncreaseRenounced` | — | Announced fees cancelled |
| `PoolLogicSet` | `address, setter` | Pool logic reference updated |
| `PoolStatusSet` | `pool, status` | Pool registered/deregistered |
| `PoolPrivacyUpdated` | `isPrivate` | Privacy setting changed |
| `FactoryOwnerUpdated` | `previous, new` | Factory ownership transferred |
| `AssetHandlerUpdated` | `previous, new` | AssetHandler updated |
| `GovernanceUpdated` | `previous, new` | Governance updated |
| `FactoryConfigUpdated` | all config params | Factory configuration applied |
| `TraderAssetChangeDisabledSet` | `disabled` | Trader asset restriction set |
| `NftMembershipCollectionAddressSet` | `previous, current` | NFT membership configured |
| `AllowedCallbackSenderSet` | `caller, allowed` | Callback sender whitelist updated |

---

## Access Control

| Role | Contract | Permissions |
|------|----------|------------|
| Manager | Managed | Change assets, configure pool, manage fees |
| Trader | Managed | Change assets (if not disabled) |
| Factory Owner | PoolManagerLogic | Fee caps, pool registration, contract upgrades |

**Fee change rules:**
- Decreases: immediate, no delay
- Increases: must be announced, subject to `_performanceFeeNumeratorChangeDelay` delay, and capped by `_maximumPerformanceFeeNumeratorChange` per announcement

---

## Guard Lookup

```solidity
function getAssetGuard(address asset) external view returns (address)
function getContractGuard(address extContract) external view returns (address)
```

These proxy directly to `Governance.assetGuards[assetType]` and `Governance.contractGuards[extContract]`. Used by PoolLogic and PoolTxExecutor to find the correct guard implementation for any given asset or external contract.
