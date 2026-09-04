# MorphoBlueLendingPoolAssetGuard

**Source:** `contracts/contracts/guards/assetGuards/MorphoBlueLendingPoolAssetGuard.sol`
**Asset Type:** `1` (Morpho Blue position) — see [Governance's Asset Type Registry](Governance.md#asset-type-registry) for the on-chain-verified mapping (CertiK FNA-33)

---

## Overview

Manages valuation and withdrawal of the pool's aggregate Morpho Blue exposure across every market tracked for it (via [MorphoBlueManager](MorphoBlueManager.md)'s `trackedPoolMarkets`, CertiK FNA-52). Unlike Aave V3 (one shared lending pool with pooled reserves), each Morpho Blue market is an isolated pair — this guard sums net USD exposure (collateral + supply − debt) across every tracked market, and for a position carrying debt, orchestrates a single Morpho-native flashloan bundling *every* market's unwind together, not one flashloan per market. Most of the actual balance/deficit/withdrawal-planning arithmetic lives in shared libraries — `MorphoCollectLib`, `MorphoChecksLib`, `MorphoMathLib` — that this guard calls into rather than duplicating.

---

## Guard Markers Implemented

| Interface | Meaning |
|-----------|---------|
| `ISlippageCheckingGuard` | Marks this guard as one whose swaps should be checked against `SlippageAccumulator` |
| `IPreValuedAssetGuard` | `getBalance()` returns a fully priced USD-18 figure; `getUnitPrice()` reverts unconditionally (CertiK FNA-45 follow-up) — the registered "asset" (the Morpho Blue singleton address) has no meaningful per-unit price |
| `IDeficitReportingGuard` | `getDeficit()` reports the aggregate underwater shortfall across tracked markets for aggregate NAV subtraction (CertiK FNA-54) |
| `IWithdrawableBalanceGuard` | `getWithdrawableBalance()` caps the immediate-withdrawal figure by real per-market supply liquidity (CertiK FNA-07 follow-up) |

Unlike [AaveLendingPoolAssetGuard](AaveLendingPoolAssetGuard.md), this guard does **not** implement `IUnwindCostAwareGuard` — there is no cost-haircut layer for flashloan/swap unwind costs here yet; `getWithdrawableBalance()` scales the plain gross `getBalance()` figure, not a net-of-unwind-cost one. This is a documented, un-filed gap, not something this guard's own docs claim to have closed.

---

## Functions

### `getBalance` / `getDeficit` (CertiK FNA-54)

```solidity
function getBalance(address pool, address) public view override returns (uint256 balanceUsd18)
function getDeficit(address pool, address) external view override returns (uint256 deficitUsd18)
```

Both delegate to `MorphoCollectLib.getBalance()`/`getDeficit()`, which sum `collateral + supply − debt` per tracked market and either clamp the aggregate at 0 (`getBalance`) or report the aggregate shortfall (`getDeficit`) when debt exceeds collateral+supply. An underwater position is a real liability, not a zero-value asset — `getBalance()` must still clamp (every NAV consumer sums non-negative `uint256`s), but that silently *omits* the shortfall instead of *subtracting* it from the rest of the pool's positive balances; aggregate NAV/withdrawal-sizing consumers sum `getDeficit()` alongside the gross positive total and subtract it (floored at 0).

### `getUnitPrice` (CertiK FNA-45 follow-up)

```solidity
function getUnitPrice(address) external pure override returns (uint256)
```

