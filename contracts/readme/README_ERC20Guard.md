# 🧱 Frgmnt ERC20 Asset Guard

## Overview

The **Frgmnt ERC20 Asset Guard** is a security and validation layer for standard ERC20 assets in the **Frgmnt** portfolio architecture.  
It ensures that all token approvals, withdrawals, and removals within managed pools adhere to safe, auditable, and protocol-compliant operations.

---

## 📜 Contract Summary

| Item | Description |
|------|--------------|
| **Name** | `ERC20Guard` |
| **Solidity Version** | `^0.8.24` |
| **Asset Type** | `0` (Standard ERC20) |
| **Purpose** | Validates approvals, computes proportional withdrawals, prevents unauthorized removals |
| **Key Interfaces** | `IAssetGuard`, `IGuard`, `IERC20Extended` |
| **Dependencies** | OpenZeppelin `IERC20` |

---

## ⚙️ Features

### ✅ Transaction Guarding
- Intercepts `approve()` calls on ERC20 tokens.
- Validates that the **spender** has a registered contract guard within the Frgmnt factory.
- Emits structured `Approve` events for on-chain traceability.

### 💰 Withdrawal Processing
- Calculates the **pro-rata** amount to withdraw based on a user’s portion of the fund (`portion` in 1e18 scale).
- Returns the computed `withdrawAsset` and `withdrawAmount` for execution by the pool logic.
- No additional multi-transaction data is required for plain ERC20 withdrawals.

### 🔍 Asset Management
- Retrieves on-chain ERC20 **balances** and **decimals**.
- Prevents asset removal when a positive balance exists in the pool (safety invariant).

---

## 🧩 Key Functions

### `txGuard(address _poolManagerLogic, address, bytes calldata data)`
Validates ERC20 approvals.

| Parameter | Description |
|------------|-------------|
| `_poolManagerLogic` | Pool Manager Logic contract |
| `data` | Encoded calldata from the transaction |
| **Returns** | `txType` (1 for approve) and `isPublic` (always `false`) |

**Behavior:**
- Decodes the `approve(address,uint256)` call.
- Confirms the spender has a valid guard registered.
- Emits an `Approve` event.

---

### `withdrawProcessing(address pool, address asset, uint256 portion, address)`
Calculates withdrawal proportional to the provided share.

| Parameter | Description |
|------------|-------------|
| `pool` | Address of the pool |
| `asset` | ERC20 asset address |
| `portion` | Fraction in 1e18 scale (e.g., 5e17 = 50%) |
| **Returns** | `(withdrawAsset, withdrawAmount, txs)` |

**Example:**
```solidity
withdrawAsset = asset;
withdrawAmount = (IERC20(asset).balanceOf(pool) * portion) / 1e18;
