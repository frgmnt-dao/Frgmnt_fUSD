# AaveLendingPoolAssetGuard

**Source:** `contracts/contracts/guards/assetGuards/AaveLendingPoolAssetGuard.sol`
**Asset Type:** `2` (Aave V3 lending position) — see [Governance's Asset Type Registry](Governance.md#asset-type-registry) for the on-chain-verified mapping (FNA-33)

---

## Overview

AaveLendingPoolAssetGuard manages the valuation and withdrawal of Aave V3 positions held in the vault. It computes the net USD value of the vault's Aave position (collateral minus debt) and generates the necessary transaction sequence to safely unwind that position during a pro-rata withdrawal.

For leveraged positions (with outstanding debt), it uses a flash loan to repay debt before withdrawing collateral.

---

## Responsibilities

- Report the net USD value of the vault's Aave V3 position
- Generate safe withdrawal transactions for both simple (no debt) and leveraged (with debt) Aave positions
- Orchestrate flash loan callbacks for debt repayment and collateral withdrawal
- Apply configurable slippage tolerance to asset swaps during unwind
- Enforce that Aave positions are fully closed before asset removal

---

## Functions

### `getBalance`

```solidity
function getBalance(address pool, address asset) external view returns (uint256)
```

Returns the net USD value of the vault's Aave V3 position:

```
netValue = collateralUSD - debtUSD
```

Uses the Aave protocol data provider to fetch aToken balances and variable debt token balances across all supported assets.

---

### `withdrawProcessing`

```solidity
function withdrawProcessing(
    address pool,
    address asset,
    address portion,
    uint256 to
) external view returns (address, uint256, MultiTransaction[] memory)
```

Generates the withdrawal transaction sequence for the vault's Aave position.

**Logic:**
- If no debt exists: encode direct `withdraw()` calls proportional to `portion`
- If debt exists: encode a flash loan initiation via `PoolLogic.executeOperation()` — debt repayment and collateral withdrawal happen inside the flash loan callback

---

### `flashloanProcessing`

```solidity
function flashloanProcessing(
    address pool,
    uint256 portion,
    address[] calldata assets,
    uint256[] calldata amounts,
    ComplexAsset calldata complexAssetData
) external returns (MultiTransaction[] memory)
```

Flash loan callback handler. Called during `PoolLogic.executeOperation()` with pre-encoded Aave flash loan parameters.

**Execution sequence:**
1. If collateral asset ≠ settlement token: swap collateral to settlement token via Uniswap V3
2. Repay outstanding variable debt using settlement token
3. Withdraw remaining aToken collateral
4. If withdrawn asset ≠ settlement token: swap back to settlement token
5. Repay flash loan

---

### Administrative Functions (Owner Only)

| Function | Description |
|----------|-------------|
| `setOwner(address)` | Transfers guard ownership |
| `setDefaultSlippageBps(uint256)` | Sets default slippage tolerance in basis points (default: 70 bps = 0.70%) |
| `setFlashAmountBufferBps(uint256)` | Sets flash loan size buffer (default: 40 bps) |
| `setUniV3Fee(address, address, uint24)` | Sets Uniswap V3 pool fee tier for an asset pair |
| `setUniV3PathExactIn(address, address, bytes)` | Sets encoded multi-hop swap path (exact input) |
| `setUniV3PathExactOut(address, address, bytes)` | Sets encoded multi-hop swap path (exact output) |

---

### `removeAssetCheck`

```solidity
function removeAssetCheck(address pool, address asset) external view
```

Reverts if the vault has any non-zero Aave V3 collateral or debt position. The position must be fully closed before the asset can be removed from the vault's supported list.

---

## Configuration Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `defaultSlippageBps` | 70 | Slippage tolerance for Uniswap swaps during unwind (basis points) |
| `flashAmountBufferBps` | 40 | Extra buffer on flash loan size to cover Uniswap fees |
| Settlement token | Configurable | Preferred token for debt repayment when multiple debt types exist |
| `approveReset` | false | Whether to reset token approval to 0 before setting (for USDT-like tokens) |

---

## Access Control

| Role | Permissions |
|------|------------|
| Owner | Configuration: slippage, swap paths, buffers |
| PoolLogic | Calls `withdrawProcessing()` and `flashloanProcessing()` |

---

## Slippage Protection

The guard computes minimum acceptable output amounts for all Uniswap V3 swaps using oracle prices with a `defaultSlippageBps` tolerance:

```
minAmountOut = oracleExpected × (10000 - slippageBps) / 10000
```

This protects against sandwich attacks during complex position unwinding.