Reverts unconditionally, same rationale as [AaveLendingPoolAssetGuard.getUnitPrice()](AaveLendingPoolAssetGuard.md#getunitprice-certik-fna-45-follow-up) — the registered "asset" is the Morpho Blue singleton itself, not a real per-unit-priceable token.

### `getWithdrawableBalance` / `_maxSafePortion` (CertiK FNA-07 follow-up)

```solidity
function getWithdrawableBalance(address pool, address asset) external view override returns (uint256 balanceUsd18)
```

`getBalance() * maxSafePortion / 1e18`. `_maxSafePortion()` only iterates the **supply** leg across tracked markets — confirmed against Morpho Blue's real source that `withdraw()` (supply) requires `totalBorrowAssets <= totalSupplyAssets` post-withdrawal (genuinely liquidity-constrained by other users' borrowing), while `withdrawCollateral()` has **no** such cross-user check, since Morpho Blue collateral is isolated per-position, never pooled. Only the supply leg can ever constrain this ceiling — but the resulting ceiling is still applied *uniformly* to debt repayment and collateral withdrawal too: this guard bundles every tracked market's unwind into **one** flashloan whenever any debt exists, repaid entirely from swapping back everything withdrawn (collateral **and** supply together) — a supply-only shortfall on one unrelated market could under-fund that same shared flashloan's repayment if a different market's debt/collateral sizing were left at the full, uncapped portion.

