# MorphoBlueContractGuard

**Source:** `contracts/contracts/guards/contractGuards/MorphoBlueContractGuard.sol`
**Guard Type:** Contract Guard
**Target Protocol:** Morpho Blue

---

## Overview

MorphoBlueContractGuard validates all Morpho Blue transactions executed by the Frgmnt vault. It parses the function selector and parameters of each Morpho call, enforces asset support requirements, validates market parameters, and performs a post-transaction health factor check.

---

## Responsibilities

- Validate all Morpho Blue supply, withdraw, borrow, repay, and collateral operations
- Verify market parameters (loan token, collateral token, LLTV) reference supported assets
- Restrict `onBehalf` and `receiver` addresses to the vault itself
- Enforce a minimum health factor of 1.01 after borrow and withdraw operations
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

Main entry point. Dispatches to operation-specific handlers based on the function selector.

**Supported Morpho Blue operations:**

| Operation | Description |
|-----------|-------------|
| `supply` | Lend assets to a Morpho market |
| `withdraw` | Withdraw lent assets |
| `borrow` | Borrow against collateral |
| `repay` | Repay borrowed assets |
| `supplyCollateral` | Deposit collateral |
| `withdrawCollateral` | Withdraw collateral |
| `liquidate` | Liquidate an undercollateralized position |

---

### `afterTxGuard`

```solidity
function afterTxGuard(
    address poolManagerLogic,
    address to,
    bytes calldata data
) external view
```

Post-execution hook. Validates health factor after withdraw, borrow, and withdrawCollateral operations.

**Health factor formula:**
```
healthFactor = (collateralUSD × LLTV) / borrowedUSD
require(healthFactor >= 1.01e18)
```

Reverts if health factor is below 1.01 after the transaction.

---

## Per-Operation Validations

### `supply` / `withdraw`

- Loan token must be in vault's supported asset list
- `onBehalf` / `receiver` must equal the vault address
- Market collateral token must be supported

### `borrow` / `repay`

- Loan token must be supported
- `onBehalf` / `receiver` must equal the vault address
- Market collateral token must be supported

### `supplyCollateral` / `withdrawCollateral`

- Collateral token must be supported
- `onBehalf` must equal the vault address

### `liquidate`

- Validates that the market exists and assets are supported

---

## Market Parameter Validation

Each Morpho operation references a `MarketParams` struct:
```
{
    loanToken: address,
    collateralToken: address,
    oracle: address,
    irm: address,
    lltv: uint256
}
```

The guard validates that both `loanToken` and `collateralToken` are in the vault's supported asset list before allowing any operation to proceed.

---

## Access Control

| Caller | Permissions |
|--------|------------|
| PoolLogic | Can invoke `txGuard()` and `afterTxGuard()` |
| Manager / Trader | Must originate the `execTransaction()` call |

The guard is stateless and has no owner or privileged roles.

---

## Health Factor Threshold

The 1.01 minimum health factor (1% buffer above liquidation) is applied consistently with the Aave guard, providing uniform risk management across all integrated lending protocols.
