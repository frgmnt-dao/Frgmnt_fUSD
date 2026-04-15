# UniswapV3AssetGuard

**Source:** `contracts/contracts/guards/assetGuards/UniswapV3AssetGuard.sol`
**Asset Type:** `7` (Uniswap V3 LP NFT)

---

## Overview

UniswapV3AssetGuard manages the valuation and withdrawal of Uniswap V3 liquidity provider NFT positions held in the vault. It uses TWAP-based pricing to resist manipulation, and generates proportional liquidity removal and fee collection transactions during withdrawals.

---

## Responsibilities

- Compute the total USD value of all Uniswap V3 LP NFT positions held by the vault
- Generate safe withdrawal transactions (decrease liquidity + collect fees)
- Apply TWAP pricing to resist spot price manipulation during valuation
- Enforce slippage protection on liquidity removal
- Prevent asset removal while LP positions remain open

---

## Functions

### `getBalance`

```solidity
function getBalance(address pool, address asset) external view returns (uint256)
```

Returns the total USD value of all Uniswap V3 LP NFTs held by the vault.

**Valuation approach:**
1. Enumerate all NFT positions owned by the vault
2. For each position, compute principal amounts from current liquidity and tick range using `LiquidityAmounts`
3. Add uncollected fees using on-chain fee growth data
4. Price all token amounts using TWAP from `UniswapV3PriceLibrary`
5. Convert to USD via AssetHandler price feeds

```
positionValue = (amount0 + fees0) × price0USD
              + (amount1 + fees1) × price1USD
```

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

Generates a two-step withdrawal per NFT position:

1. **`decreaseLiquidity`** — removes `portion` of current liquidity, with slippage-protected minimum amounts derived from TWAP prices
2. **`collect`** — collects both principal tokens and proportional accumulated fees to `to`

Applies to every NFT position in the vault.

---

### `removeAssetCheck`

```solidity
function removeAssetCheck(address pool, address asset) external view
```

Reverts if the vault holds any Uniswap V3 NFT positions. All LP positions must be fully closed before the asset type can be removed.

---

### Administrative Functions (Owner Only)

| Function | Description |
|----------|-------------|
| `setAdmin(address)` | Transfers guard admin |
| `setWithdrawalSlippageBps(uint256)` | Sets slippage tolerance for liquidity removal (default: 100 bps = 1%) |
| `setWithdrawalTwapWindow(uint32)` | Sets TWAP observation window in seconds |

---

## Slippage Protection

Minimum withdrawal amounts are derived from TWAP prices:

```
minAmount0 = twapAmount0 × (10000 - slippageBps) / 10000
minAmount1 = twapAmount1 × (10000 - slippageBps) / 10000
```

This ensures the vault cannot be manipulated into accepting less than expected from liquidity removal.

---

## TWAP vs. Spot Price

The guard uses TWAP (time-weighted average price) rather than the Uniswap V3 spot price for both valuation and minimum output calculation. This protects against:
- Single-block price manipulation by large traders
- Flash loan-based pool state manipulation before a vault withdrawal

The TWAP window is configurable (default set at deployment).

---

## Access Control

| Role | Permissions |
|------|------------|
| Admin | Configure slippage tolerance and TWAP window |
| PoolLogic | Call `withdrawProcessing()` during pro-rata withdrawals |
