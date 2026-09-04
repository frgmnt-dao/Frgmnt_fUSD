# FundCalculationLibrary

**Source:** `contracts/contracts/utils/FundCalculationLibrary.sol`
**Kind:** stateless `library`, called via delegatecall from [PoolLogic](PoolLogic.md)

---

## Overview

Holds the bulk of PoolLogic's NAV, fee-accrual, and withdrawal-sizing arithmetic, extracted into a library specifically because `PoolLogic.sol` has essentially no remaining bytecode headroom (see the FNA-03/FNA-04 history) — moving logic here rather than inlining it is a hard deployability constraint, not a style choice. Every `external`/`public` function here is invoked from `PoolLogic` via a plain internal library call (compiled inline for `internal`/`private` helpers, or a real `DELEGATECALL`-equivalent library jump for `external`/`public` ones — Solidity libraries share the caller's storage context either way), so `address(this)`/`msg.sender` inside these functions are always the pool's own.

Two `public` (not `external`) functions — `totalValueWithCompleteness` and `guardNetRealizableBalance` — are called both from outside the library (by PoolLogic) and from within it (by other library functions); `external` functions cannot be invoked internally by name in Solidity, only via `this.foo()`, which for a library function would incorrectly resolve `this` to the delegatecalling contract rather than the library itself.

---

## NAV & Completeness

### `totalValueWithCompleteness`

```solidity
function totalValueWithCompleteness(address poolManagerLogic) public view returns (uint256 total, bool complete)
```

Reads NAV via a raw `staticcall` to `totalFundValueWithCompleteness()` rather than a typed interface call, falling back to the plain `totalFundValue()` (treated as complete) if that call fails or returns unexpected data. This is CertiK FNA-04's cross-proxy-upgrade-ordering fix: PoolLogic and PoolManagerLogic are independently upgradeable proxies on a live mainnet deployment, so a PoolLogic implementation carrying this call can be upgraded before, after, or independently of the PoolManagerLogic implementation that actually adds `totalFundValueWithCompleteness()`. A typed call would revert with no matching selector on a not-yet-upgraded PoolManagerLogic, bricking every stake/unstake/harvest the moment PoolLogic's upgrade landed. Same low-level-call-with-fallback pattern used throughout this codebase for guard-marker detection.

### `activeTotalValueWithCompleteness` (CertiK FNA-17)

```solidity
function activeTotalValueWithCompleteness(address pool, address poolManagerLogic) external view returns (uint256 total, bool complete)
```

Builds on `totalValueWithCompleteness()`'s gross figure, then subtracts the USD value of every asset's `reservedAssetBalance` (liquidity already earmarked for a finalized-but-unclaimed queued withdrawal). Necessary because `claimCashWithdraw()` runs fee/yield accrual *before* releasing a reservation — without this exclusion, any price movement on an already-fixed reserved amount between finalize and claim would be misread as pool yield and inflate `accountedAssets` against value that's about to leave in the same transaction.

---

## Yield & Fee Accrual

### `calculatePerformanceFee` / `calculateManagementFee`

Pure/view helpers: performance fee is a flat numerator/denominator cut of `totalValue - accountedAssets` (only when positive); management fee is linear-in-time, `totalFusd * numerator * dt / denominator / 365 days`.

### `computeYieldAccrual`

```solidity
function computeYieldAccrual(uint256 _totalValue, bool _navComplete, uint256 _accountedAssets, uint256 _totalFusd, uint256 _lastFeeMintTime, uint256 _performanceFeeNumerator, uint256 _managementFeeNumerator, uint256 _feeDenominator, bool _applyClamp) external view returns (uint256 performanceFee, uint256 managementFee, uint256 netYield, uint256 newAccountedAssets, uint256 newLastFeeMintTime)
```

