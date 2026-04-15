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
require(healthFactor >= 1.01e18)
```

Reverts if the health factor drops below 1.01 after the transaction.

---

## Per-Operation Validations

### `supply`

- `asset` must be in the vault's supported asset list with type `4` (Aave lending asset)
- `onBehalfOf` must equal the vault address
- `amount` must be > 0

### `withdraw`

- `asset` must be supported
- `to` must equal the vault address

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

The minimum health factor of `1.01e18` (1.01 in Aave's 1e18 scale) provides a 1% buffer above liquidation threshold, protecting the vault from accidental undercollateralization while still allowing efficient capital usage.
