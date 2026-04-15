# UniswapV3RouterGuard

**Source:** `contracts/contracts/guards/contractGuards/uniswapV3/UniswapV3RouterGuard.sol`
**Guard Type:** Contract Guard
**Target Protocol:** Uniswap V3 SwapRouter

---

## Overview

UniswapV3RouterGuard validates swap transactions executed through Uniswap V3's SwapRouter. It ensures swaps only involve supported assets, records pre/post balance snapshots for slippage accumulation tracking, and restricts multicall operations to a single swap per call.

---

## Responsibilities

- Validate that swap input and output tokens are in the vault's supported asset list
- Track pre-execution and post-execution token balances for downstream slippage accounting
- Restrict `multicall()` to contain exactly one swap operation
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

Main entry point. Routes to the appropriate handler based on function selector.

**Supported operations:**

| Operation | Selector | Description |
|-----------|---------|-------------|
| `exactInputSingle` | `0x414bf389` | Swap exact amount in for minimum amount out (single pool) |
| `exactInput` | `0xb858183f` | Swap exact amount in along a multi-hop path |
| `exactOutputSingle` | `0xdb3e2198` | Swap for exact amount out (single pool) |
| `exactOutput` | `0x09b81346` | Swap along multi-hop path for exact output |
| `multicall` | `0xac9650d8` | Batch call — restricted to exactly one swap |

---

### `_decodePath`

```solidity
function _decodePath(bytes memory path) internal pure returns (address tokenIn, address tokenOut)
```

Extracts the input and output token addresses from an encoded Uniswap V3 multi-hop path.

Path format: `[tokenIn (20 bytes)][fee (3 bytes)][tokenMid...][fee (3 bytes)][tokenOut (20 bytes)]`

---

## Validation Rules

### For all swap types

1. `tokenIn` must be in the vault's supported asset list
2. `tokenOut` must be in the vault's supported asset list
3. The swap recipient must be the vault itself

### For `multicall`

- The multicall payload must contain exactly one swap operation
- The inner swap is decoded and validated with the same rules

---

## Slippage Accounting

Rather than enforcing slippage directly in the guard, the guard records balance snapshots into the `SlippageAccumulatorUser` before and after each swap. The `SlippageAccumulator` then computes the effective slippage over a rolling window and reverts if cumulative slippage exceeds the configured threshold.

This design separates per-swap validation from cumulative protocol-level slippage management.

---

## Access Control

| Caller | Permissions |
|--------|------------|
| PoolLogic | Can invoke `txGuard()` |
| Manager / Trader | Must originate the `execTransaction()` call |

The guard is stateless and has no owner or privileged roles.

---

## Notes

- Swaps between unsupported assets are always rejected, even if both tokens are valid ERC20s
- The `multicall` restriction to one swap prevents complex batched operations that could bypass per-swap validation