Shared by `PoolLogic._accrueYield()` and the advisory-only `calculateAvailableManagerFee()` display path (which always passes `_navComplete=true`, `_applyClamp=false`, since it doesn't mutate state). When `_navComplete` is false, every output is a no-op (zero fees, `accountedAssets`/`lastFeeMintTime` unchanged) — deliberately does **not** revert. Reverting here would freeze stake/unstake/harvest for the whole pool over one guard's transient valuation failure; withholding *recognition* is enough to prevent a worse failure mode (a staker who enters during an outage capturing yield that economically accrued before they joined, once the dependency recovers and NAV "catches up" in one jump, distributed pro-rata against the share supply at recovery time rather than at accrual time).

---

## Loss Socialization (CertiK FNA-05)

### `applyClaimsHaircut` / `_applyClaimsHaircut`

```solidity
function applyClaimsHaircut(uint256 grossFusd, uint256 fundValue, uint256 totalClaims) external pure returns (uint256)
```

Scales `grossFusd` down by the pool's collateralization ratio (`fundValue / totalClaims`), capped so an over-collateralized pool never scales *up* — `denom = max(fundValue, totalClaims)`, `result = grossFusd * fundValue / denom`. Returns `grossFusd` unchanged whenever solvent (`fundValue >= totalClaims`). Ensures every redemption bears the same deficit ratio instead of early redeemers exiting at par while later holders absorb a larger shortfall.

### `computeImmediateWithdrawPortion`

```solidity
function computeImmediateWithdrawPortion(address pool, uint256 netFusd, uint256 withdrawableFundValue) external view returns (uint256 portion, uint256 totalClaims, uint256 completeFundValue)
```

The most heavily-revised function in this library — five separate CertiK findings (FNA-05, FNA-07 follow-up, FNA-17, FNA-32, FNA-54 follow-up) shaped its current form. Reverts `IncompleteNAV()` if the pool's overall NAV reading is incomplete. Computes the solvency haircut against a **reserved-excluding, non-liquidity-capped** NAV (`_withdrawableFundValue(..., capByLiquidity=false)`) — deliberately not against the liquidity-capped `withdrawableFundValue` parameter, so a single temporarily-illiquid lending position (self-correcting) is never confused with the pool actually being underwater (permanent, needs loss socialization). If the resulting fair share (`fairFusd`) exceeds what's actually liquid right now, returns `(0, totalClaims, completeFundValue)` rather than under-delivering — `netFusd` has already been burned by the caller, so PoolLogic's own `WithdrawAmountTooSmall` check reverts the whole atomic transaction, unwinding that burn, rather than silently shorting the user.

`portion` (CertiK FNA-54 follow-up) is sized against **gross** withdrawable assets (`withdrawableFundValue + totalDeficit`), not the deficit-adjusted NAV — `_withdrawProRataInternal()` applies `portion` to each guard's own reported balance, and no guard's `getBalance()` ever reports a *negative* balance for an underwater position (it floors to 0), so dividing `fairFusd` by the smaller, deficit-netted figure would inflate `portion` beyond what gross assets can actually support, triggering `PoolLogic`'s `InvalidFundValue()` sanity check on every immediate withdrawal while any position is underwater.

### `computeFinalizeAssetAmount`

```solidity
function computeFinalizeAssetAmount(address pool, address asset, uint256 grossFusd) external view returns (uint256 assetAmount, uint256 totalClaims, uint256 completeFundValue)
```

The queued-withdrawal analog of `computeImmediateWithdrawPortion` — same `IncompleteNAV()` revert, same haircut mechanism, but converts the haircut fUSD amount directly into a fixed `asset` amount at current price (never recalculated after finalize, so an understated NAV here is materially riskier than for an immediate withdrawal — hence the revert-not-degrade choice).

### `_activeTotalClaims` (CertiK FNA-38)

```solidity
function _activeTotalClaims(address pool) private view returns (uint256)
```

`fUSD.totalSupply() + unharvestedRewardClaim - finalizedUnclaimedFusd`. The `finalizedUnclaimedFusd` exclusion matters because a request already `Finalized`/`FinalizedEscrowed` but not yet `Claimed` has had its backing assets excluded from `fundValue` since finalize time — its still-unburned fUSD must be excluded from the claims denominator the same way, or it double-counts the same value against every other still-active claim.

---

## accountedAssets Overhang Tracking (CertiK FNA-42)

### `computeAccountedAssetsReduction` / `_computeAccountedAssetsReduction`

```solidity
function computeAccountedAssetsReduction(uint256 netFusd, uint256 totalClaimsBeforeWithdrawal, uint256 accountedAssetsBefore, uint256 valueBefore, uint256 valueDelta) external pure returns (uint256 reduction)
```

`accountedAssets` is a high-water mark: `PoolLogic._accrueYield()` only ever raises it to match a new higher NAV, never lowers it on a NAV drop, so losses stay unrecognized as an "overhang" until NAV recovers. Reducing `accountedAssets` by only the real dollars a withdrawal moved out (`valueDelta`) under-reduces it whenever an overhang exists — the exiting claim's proportional share of that overhang (`netFusd / totalClaims` of it) is realized and permanently gone the moment its fUSD is retired, but was left sitting on the books, overstating the baseline the *remaining* claims are measured against. `reduction = valueDelta + (netFusd * overhang) / totalClaims` keeps `(accountedAssets - activeNAV) / totalClaims` constant across any partial claim retirement. Shared by both the immediate withdrawal path (`computeAccountedAssetsReduction`) and the queued path (`finalizeReserveAndUpdateBaseline`, below).

---

## Withdrawable NAV (CertiK FNA-07 / FNA-54)

### `computeWithdrawableFundValue` / `_withdrawableFundValue`

```solidity
function computeWithdrawableFundValue(address pool, address poolManagerLogic) external view returns (uint256)
```

Sums each supported asset's guard-reported balance, capped where a guard implements `IWithdrawableBalanceGuard` (external liquidity cap, FNA-07) so one under-liquid lending position sizes its own share down rather than reverting the whole withdrawal. Also sums each guard's `IDeficitReportingGuard`-reported deficit (FNA-54, underwater lending debt) and nets it from the gross total before returning. The internal `_withdrawableFundValue()` returns `(grossValue, totalDeficit)` **un-netted** — separately, not pre-subtracted — because `computeImmediateWithdrawPortion()`'s portion formula specifically needs the gross figure (see above); this public wrapper nets them for callers that just want the final NAV number.

### `guardNetRealizableBalance` (CertiK FNA-35/36)

```solidity
function guardNetRealizableBalance(address pool, address asset, address guard) public view returns (uint256)
```

Checks the `IUnwindCostAwareGuard` marker; if present, returns `getNetRealizableBalance()` instead of raw `getBalance()`, so a leveraged position whose gross equity looks positive but whose net-of-unwind-cost value is fully consumed is treated the same as a genuinely zero-equity position — not just excluded from NAV, but also skipped by `PoolLogic._withdrawProcessing()`'s own per-asset portion sizing.

---

## fUSD ↔ Asset Conversion

### `fusdToAssetAmount`

Converts a fUSD (USD-18) amount into a target asset's native-decimal amount using `PoolManagerLogic.getAssetPrice()`/`.assetDecimal()`. Returns 0 if the asset isn't supported or has zero price, rather than reverting.

---

## Withdrawal Release Plumbing (CertiK FNA-03)

### `claimCashWithdrawRelease`

```solidity
function claimCashWithdrawRelease(address escrow, bool escrowed, address asset, uint256 amount, uint256 reserved) external returns (uint256 newReserved, uint256 delivered)
```

Releases a finalized queued withdrawal from wherever it actually lives — `WithdrawalEscrow` for any request finalized after the escrow was wired in, or the pool's own balance (legacy `reservedAssetBalance` bookkeeping) for one finalized before that. The non-escrowed branch measures actual balance deltas rather than trusting the nominal `amount` (CertiK FNA-23 follow-up) — a sender-fee/burn-on-transfer asset can drain more than `amount` from the pool, and decrementing `reservedAssetBalance` by only the nominal figure would leave it permanently overstated relative to the real on-chain balance.

### `finalizeReserveAndUpdateBaseline`

```solidity
function finalizeReserveAndUpdateBaseline(address poolManagerLogic, address escrow, address asset, uint256 assetAmount, uint256 netFusd, uint256 totalClaims, uint256 valueBefore, uint256 accountedAssetsBefore) external returns (uint256 newAccountedAssets)
```

Moves `assetAmount` into `WithdrawalEscrow` and reduces `accountedAssets` by the same overhang-aware formula as the immediate path (`_computeAccountedAssetsReduction`). Reverts `EscrowNotSet()` rather than silently no-op'ing through an unset escrow address and recording a claim nothing actually backs.

---

## Related

- [PoolLogic](PoolLogic.md) — the sole caller of every function in this library, via delegatecall
- [WithdrawalEscrow](WithdrawalEscrow.md) — the escrow contract `claimCashWithdrawRelease`/`finalizeReserveAndUpdateBaseline` move funds through
- [PoolManagerLogic](PoolManagerLogic.md) — source of `getAssetPrice`/`assetDecimal`/`totalFundValueWithCompleteness`/`getAssetGuard`
