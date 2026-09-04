# AaveLendingPoolAssetGuard

**Source:** `contracts/contracts/guards/assetGuards/AaveLendingPoolAssetGuard.sol` (contract name: `AaveV3LendingPoolAssetGuard`)
**Asset Type:** `2` (Aave V3 lending position) — see [Governance's Asset Type Registry](Governance.md#asset-type-registry) for the on-chain-verified mapping (CertiK FNA-33)

---

## Overview

Manages valuation and withdrawal of Aave V3 leveraged positions held by the pool — the only integration in this codebase where withdrawal can involve real debt and a flashloan-funded unwind. Computes the net USD value of the position (collateral minus debt across every supported reserve) and, for a position carrying debt, orchestrates an Aave flashloan to repay debt before releasing collateral. The guard's own "asset" is a non-transferable pseudo-position (the Aave lending pool address itself), not a real token — see `getUnitPrice()` below.

---

## Guard Markers Implemented

| Interface | Meaning |
|-----------|---------|
| `ISlippageCheckingGuard` | Marks this guard as one whose swaps should be checked against `SlippageAccumulator` |
| `IPreValuedAssetGuard` | `getBalance()` returns a fully priced USD-18 figure; `getUnitPrice()` reverts unconditionally (CertiK FNA-45 follow-up) — the registered "asset" has no meaningful per-unit price |
| `IUnwindCostAwareGuard` | `getNetRealizableBalance()` substitutes for `getBalance()` when sizing NAV for the withdrawal solvency haircut (CertiK FNA-35) |
| `IDeficitReportingGuard` | `getDeficit()` reports an underwater position's shortfall for aggregate NAV subtraction (CertiK FNA-54) |
| `IWithdrawableBalanceGuard` | `getWithdrawableBalance()` caps the immediate-withdrawal figure by real Aave reserve liquidity (CertiK FNA-07 follow-up) |

---

## Functions

### `getBalance`

```solidity
function getBalance(address pool, address) public view override returns (uint256 balance)
```

`max(totalCollateralUsd - totalDebtUsd, 0)` — sums aToken and variable-debt-token balances across every supported reserve via `_getBalance()`. Only ever variable debt; stable-rate borrowing is not modeled as a *gross-balance* contributor (see `_collectDebtPlans()`, which does still discover both).

### `getDeficit` (CertiK FNA-54)

```solidity
function getDeficit(address pool, address) external view override returns (uint256 deficit)
```

`max(totalDebtUsd - totalCollateralUsd, 0)` — the mirror image of `getBalance()`. An underwater position (debt exceeds collateral) is a real liability, not a zero-value asset: `getBalance()` must still clamp at 0 (every NAV consumer sums non-negative `uint256`s), but that silently *omits* the shortfall instead of *subtracting* it from the rest of the pool's positive balances — including the borrowed tokens this exact position produced, which the pool still holds as a separately-counted balance. Aggregate NAV/withdrawal-sizing consumers sum this alongside the gross positive total and subtract it (floored at 0).

### `getNetRealizableBalance` / `_netRealizableBalance` (CertiK FNA-35, FNA-35 follow-up)

```solidity
function getNetRealizableBalance(address pool, address) external view override returns (uint256 balance)
```

`getBalance()`'s gross collateral-minus-debt figure minus a conservative estimate of what a full unwind actually costs: the settlement↔debt swaps' oracle-based slippage tolerance, the configured flash-amount buffer, and Aave's own flashloan premium — none of which the gross figure reflects. Without debt, gross equity is already net-realizable.

> **FNA-35 follow-up**: previously only deducted the flashloan premium, leaving the route fee, oracle slippage tolerance, and `flashAmountBufferBps` (all baked into `flashAmount`'s own sizing) unaccounted for — small for a same-asset debt position, but silently ignoring the *entire* swap cost for a cross-asset one, exactly the gap CertiK's PoC demonstrated. Fixed by pricing the *whole* flashloan outlay (`flashAmount + premium`, in settlement-token terms) and comparing it against `totalDebtInUsd` directly, rather than isolating each cost component separately (fragile against future changes to `_estimateFlashAmountInSettlement`'s sizing).

### `getWithdrawableBalance` / `_maxSafePortion` (CertiK FNA-07 follow-up)

```solidity
function getWithdrawableBalance(address pool, address) external view override returns (uint256 balanceUsd18)
```

`netRealizableBalance * maxSafePortion / 1e18`. `_maxSafePortion()` computes the single largest portion (≤100%) safe to apply *uniformly* across every reserve's collateral withdrawal and debt repayment — not a per-reserve independent cap, since debt repayment and collateral withdrawal are scaled by the *same* `withdrawPortion` to keep health factor unchanged across a partial exit, and the flashloan is funded entirely by swapping withdrawn collateral back to the settlement token. A per-reserve cap risks under-funding the flashloan for a worse, harder-to-diagnose revert than the plain liquidity revert this fix avoids. Computed from `IERC20Extended(underlying).balanceOf(aToken)` — confirmed against Aave V3's real source (`AToken.burn()`) that a reserve's aToken pays a withdrawal out of its own raw underlying balance, so this is exactly what a `withdraw()` call can pay out right now.

> **Documented residual risk (not fixed)**: since the ceiling is shared across every reserve and an aToken is a plain transferable ERC-20, a third party could permissionlessly donate a tiny aToken balance for a reserve the pool never actually chose to supply to, timed while that reserve's real Aave market is near-fully-utilized — zeroing this guard's contribution to *immediate* withdrawals until cleared. A raw-balance dust tolerance would not meaningfully close this (the binding constraint is a liquidity *ratio*, not an absolute balance). Left as accepted residual risk: low severity (only the immediate withdrawal path is affected; queued withdrawal never consults this at all), and the manager can clear donated dust directly via `execTransaction` at any time.

### `getUnitPrice` (CertiK FNA-45 follow-up)

```solidity
function getUnitPrice(address) external pure override returns (uint256)
```

Reverts unconditionally (`"no unit price for pseudo-asset"`). This guard's registered "asset" is the Aave lending pool address itself — a non-transferable pseudo-position, not a real ERC-20 with a meaningful per-unit price — so `PoolManagerLogic.getAssetPrice()`'s `IPreValuedAssetGuard` dispatch must fail closed here rather than silently return a meaningless identity price.

### `withdrawProcessing`

```solidity
function withdrawProcessing(address pool, address, uint256 withdrawPortion, address to) external view override returns (address withdrawAsset, uint256 withdrawBalance, MultiTransaction[] memory transactions)
```

1. Clamps `withdrawPortion` down to `_maxSafePortion()` if smaller (CertiK FNA-07 follow-up — recomputed here rather than trusting the caller, so this stays correct against live on-chain state even if `getWithdrawableBalance()`'s NAV-time snapshot has since moved).
2. No debt: encodes direct `withdraw()` + `transfer()` calls proportional to the (clamped) portion, returned inline.
3. With debt: verifies the collateral being freed at this portion actually covers the full flashloan repayment obligation (**CertiK FNA-36 follow-up**, below) — if not, returns an empty transaction set (fails closed for this asset only) rather than planning an unwind that would revert the *entire* pro-rata withdrawal, including every other healthy asset's share. Otherwise encodes a single flashloan-initiation transaction; the actual debt repayment and collateral withdrawal happen inside the flashloan callback.

> **CertiK FNA-36 follow-up**: `getWithdrawableBalance()`/`_netRealizableBalance()` only gate whether the *100%*-position net-realizable value is zero — a thin-but-positive 100% position doesn't guarantee this specific `effectivePortion` (already possibly below the caller's request via the FNA-07 cap) is itself solvent once rounding, route fee/slippage, and the flash buffer all apply to *this portion's* own repay amounts. The added check compares collateral value at this portion directly against the total flashloan outlay.

### `flashloanProcessing`

```solidity
function flashloanProcessing(address pool, address repayAsset, uint256 repayAmount, uint256 premium, bytes calldata params) external view override returns (MultiTransaction[] memory transactions)
```

Flashloan callback handler, invoked via `PoolLogic.executeOperation()`. Execution sequence: (1) swap collateral to settlement token where needed, (2) repay outstanding debt (stable + variable, per reserve) using settlement token, (3) withdraw remaining collateral, (4) swap withdrawn collateral back to settlement token where needed, (5) approve the flashloan repayment (`repayAmount + premium`).

### `removeAssetCheck` / `removeTokenCheck`

Both revert/return-false unless the position is fully empty: `removeAssetCheck` requires zero collateral **and** zero debt across every reserve; `removeTokenCheck` requires zero collateral **and** zero debt for the specific `token` being checked.

### Administrative Functions (Owner Only)

| Function | Description |
|----------|-------------|
| `setOwner(address)` | Transfers guard ownership |
| `setDefaultSlippageBps(uint256)` | Slippage tolerance in basis points, capped at 2,000 (default: 70 bps = 0.70%) |
| `setFlashAmountBufferBps(uint256)` | Flash loan size buffer, capped at 500 bps (default: 40 bps) |
| `setUniV3Fee(address, address, uint24)` | Single-hop fallback fee tier for a token pair |
| `setUniV3PathExactIn(address, address, bytes)` | Multi-hop swap path (exact input, collateral→settlement) |
| `setUniV3PathExactOut(address, address, bytes)` | Multi-hop swap path (exact output, settlement→debt, encoded in Uniswap's reversed form) |
| `setRequiresApproveReset(address, bool)` | Marks a token as needing `approve(0)` before a non-zero approval (USDT-like tokens) |

### Route-Derived Swap Fees (CertiK FNA-29)

`_routeFeeCollateralToSettlement`/`_routeFeeSettlementToDebt` derive the fee bound used for oracle-based `minOut`/`maxIn` sizing from whichever route is actually configured (multi-hop path if set, decoded via `_decodeUniV3Path`'s multiplicative fee-compounding across hops; single-hop fallback fee otherwise) — not an unconditional single-hop fallback fee regardless of the route actually executed. Shared by both the flash-amount estimate and the actual swap builder, so the loan is always sized against the same fee the swap it funds will be bound by.

### Slippage Bound Composition (CertiK FNA-49)

`_effectiveSlippageExactIn`/`_effectiveSlippageExactOut` compose (add) the configured tolerance with the pool-fee floor rather than taking the max of the two — the previous max()-based helper collapsed to just the fee floor whenever it exceeded the configured tolerance, leaving almost no real headroom on a high-fee-tier settlement swap, exactly where a legitimate settlement is most likely to revert. `_effectiveSlippageExactIn` uses the direct fee fraction; `_effectiveSlippageExactOut` uses the gross-up form (`fee / (1 - fee)`) — the two are not interchangeable, since receiving a fixed output after a fee cut requires proportionally more input than paying a flat fee on a fixed input does.

---

## Configuration Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `defaultSlippageBps` | 70 | Slippage tolerance for Uniswap swaps during unwind (basis points) |
| `flashAmountBufferBps` | 40 | Extra buffer on flash loan size to cover swap costs |
| `preferredSettlementAsset` | constructor (immutable) | Fallback settlement token when repay plans span multiple distinct debt assets |
| `requiresApproveReset` | per-token, owner-settable | Whether a token needs `approve(0)` before a non-zero approval (USDT-like tokens) |

---

## Access Control

| Role | Permissions |
|------|------------|
| Owner | Configuration: slippage, swap paths/fees, buffers, approve-reset flags |
| PoolLogic | Calls `withdrawProcessing()` and `flashloanProcessing()` |

---

## Documented Invariant: Debt Discovery Scope

`_collectDebtPlans()` only scans debt for reserves returned by `PoolManagerLogic.getSupportedAssets()` — the protocol must enforce that the pool never borrows an asset outside its own supported-assets list, or that debt would be invisible to this guard's repayment planning during a withdrawal, leading to incomplete debt repayment.

---

## Related

- [AaveLendingPoolGuardV3](AaveLendingPoolGuardV3.md) — the paired contract guard authorizing manager-directed supply/borrow/repay calls
- [SlippageAccumulator](SlippageAccumulator.md) — consulted via `ISlippageCheckingGuard` for the swaps this guard executes during unwind
- [FundCalculationLibrary](FundCalculationLibrary.md) — the consumer of `IDeficitReportingGuard`/`IUnwindCostAwareGuard`/`IWithdrawableBalanceGuard` for NAV and withdrawal sizing
