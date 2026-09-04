# AaveLendingPoolGuardV3

**Source:** `contracts/contracts/guards/contractGuards/AaveLendingPoolGuardV3.sol`
**Guard Type:** Contract Guard
**Target Protocol:** Aave V3

---

## Overview

AaveLendingPoolGuardV3 validates all Aave V3 Pool transactions executed by the Frgmnt vault. It inspects calldata for each Aave operation, enforces protocol safety rules, and performs a post-transaction health factor check to prevent undercollateralization.

---

## Responsibilities

- Validate that all Aave supply/borrow/repay/withdraw calls use supported assets
- Enforce that `onBehalfOf` and recipient addresses are the vault itself (no third-party positions)
- Restrict borrowing to variable-rate only and single-asset debt
- Enforce a minimum health factor of 1.01 after any risk-increasing operation
- Return a transaction type code for audit logging

---

## Functions

### `txGuard`

```solidity
function txGuard(
    address poolManagerLogic,
    address to,
    bytes calldata data
) external returns (uint16 txType, bool isPublic)
```

Main entry point. Routes the transaction to the appropriate handler based on function selector.

**Supported Aave V3 operations:**

| Operation | Selector | Handler |
|-----------|---------|---------|
| `supply` | `0x617ba037` | `_deposit` |
| `withdraw` | `0x69328dec` | `_withdraw` |
| `borrow` | `0xa415bcad` | `_borrow` |
| `repay` | `0x573ade81` | `_repay` |
| `repayWithATokens` | `0x2dad97d4` | `_repayWithATokens` |
| `setUserUseReserveAsCollateral` | `0x5a3b74b9` | `_setUserUseReserveAsCollateral` |
| `swapBorrowRateMode` | `0x94ba89a2` | `_swapBorrowRateMode` |
| `rebalanceStableBorrowRate` | `0xcd112382` | `_rebalanceStableBorrowRate` |

**Returns:**

| Name | Type | Description |
|------|------|-------------|
| `txType` | `uint16` | Aave-specific transaction type code |
| `isPublic` | `bool` | Always `false` — only manager/trader can execute |

---

### `afterTxGuard`

```solidity
function afterTxGuard(
    address poolManagerLogic,
    address to,
    bytes calldata data
) external view
```

Post-execution hook. Called after every Aave transaction to verify that the health factor remains above the minimum threshold.

**Validation:**
```
healthFactor = aave.getUserAccountData(pool).healthFactor
require(healthFactor > 1.01e18)
```

Reverts if the health factor is not strictly above 1.01 after the transaction. Only checked for risk-increasing operations: `borrow` (always), `setUserUseReserveAsCollateral` when disabling collateral, and **every** `withdraw` regardless of size (see CertiK FNA-24 below).

> **CertiK FNA-24**: `withdraw` was previously only treated as risk-increasing when Aave still reported the withdrawn reserve as collateral-enabled *after* the withdrawal executed (`afterTxGuard` runs post-transaction). Aave clears that exact flag when a withdrawal empties the caller's aToken balance for a reserve — so a **full** withdrawal of a collateral asset observed itself as already-disabled and skipped the health-factor check entirely, while an otherwise-identical **partial** withdrawal of the same asset (flag still `true`) was correctly checked. Checking unconditionally on every withdrawal closes that gap regardless of size, and is safe for a non-collateral or debt-free withdrawal too: health factor is unaffected by withdrawing an asset that wasn't backing any debt, and `getUserAccountData` reports `healthFactor = type(uint256).max` for a debt-free pool, so the check trivially passes in both cases.

---

## Per-Operation Validations

### `supply`

- `asset` must be in the vault's supported asset list with type `4` (Aave lending asset)
- `onBehalfOf` must equal the vault address
- `amount` must be > 0

### `withdraw`

- `asset` must be supported
- `to` must equal the vault address (parameter named `onBehalfOf` in the guard's own decode, but semantically the withdrawal recipient)

### `borrow`

- `asset` must be supported
- `onBehalfOf` must equal the vault address
- Only `interestRateMode = 2` (variable rate) is allowed
- Vault must not already have debt in a different asset (single-asset debt rule)

### `repay`

- `asset` must be supported
- `onBehalfOf` must equal the vault address

### `repayWithATokens`

- Same as `repay` — `asset` must be supported

### `setUserUseReserveAsCollateral`

- `asset` must be supported

### `swapBorrowRateMode`

- Only allows conversion from stable to variable rate (not the reverse)

### `rebalanceStableBorrowRate`

- `user` must equal the vault address

---

## Access Control

| Caller | Permissions |
|--------|------------|
| PoolLogic | Can initiate `txGuard()` and `afterTxGuard()` |
| Manager / Trader | Must originate the `execTransaction()` call in PoolLogic |

The guard itself has no owner or privileged roles — it is a stateless validator called via the guard dispatch system.

---

## Health Factor Threshold

The minimum health factor of `1.01e18` (1.01 in Aave's 1e18 scale) provides a 1% buffer above liquidation threshold, protecting the vault from accidental undercollateralization while still allowing efficient capital usage. Applied consistently with [MorphoBlueContractGuard](MorphoBlueContractGuard.md)'s own threshold across both leveraged lending integrations.

---

## Documented Rule: Single Debt-Asset Only

`_borrow()` enforces that a pool may hold debt in only one asset at a time: before authorizing a new `borrow`, it iterates every *other* supported asset and requires zero stable/variable debt-token balance for each. This is a Frgmnt-specific risk-management rule, not an Aave V3 constraint — Aave itself supports multi-asset debt.

---

## Asset Type Requirement

Every operation touching a lending-position asset (`supply`, `withdraw`, `borrow`, `repay`, `repayWithATokens`, `setUserUseReserveAsCollateral`) requires `IHasAssetInfo.getAssetType(asset) == 4` — see [Governance's Asset Type Registry](Governance.md#asset-type-registry) for the on-chain-verified mapping (CertiK FNA-33).

---

## Related

- [AaveLendingPoolAssetGuard](AaveLendingPoolAssetGuard.md) — the paired asset guard handling valuation and pro-rata/flashloan-based withdrawal of the position this guard's calls create
- [MorphoBlueContractGuard](MorphoBlueContractGuard.md) — the structurally analogous leveraged-lending contract guard for Morpho Blue
