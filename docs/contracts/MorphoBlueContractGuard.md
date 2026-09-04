# MorphoBlueContractGuard

**Source:** `contracts/contracts/guards/contractGuards/MorphoBlueContractGuard.sol`
**Registered in Governance against:** the Morpho Blue core singleton

---

## Overview

Validates manager/trader-initiated Morpho Blue operations (`supply`/`withdraw`/`borrow`/`repay`/`supplyCollateral`/`withdrawCollateral`/`liquidate`) executed through `PoolLogic.execTransaction()`, and enforces a post-transaction health-factor check via `afterTxGuard` (`isTxTrackingGuard = true`). Every operation requires the Morpho Blue core to be a registered supported asset (`isSupportedAsset(to)`).

---

## The Active/Tracked Split (CertiK FNA-52)

The `MorphoBlueManager` market allowlist check differs by **direction**:

- **Entry-side** operations (`_handleSupply`, `_handleBorrow`, `_handleSupplyCollateral`, `_handleLiquidate`) require the market to be in the protocol owner's **active** allowlist (`isValidPoolMarket`) — new exposure (more supply, more debt, more collateral, or an opportunistic liquidation of someone else's position) may only go into markets currently sanctioned by governance.
- **Exit-side** operations (`_handleWithdraw`, `_handleRepay`, `_handleWithdrawCollateral`) require only that the market be **tracked** (`isTrackedPoolMarket`), a superset that also includes markets the protocol owner has since delisted.

Gating exit-side operations on the active allowlist too — as a single shared check once did — would mean a delisted market's debt could never be repaid nor its supply/collateral withdrawn through this manual `execTransaction` path, contradicting [MorphoBlueLendingPoolAssetGuard](MorphoBlueLendingPoolAssetGuard.md)'s own valuation and debt/withdrawal-planning functions (which already read the tracked set) and leaving the position stuck until governance re-adds the market. See [MorphoBlueManager](MorphoBlueManager.md)'s own documentation for why tracked/active are governed by two separate mappings.

---

## Functions

### `txGuard`

```solidity
function txGuard(address poolManagerLogic, address to, bytes calldata data) public override returns (uint16 txType, bool isPublic)
```

| Selector | Handler | Market allowlist gate | Additional checks |
|----------|---------|-------------------------|---------------------|
| `supply` | `_handleSupply` | **active** | `loanToken` supported; `onBehalf == pool` |
| `withdraw` | `_handleWithdraw` | **tracked** | `loanToken` supported; `onBehalf == pool`; `receiver == pool` |
| `borrow` | `_handleBorrow` | **active** | `loanToken` **and** `collateralToken` supported (CertiK FNA-31, below); `onBehalf == pool`; `receiver == pool` |
| `repay` | `_handleRepay` | **tracked** | `loanToken` supported; `onBehalf == pool` |
| `supplyCollateral` | `_handleSupplyCollateral` | **active** | `collateralToken` supported; `onBehalf == pool` |
| `withdrawCollateral` | `_handleWithdrawCollateral` | **tracked** | `collateralToken` supported; `onBehalf == pool`; `receiver == pool` |
| `liquidate` | `_handleLiquidate` | **active** | `loanToken` **and** `collateralToken` supported; `borrower != address(0)` |

Any other selector falls through to `TransactionType.NotUsed`.

### `_handleBorrow`'s collateral check (CertiK FNA-31)

Every other collateral-touching handler here already required `collateralToken` to be pool-supported; `borrow` was the one omission. Morpho Blue's `supplyCollateral()` is permissionlessly callable by *anyone* for an arbitrary `onBehalf`, entirely outside this guard (no `execTransaction` involved) — so an approved market's collateral leg can carry real balance without ever having passed a pool-level support check. Without this fix, a manager/trader could still borrow a supported `loanToken` against unsupported collateral: `MorphoCollectLib` omits unsupported collateral from NAV and withdrawal planning while continuing to account for the (supported) debt, and `afterTxGuard`'s health-factor check reads the collateral's price from the protocol-wide `AssetHandler` registry regardless of pool-level support — so neither existing safeguard would have caught it.

### `afterTxGuard`

```solidity
function afterTxGuard(address poolManagerLogic, address to, bytes calldata data) public view override
```

Only checked for `withdrawCollateral` and `borrow` — the two operations that can reduce collateral or increase debt. Decodes the market params from calldata, reads the pool's live `Position`, and — only if `borrowShares > 0` — computes `healthFactor = (collateralValue * lltv) / borrowedValue` using `SharesMathLib.toAssetsUp()` for the live borrow-share-to-assets conversion, requiring `healthFactor > 1.01e18` (matching [AaveLendingPoolGuardV3](AaveLendingPoolGuardV3.md)'s own threshold). A position with no outstanding debt skips the check entirely — there is nothing to become undercollateralized.

---

## Configuration

| Parameter | Set at | Description |
|-----------|--------|-------------|
| `morphoManager` | constructor (immutable) | The [MorphoBlueManager](MorphoBlueManager.md) allowlist consulted for every market check |

Stateless, immutable-configured contract — no owner-settable parameters.

---

## Related

- [MorphoBlueManager](MorphoBlueManager.md) — the active/tracked market allowlist this guard reads
- [MorphoBlueLendingPoolAssetGuard](MorphoBlueLendingPoolAssetGuard.md) — the automatic pro-rata withdrawal/valuation path for the positions this guard's calls create
- [AaveLendingPoolGuardV3](AaveLendingPoolGuardV3.md) — the structurally analogous leveraged-lending contract guard for Aave V3
