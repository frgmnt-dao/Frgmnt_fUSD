# UniswapV3AssetGuard

**Source:** `contracts/contracts/guards/assetGuards/UniswapV3AssetGuard.sol`
**Asset Type:** `3` (Uniswap V3 LP NFT) — see [Governance's Asset Type Registry](Governance.md#asset-type-registry) for the on-chain-verified mapping (CertiK FNA-33)

---

## Overview

UniswapV3AssetGuard manages the valuation and withdrawal of Uniswap V3 LP NFT positions tracked by [UniswapV3NonfungiblePositionGuard](UniswapV3NonfungiblePositionGuard.md). It uses TWAP-based pricing (via `UniswapV3PriceLibrary`) to resist manipulation, and generates proportional liquidity-removal-plus-fee-collection transactions during withdrawals. The registered "asset" is the `NonfungiblePositionManager` singleton itself, not any one NFT — this guard enumerates every `tokenId` the paired contract guard's tracker reports for the pool.

---

## Guard Markers Implemented

| Interface | Meaning |
|-----------|---------|
| `IPreValuedAssetGuard` | `getBalance()` returns a fully priced USD-18 figure; `getUnitPrice()` reverts unconditionally (CertiK FNA-45 follow-up) — the registered "asset" has no meaningful per-unit price |
| `IIncompleteValuationGuard` | `isValuationComplete()` reports whether every owned NFT's pool spot price was inside the fair-price band as of `getBalance()`'s own last read (CertiK FNA-37) |

---

## Functions

### `getBalance` / `isValuationComplete` / `_valuePositions` (CertiK FNA-37)

```solidity
function getBalance(address pool, address asset) public view override returns (uint256 balance)
function isValuationComplete(address pool, address asset) external view override returns (bool complete)
```

Both delegate to the shared `_valuePositions()`, which iterates every tracked `tokenId`: skips (contributes 0, no revert) any NFT whose underlying `token0`/`token1` isn't a supported asset; checks `UniswapV3PriceLibrary.isFairPrice()` against each remaining NFT's own pool, and — if the spot price is **outside** the fair band — skips that position too and sets `complete = false`, rather than reverting the whole call.

> **CertiK FNA-37**: previously, an out-of-band spot price on even one tracked position's own pool would revert the entire `getBalance()` call via `assertFairPrice()` — an external trader can cheaply push a single position's Uniswap V3 pool spot price outside the Chainlink-derived fair band (especially for a thin or non-mainstream pool), freezing stake/unstake/harvest/immediate-withdraw for the **entire** pool over one manipulable position. Degrading just the affected position to a 0 contribution (mirroring the pre-existing unsupported-token skip) and reporting the degradation via `complete` lets `PoolManagerLogic.totalFundValueWithCompleteness()` tell a genuinely-empty position apart from a temporarily-unpriceable one — the same fail-open-with-a-flag pattern used throughout this codebase's `IIncompleteValuationGuard` guards.

### `getUnitPrice` (CertiK FNA-45 follow-up)

```solidity
function getUnitPrice(address) external pure override returns (uint256)
```

Reverts unconditionally — same rationale as [AaveLendingPoolAssetGuard.getUnitPrice()](AaveLendingPoolAssetGuard.md#getunitprice-certik-fna-45-follow-up): the registered "asset" (the `NonfungiblePositionManager` address) is a non-transferable pseudo-position, not a real per-unit-priceable token.

### `withdrawProcessing`

```solidity
function withdrawProcessing(address pool, address asset, uint256 portion, address to) external view override returns (address, uint256, MultiTransaction[] memory)
```

For every tracked NFT: encodes `decreaseLiquidity()` (removing `portion` of current liquidity, with slippage-protected minimum amounts derived from TWAP prices) followed by `collect()` (both principal tokens plus proportional accumulated fees, sent to `to`).

### `removeAssetCheck` (CertiK FNA-48)

```solidity
function removeAssetCheck(address pool, address asset) public view override
```

Blocks removing the position manager from `supportedAssets` while **any** Uniswap V3 NFT position remains tracked for the pool — even one already fully decreased and collected down to a zero balance. The inherited `ClosedAssetGuard`/`ERC20Guard`-style default only checks `getBalance() == 0`, which a fully-decreased-but-not-burned position already satisfies (the NFT is still owned by the pool and its `tokenId` still tracked in `NftTrackerStorage`, since tracker entries are only ever cleared on `burn()`). Without this fix, a manager/trader could decrease+collect a position to zero, delist the position manager via the balance-only check, and leave a live-but-untracked NFT the protocol no longer values or can safely reason about.

### TWAP Manipulation Resistance (CertiK FNA-16)

```solidity
function setMinimumPoolLiquidity(address pool, uint128 minLiquidity) external onlyAdmin
```

Sets the minimum harmonic-mean liquidity a given Uniswap V3 pool must have (over `withdrawalTwapWindow`) for its TWAP sanity-check to be trusted during a withdrawal; `0` disables the check for that pool. Same rationale as [UniV3TWAPAggregator](UniV3TWAPAggregator.md)'s own `minimumLiquidity` — a thin pool lets an attacker sustain an adverse tick over the TWAP window at reduced cost.

### Administrative Functions (Owner Only)

| Function | Description |
|----------|-------------|
| `setAdmin(address)` | Transfers guard admin |
| `setWithdrawalSlippageBps(uint256)` | Slippage tolerance for liquidity removal (default: 100 bps = 1%) |
| `setWithdrawalTwapWindow(uint32)` | TWAP observation window in seconds |
| `setMinimumPoolLiquidity(address, uint128)` | Per-pool harmonic-mean liquidity floor for the TWAP sanity check (CertiK FNA-16) |

---

## Slippage Protection

Minimum withdrawal amounts are derived from TWAP prices:

```
minAmount0 = twapAmount0 × (10000 - slippageBps) / 10000
minAmount1 = twapAmount1 × (10000 - slippageBps) / 10000
```

---

## Access Control

| Role | Permissions |
|------|------------|
| Admin | Configure slippage tolerance, TWAP window, per-pool liquidity floors |
| PoolLogic | Calls `withdrawProcessing()` during pro-rata withdrawals |

---

## Related

- [UniswapV3NonfungiblePositionGuard](UniswapV3NonfungiblePositionGuard.md) — the paired contract guard that tracks the `tokenId`s this guard enumerates, and owns the CertiK FNA-48 fix's complementary defensive check
- [UniV3TWAPAggregator](UniV3TWAPAggregator.md) — the structurally analogous CertiK FNA-16 liquidity-floor fix for price-feed TWAP consultation
