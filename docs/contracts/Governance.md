# Governance

**Source:** `contracts/contracts/Governance.sol`

---

## Overview

Governance is the protocol's central guard registry. It maps external contract addresses and asset type identifiers to their corresponding guard implementations. All guard lookups by PoolManagerLogic route through this contract.

---

## Responsibilities

- Map external protocol contract addresses (e.g., Aave V3 Pool) to contract guard implementations
- Map asset type identifiers (uint16) to asset guard implementations
- Restrict guard registration to the contract owner (DAO / Timelock)

---

## State Variables

| Variable | Type | Description |
|----------|------|-------------|
| `contractGuards` | `mapping(address → address)` | External contract address → guard contract address |
| `assetGuards` | `mapping(uint16 → address)` | Asset type identifier → guard contract address |

---

## Functions

### `constructor`

```solidity
constructor(address initialOwner)
```

Initializes the Ownable contract with `initialOwner` as the owner. The owner should be the Timelock contract post-deployment.

---

### `setContractGuard`

```solidity
function setContractGuard(address extContract, address guardAddress) external onlyOwner
```

Assigns a contract guard to an external protocol contract address.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `extContract` | `address` | The external contract to guard (e.g., Aave Pool) |
| `guardAddress` | `address` | The guard implementation contract |

**Validation:**
- Both addresses must be non-zero

**Side effects:** Sets `contractGuards[extContract] = guardAddress`. Emits `ContractGuardSet`.

---

### `setAssetGuard`

```solidity
function setAssetGuard(uint16 assetType, address guardAddress) external onlyOwner
```

Assigns an asset guard to an asset type.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `assetType` | `uint16` | Asset type classification (0=ERC20, 4=AaveV3, 5=Morpho, 7=UniV3 NFT, etc.) |
| `guardAddress` | `address` | The asset guard implementation |

**Validation:**
- `guardAddress` must be non-zero

**Side effects:** Sets `assetGuards[assetType] = guardAddress`. Emits `AssetGuardSet`.

---

## Events

| Event | Parameters | Emitted When |
|-------|-----------|-------------|
| `ContractGuardSet` | `extContract, guardAddress` | Contract guard assigned |
| `AssetGuardSet` | `assetType, guardAddress` | Asset guard assigned |

---

## Access Control

| Role | Permissions |
|------|------------|
| Owner (Timelock / DAO) | Register and update all guards |

---

## Asset Type Registry

Standard asset type identifiers used across the protocol:

| Type ID | Asset Class |
|---------|------------|
| `0` | Standard ERC20 token |
| `1` | Closed / non-withdrawable asset |
| `4` | Aave V3 lending position |
| `5` | Morpho Blue position |
| `7` | Uniswap V3 LP NFT position |

New asset types can be added by deploying a new asset guard and calling `setAssetGuard()` without modifying any other contract.
