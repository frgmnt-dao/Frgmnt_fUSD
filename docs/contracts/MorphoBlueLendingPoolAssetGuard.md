# MorphoBlueLendingPoolAssetGuard

**Source:** `contracts/contracts/guards/assetGuards/MorphoBlueLendingPoolAssetGuard.sol`
**Asset Type:** `5` (Morpho Blue position)

---

## Overview

MorphoBlueLendingPoolAssetGuard manages the valuation and withdrawal of Morpho Blue positions held in the vault. It aggregates net USD exposure across all Morpho markets the vault participates in, and generates the withdrawal transaction sequence — including flash loan-based unwinding for leveraged positions.

---

## Responsibilities

- Compute net USD value of all vault Morpho Blue positions (supply + collateral − debt)
- Generate pro-rata withdrawal transactions for Morpho positions
- Orchestrate flash loan callbacks for leveraged position unwinding via Morpho flash loans
- Enforce that all Morpho positions are closed before asset removal

---

## Functions

### `getBalance`

```solidity
function getBalance(address pool, address asset) external view returns (uint256)
```

Returns the net USD value of the vault's Morpho Blue exposure:

```
netValue = Σ(collateralUSD + supplyUSD − debtUSD)
           across all Morpho markets
```

Aggregates across all markets tracked for the vault in the `NftTrackerStorage` and MorphoChecksLib.

---

### `withdrawProcessing`

```solidity
function withdrawProcessing(
    address pool,
    address asset,
    address to,
    uint256 portion
) external view returns (address, uint256, MultiTransaction[] memory)
```

Generates the withdrawal transaction sequence.

**Logic:**
- If no debt exists in the market: encode direct `withdraw()` and `withdrawCollateral()` calls proportional to `portion`
- If debt exists: encode a Morpho flash loan initiation — the full unwind happens inside the flash loan callback

---

### `flashloanProcessing`

```solidity
function flashloanProcessing(
    address pool,
    uint256 portion,
    uint256 assets,
    ComplexAsset calldata complexAssetData
) external returns (MultiTransaction[] memory)
```

Morpho flash loan callback handler. Called during `PoolLogic.onMorphoFlashLoan()`.

**Execution sequence:**
1. Swap settlement token to loan token if needed (via Uniswap V3)
2. Repay outstanding Morpho debt
3. Withdraw collateral
4. Withdraw supplied assets
5. Swap withdrawn assets back to settlement token if needed
6. Repay flash loan

---

### `removeAssetCheck`

```solidity
function removeAssetCheck(address pool, address asset) external view
```

Reverts if the vault has any open Morpho position (supply, collateral, or debt). The position must be fully unwound before removal.

---

## Balance Calculation Detail

Net position per market:

```
netUSD = collateral × collateralPriceUSD
       + supply × loanTokenPriceUSD
       − debt × loanTokenPriceUSD
```

All values are in 18-decimal USD denomination.

---

## Access Control

| Role | Permissions |
|------|------------|
| Owner | Configuration: slippage, swap paths |
| PoolLogic | Calls `withdrawProcessing()` and `flashloanProcessing()` |

---

## Relationship to MorphoBlueContractGuard

| Guard | Role |
|-------|------|
| `MorphoBlueContractGuard` | Validates individual Morpho transactions (pre/post execution) |
| `MorphoBlueLendingPoolAssetGuard` | Aggregates position value and generates withdrawal plans |

Both guards work together: the contract guard controls what can be done, the asset guard controls how value is reported and unwound.
