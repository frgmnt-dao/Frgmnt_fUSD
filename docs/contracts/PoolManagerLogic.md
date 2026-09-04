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

#### `totalFundValue` / `totalFundValueWithCompleteness` (CertiK FNA-04, FNA-54)

```solidity
function totalFundValue() external view returns (uint256)
function totalFundValueWithCompleteness() public view returns (uint256 total, bool complete)
```

Both sum `assetValue(asset)` across every supported asset, then subtract the aggregate deficit via `_subtractTotalDeficit()` (below). `totalFundValueWithCompleteness()` additionally checks each asset's `IIncompleteValuationGuard` marker (`_isValuationComplete()`, low-level staticcall) and returns `complete = false` if any asset's valuation is currently degraded — the completeness flag [FundCalculationLibrary](FundCalculationLibrary.md)'s `totalValueWithCompleteness()` reads via a fallback staticcall so PoolLogic and PoolManagerLogic can be upgraded in either order (CertiK FNA-04). A guard without the marker, or whose marker check itself can't be decoded, is treated as complete — correct for every guard that either reverts on failure (making the whole call revert, not silently understate it) or has no external dependency that can degrade a nonzero position to zero.

#### `_subtractTotalDeficit` (CertiK FNA-54)

```solidity
function _subtractTotalDeficit(uint256 grossTotal) internal view returns (uint256)
```

Sums every supported asset's `IDeficitReportingGuard`-reported deficit (an underwater lending position's debt exceeding its collateral) and subtracts the total from `grossTotal`, floored at 0. A guard without the marker contributes 0. `getBalance()` alone can only clamp an underwater position's own contribution to 0 — it cannot make the aggregate go negative, since every consumer works in non-negative `uint256` — so without this separate pass the deficit would be silently *omitted* rather than actually *deducted* from the rest of the pool's positive balances.

#### `assetValue` (CertiK FNA-56)

```solidity
function assetValue(address asset) public view returns (uint256)
function assetValue(address asset, uint256 amount) public view returns (uint256)
```

Returns USD value of the vault's current balance of an asset, or the USD value of a specific `amount`. Checks `_isPreValued(guard)` (shared with `getAssetPrice()` above, CertiK FNA-56) — for a pre-valued asset, `amount` **is** the USD-18 value already (the guard's own `getBalance()` returns a fully priced figure), so it's returned as-is rather than run through `AssetHandler`'s placeholder $1.00 identity feed.

#### `assetBalance`

```solidity
function assetBalance(address asset) public view returns (uint256)
```

Returns the vault's balance of `asset` as reported by the asset's guard contract.

#### `getAssetPrice` (CertiK FNA-45 follow-up, FNA-56)

```solidity
function getAssetPrice(address asset) external view returns (uint256)
```

Checks `_isPreValued(guard)` (a low-level staticcall to the guard's `isPreValuedAssetGuard()` marker, shared by `assetValue()` and `_addAsset()`'s FNA-18 check below — CertiK FNA-56) — if the asset's guard is pre-valued, dispatches to `IPreValuedAssetGuard(guard).getUnitPrice(asset)` via a plain typed call (no try/catch, so a guard revert propagates rather than being swallowed — the correct fail-closed behavior for a price a caller is about to act on). Otherwise returns the Chainlink USD price of `asset` (18 decimals) via `AssetHandler`. AssetHandler's registered feed for a pre-valued asset is only a placeholder $1.00 identity aggregator — returning it directly for a *transferable* pre-valued share (Morpho Vault V2 / Aave V4 Tokenization, worth more or less than $1) would silently misprice any consumer calling this function directly rather than through `assetValue()`'s own already-correct short-circuit (`SlippageAccumulator.assetValue()` being the concrete case this closes).

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

**Adding an asset — additional checks (`_addAsset`):**
- `asset` must not itself be `fUSD` (`CannotAddFusdAsAsset()`, CertiK FNA-23) — fUSD is the fund's accounting unit, not a collateral asset; listing it as its own backing pool's supported asset would leave fUSD reserved for finalized cash withdrawals un-ring-fenced from the pool's general fUSD balance, spendable by ordinary guarded operations.
- If `isDeposit == true` and the asset's guard is pre-valued (`_isPreValued`, see `getAssetPrice()` above), reverts `PreValuedAssetNotDepositable()` (**CertiK FNA-18**) — a pre-valued guard's `getBalance()` already returns a fully priced USD-18 figure, and its registered AssetHandler price is a fixed $1 identity multiplier, not a real per-share price. `TokenLogic`'s deposit math and `PoolLogic`'s queued-withdrawal math both treat the registered price/decimals as literal per-raw-unit conversion factors — depositing or queue-withdrawing such an asset would mint or transfer against the wrong quantity whenever one unit's real value isn't exactly $1. Enforced here (the single authoritative point `isDeposit` is ever set), not just by convention.

**Removing an asset — additional checks (`_removeAsset`):**
- **CertiK FNA-52**: requires a *resolvable* guard before allowing removal — reverts `NoAssetGuard()` rather than silently skipping `removeAssetCheck()` when the guard lookup returns `address(0)`. If an operator clears an asset's type mapping in `AssetHandler` before removing it from this pool's own `supportedAssets`, an unconditional skip would let an asset with an open position be removed with no safety check at all.
- **CertiK FNA-53**: after the candidate's own `removeAssetCheck()` passes, `_requireNotReferencedByOtherAssets()` loops every *other* supported asset and calls its guard's `removeTokenCheck(poolLogic, otherAsset, _asset)`, reverting `AssetStillReferenced()` if any of them still depend on `_asset`. Centralizes a check that seven guards already implement (`ERC20Guard`, `ClosedAssetGuard` and everything built on it) but that, before this fix, only ever actually ran from `ERC20Guard.removeAssetCheck()`'s own loop — so it only fired when the *asset being removed* was itself ERC20Guard-typed. A composite ERC-20 (e.g. a Morpho Vault V2 share) used as a Uniswap V3 position leg could previously be removed from `supportedAssets` while an open Uniswap V3 NFT still referenced it, silently degrading that position's valuation. Now runs for every removal uniformly, regardless of the candidate's own guard type; `ERC20Guard.removeAssetCheck()` no longer duplicates it (see [ERC20Guard](ERC20Guard.md)).

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

#### `commitFeeIncrease` (CertiK FNA-43)

```solidity
function commitFeeIncrease() external
```

**Access control:** Manager only.

Activates the announced fee increase after the delay has elapsed. **Reverts (`"NAV incomplete"`) if `totalFundValueWithCompleteness()` reports an incomplete NAV reading** — committing a fee increase against a transiently-understated NAV would settle the *old* rate's fee (`mintManagerFee()`, called next) against too-low a base, then apply the *new*, higher rate going forward once the guard recovers and NAV jumps back up, effectively taxing the recovery. Calls `PoolLogic.mintManagerFee()` to settle fees at the old rate before the new rates take effect.

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

---

## Related

- [FundCalculationLibrary](FundCalculationLibrary.md) — consumes `totalFundValueWithCompleteness()`/`getAssetPrice()`/`assetValue()`/`getAssetGuard()` for the bulk of PoolLogic's NAV/fee/withdrawal arithmetic
- [Governance](Governance.md) — the guard registry `getAssetGuard()`/`getContractGuard()` proxy to
- [ERC20Guard](ERC20Guard.md) — the removal-safety check centralized into `_removeAsset()` by CertiK FNA-53