> **Documented residual risk (not fixed)**: same shape as [AaveLendingPoolAssetGuard's own note](AaveLendingPoolAssetGuard.md#getwithdrawablebalance--_maxsafeportion-certik-fna-07-follow-up) — Morpho Blue's `supply()` lets anyone permissionlessly credit supply shares to an arbitrary `onBehalf`, so a third party could donate a tiny supply position onto a near-fully-utilized tracked market (including a delisted-but-still-tracked one, per FNA-51), zeroing this guard's contribution to *immediate* withdrawals until cleared. A size-based dust tolerance would not meaningfully help; the queued withdrawal path never consults this cap; the manager can clear donated dust directly via a plain `execTransaction` call at any time. Left as accepted residual risk.

### `withdrawProcessing`

```solidity
function withdrawProcessing(address pool, address, uint256 withdrawPortion, address to) external view override returns (address, uint256, MultiTransaction[] memory txs)
```

1. Clamps `withdrawPortion` down to `_maxSafePortion()` (recomputed against live state).
2. Collects per-market debt/supply/collateral plans via `MorphoCollectLib`.
3. No debt (`hasDebt == false`): direct `withdraw()`/`withdrawCollateral()` calls per market, proportional to the (clamped) portion.
4. Debt exists: encodes a single `Morpho.flashLoan()` call for a chosen settlement token, sized via `_estimateFlashAmount()`; the actual multi-market unwind happens inside the flashloan callback.

Unlike [AaveLendingPoolAssetGuard](AaveLendingPoolAssetGuard.md), this function does **not** implement the FNA-36-style pre-flight "does collateral at this portion cover the flashloan repayment" solvency check before committing to the flashloan plan.

### `flashloanProcessing`

```solidity
function flashloanProcessing(address pool, address repayAsset, uint256 repayAmount, bytes calldata params) external view override returns (MultiTransaction[] memory out)
```

Callback handler for `PoolLogic.onMorphoFlashLoan()`. Sequence: (1) swap settlement token into each debt market's loan token where needed (`_swapSettlementToDebts`), (2) approve Morpho for every unique loan token's aggregated repay amount (`_approveMorphoForAllDebts`), (3) repay all debts by share (`_repayDebts`), (4) withdraw all supply and collateral across every market (`_withdrawAllAssets`), (5) swap withdrawn assets back to the settlement token where needed (`_swapAssetsToSettlement`), (6) approve the flashloan repayment.

### `_swapSettlementToDebts` — exact-output repay sizing (CertiK FNA-57)

```solidity
function _swapSettlementToDebts(address pool, FlashloanParams memory fp) internal view returns (MultiTransaction[] memory txs)
```

Buys exactly `toAssetsUp(repayBorrowShares, totalBorrowAssets, totalBorrowShares)` of each debt market's loan token via `exactOutputSingle` — matching precisely what `_repayDebts()` actually consumes (`repay(..., shares: repayBorrowShares, ...)`, an unbuffered, share-based repay). Previously this purchase amount was run through `_bufferedRepay()` (the same buffer `_estimateFlashAmount()` applies when sizing how much settlement token to *borrow*), which bought strictly more debt token than the unbuffered repay call ever consumed — the surplus wasn't swept back anywhere (`_withdrawAllAssets()` only collects supply/collateral legs, never a leftover debt-token balance), so it sat as idle pool balance benefiting remaining holders instead of the withdrawing one, by roughly `repayDebtBufferBps` of the cross-token debt leg on every such withdrawal. Fixed by removing the buffer from this specific purchase amount only — `_estimateFlashAmount()`'s own flashloan-sizing buffer and `oracleMaxIn()`'s slippage tolerance on the settlement-token spend side are untouched and still provide the swap's real safety margin.

### `_approveMorphoForAllDebts` — buffered repay approval

Unlike the exact-output *purchase* in `_swapSettlementToDebts` (unbuffered, per FNA-57), the ERC-20 *approval* Morpho is given for each aggregated loan token still applies `_bufferedRepay()` — a defensive over-approval, not an over-purchase, so it doesn't reintroduce FNA-57's residue problem: `repay()` only ever pulls exactly `repayBorrowShares`' worth of assets regardless of how large the approval is.

### `removeAssetCheck` / `removeTokenCheck`

Both delegate to `MorphoChecksLib.removeAssetCheck()`/`removeTokenCheck()` — requires the pool to hold zero collateral, supply, and debt across every tracked market (`removeAssetCheck`) or for the specific token being checked (`removeTokenCheck`).

### Administrative Functions (Owner Only)

| Function | Description |
|----------|-------------|
| `setUniV3Fee(address, address, uint24)` | Single-hop fee tier for a token pair — must be exactly 500/3000/10000 |
| `setDefaultSlippageBps(uint256)` | Slippage tolerance in basis points (default: 70 bps) |
| `setFlashAmountBufferBps(uint256)` | Flashloan size buffer (default: 40 bps) |
| `setRepayDebtBufferBps(uint256)` | Approval-only buffer applied by `_approveMorphoForAllDebts` (default: 20 bps) — **not** applied to the exact-output purchase amount since CertiK FNA-57 |
| `setRequiresApproveReset(address, bool)` | Marks a token as needing `approve(0)` before a non-zero approval (USDT-like tokens) |

---

## Configuration Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `defaultSlippageBps` | 70 | Slippage tolerance for Uniswap swaps during unwind |
| `flashAmountBufferBps` | 40 | Extra buffer on flashloan size to cover swap costs |
| `repayDebtBufferBps` | 20 | Buffer applied only to Morpho approval amounts, not purchase amounts (CertiK FNA-57) |
| `morpho` / `morphoManager` / `swapRouter` / `preferredSettlementAsset` | constructor (immutable) | Core protocol references |

---

## Access Control

| Role | Permissions |
|------|------------|
| Owner | Configuration: slippage, fee tiers, buffers, approve-reset flags |
| PoolLogic | Calls `withdrawProcessing()` and `flashloanProcessing()` |

---

## Related

- [MorphoBlueContractGuard](MorphoBlueContractGuard.md) — validates the manager-directed `execTransaction()` calls that create the positions this guard values/unwinds
- [MorphoBlueManager](MorphoBlueManager.md) — the tracked-market set (`getTrackedPoolMarkets`) this guard iterates for every aggregate operation
- [AaveLendingPoolAssetGuard](AaveLendingPoolAssetGuard.md) — the structurally analogous leveraged-lending asset guard for Aave V3, which additionally implements `IUnwindCostAwareGuard`
- [FundCalculationLibrary](FundCalculationLibrary.md) — the consumer of `IDeficitReportingGuard`/`IWithdrawableBalanceGuard` for NAV and withdrawal sizing
