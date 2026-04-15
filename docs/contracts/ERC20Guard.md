# ERC20Guard

**Source:** `contracts/contracts/guards/assetGuards/ERC20Guard.sol`
**Asset Type:** `0` (Standard ERC20)

---

## Overview

ERC20Guard is the asset guard for standard ERC20 tokens held in the vault. It validates ERC20 `approve()` calls executed by the vault, computes proportional withdrawal amounts, and enforces that assets cannot be removed while a balance remains.

---

## Responsibilities

- Validate that ERC20 approvals target only registered (guarded) contracts
- Compute pro-rata withdrawal amounts for standard token balances
- Prevent removal of assets with non-zero balances
- Return current ERC20 balance and decimal information

---

## Functions

### `txGuard`

```solidity
function txGuard(
    address poolManagerLogic,
    address to,
    bytes calldata data
) external view returns (uint16 txType, bool isPublic)
```

Validates ERC20 transactions executed by the vault. Currently handles `approve()` calls.

**Validation rules:**
- The `spender` address passed to `approve()` must have a registered contract guard in Governance
- Approvals to unguarded addresses are rejected

**Returns:**

| Name | Type | Description |
|------|------|-------------|
| `txType` | `uint16` | Transaction type code for event logging |
| `isPublic` | `bool` | Whether the transaction can be executed by anyone (always false here) |

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

Computes the withdrawal amount for `asset` proportional to the `portion` share.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `pool` | `address` | Vault address |
| `asset` | `address` | ERC20 token address |
| `to` | `address` | Withdrawal recipient |
| `portion` | `uint256` | Proportional share in 1e18 scale (1e18 = 100%) |

**Logic:**
```
withdrawable = totalBalance - reservedAssetBalance[asset]
amount = withdrawable × portion / 1e18
```

Returns an encoded `transfer(to, amount)` transaction if amount > 0.

---

### `getBalance`

```solidity
function getBalance(address pool, address asset) external view returns (uint256)
```

Returns the raw ERC20 balance of `asset` held by `pool`.

---

### `getDecimals`

```solidity
function getDecimals(address asset) external view returns (uint256)
```

Returns the decimal precision of `asset`.

---

### `removeAssetCheck`

```solidity
function removeAssetCheck(address pool, address asset) external view
```

Reverts if:
- The vault holds a non-zero balance of `asset`
- The asset is tracked as part of another position (e.g., embedded in an Aave aToken)

---

## Events

None. ERC20Guard is stateless and emits no events.

---

## Access Control

ERC20Guard is called exclusively by PoolManagerLogic and PoolLogic as part of the guard dispatch flow. It has no owner or privileged roles.

---

## Notes

- The `reservedAssetBalance` check ensures assets locked for pending queued withdrawal claims are not double-counted during pro-rata immediate withdrawals
- Approvals to addresses without a registered guard are explicitly blocked as a security measure — the vault can only approve whitelisted protocol contracts
