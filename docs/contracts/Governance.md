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
| `assetType` | `uint16` | Asset type classification — see [Asset Type Registry](#asset-type-registry) below for the current, on-chain-verified mapping |
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

<!-- FNA-33: this table previously listed 0=ERC20, 4=AaveV3, 5=Morpho, 7=UniV3 NFT, which
     does not match the live registry (confirmed via Governance.assetGuards(uint16) on Base,
     block 49894684 — see docs/deployments.md's Asset Guards table, the authoritative,
     on-chain-verified source for this mapping). Corrected to match; the previous "1 = Closed
     / non-withdrawable asset" row is dropped rather than reassigned, since on-chain Type 1 is
     MorphoBlueAssetGuard and there is no confirmed on-chain type currently bound to
     ClosedAssetGuard. -->

Asset type identifiers currently bound on Base (verify against `Governance.assetGuards(uint16)` or docs/deployments.md before registering a new one — this table is a convenience mirror, not a second source of truth):

| Type ID | Asset Class | Guard |
|---------|------------|-------|
| `0` | Unset | — |
| `1` | Morpho Blue lending position | `MorphoBlueAssetGuard` |
| `2` | Aave V3 lending position | `AaveV3LendingPoolAssetGuard` |
| `3` | Uniswap V3 LP NFT position | `UniswapV3AssetGuard` |
| `4` | Standard ERC20 token | `ERC20Guard` |

New asset types can be added by deploying a new asset guard and calling `setAssetGuard()` without modifying any other contract.
