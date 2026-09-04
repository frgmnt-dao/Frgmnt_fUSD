# AaveV4SpokeAssetGuard

**Source:** `contracts/contracts/guards/assetGuards/AaveV4SpokeAssetGuard.sol`
**Asset Type:** registered per deployment against `AssetHandler`/`Governance` — see [Governance's Asset Type Registry](Governance.md#asset-type-registry) for the on-chain-verified mapping.

---

## Overview

AaveV4SpokeAssetGuard values and unwinds a pool's **supply-only** position across one or more reserves of a single Aave V4 Spoke. The registered "supported asset" is the Spoke address itself — one guard instance services any number of Spokes, with a separate allowlist contract, [AaveV4SpokeManager](AaveV4SpokeManager.md), deciding which `reserveId`s within each Spoke a given pool may use.

Unlike Aave V3 ([AaveLendingPoolAssetGuard](AaveLendingPoolAssetGuard.md)) or Morpho Blue ([MorphoBlueLendingPoolAssetGuard](MorphoBlueLendingPoolAssetGuard.md)), the pool's Aave V4 Spoke position carries **no debt by design** — [AaveV4SpokeContractGuard](AaveV4SpokeContractGuard.md) simply doesn't expose any borrowing selectors. That removes the flashloan-based unwind path and health-factor risk entirely: withdrawal is a plain per-reserve `withdraw()` + `transfer()`.

A single Spoke can host reserves with *different* underlying tokens under one registered asset, so this guard cannot rely on `PoolLogic`'s single-`withdrawAsset` balance-delta tracking the way [MorphoVaultV2AssetGuard](MorphoVaultV2AssetGuard.md) does. Instead each reserve's withdrawal includes its own direct `transfer(to, amount)`, and the guard reports `withdrawAsset = address(0)` to tell `PoolLogic` funds have already been delivered.

---

## Responsibilities

- Report the pool's aggregate USD value across every **tracked** reserve of a Spoke (not just the actively-allowed ones — see [FNA-10](../security.md) tracked-set pattern)
- Cap that valuation to what's actually withdrawable right now, per reserve, against the Aave V4 Hub's real liquidity
- Build the withdrawal transaction sequence (`ISpoke.withdraw` + `transfer`) for a pro-rata exit
- Gate the one Spoke-level call a pool must make itself — `setUserPositionManager` — to exactly the two Aave-owned PositionManagers
- Enforce that every tracked reserve is closed (within a small raw-unit dust tolerance) before the Spoke can be removed from `supportedAssets`

---

## Guard Markers Implemented

| Interface | Meaning |
|-----------|---------|
| `IAddAssetCheckGuard` | `PoolManagerLogic._addAsset()` must call `addAssetCheck()` before registering a Spoke |
| `IPreValuedAssetGuard` | `getBalance()` already returns a fully priced USD-18 figure; `getUnitPrice()` reverts unconditionally — this "asset" (the Spoke address) is a non-transferable pseudo-position with no per-unit price (CertiK FNA-45/56) |
| `IIncompleteValuationGuard` | `isValuationComplete()` lets `PoolManagerLogic.totalFundValueWithCompleteness()` tell a genuinely-empty reserve apart from one that's temporarily unpriceable |
| `IWithdrawableBalanceGuard` | `getWithdrawableBalance()` is the liquidity-capped counterpart to `getBalance()`, used to size *immediate* withdrawals (CertiK FNA-07) |

---

## Functions

### `getBalance`

```solidity
function getBalance(address pool, address spoke) public view returns (uint256 balanceUsd18)
```

Sums the USD value of the pool's supplied position across every **tracked** `reserveId` for `(pool, spoke)` — tracked, not just actively-allowed, so a reserve the protocol owner has since delisted stays valued for as long as it may hold supply (see [AaveV4SpokeManager](AaveV4SpokeManager.md)). Every external call is fault-isolated per reserve: a reverting reserve contributes 0 and marks the reading incomplete, rather than reverting `getBalance()` for the whole pool.

### `getWithdrawableBalance`

```solidity
function getWithdrawableBalance(address pool, address spoke) external view returns (uint256 balanceUsd18)
```

Same aggregation as `getBalance()`, but each reserve's contribution is capped at `min(suppliedAssets, IHubBase.getAssetLiquidity(assetId))` — what the reserve could actually deliver right now. A per-call `HubLiquidityLedger` dedupes Hub liquidity across reserves that happen to share the same `(hub, assetId)` pair, so two reserves can't each independently claim the same underlying liquidity within one call (CertiK FNA-07 follow-up).

> **Known residual gap** (documented, not fixed): the ledger only dedupes *within this guard's own* multi-reserve loop. A pool that also holds an [AaveV4TokenizationAssetGuard](AaveV4TokenizationAssetGuard.md) vault drawing from the *same* `(hub, assetId)` is not covered — closing that fully needs a pool-level, cross-guard liquidity ledger shared for the duration of one withdrawal transaction, a materially larger change deliberately left as a tracked follow-up.

### `withdrawProcessing`

```solidity
function withdrawProcessing(
    address pool,
    address spoke,
    uint256 withdrawPortion,
    address to
) external view returns (address withdrawAsset, uint256 withdrawAmount, MultiTransaction[] memory txs)
```

Builds a `(withdraw, transfer)` pair per tracked reserve, each amount capped by the same Hub-liquidity ledger `getWithdrawableBalance()` uses — so the NAV a withdrawal portion was sized against and what actually gets pulled can never disagree. Calls `ISpoke.withdraw()` **directly**, not through Aave's TakerPositionManager: since `PoolLogic` always dispatches from its own address, the position owner and caller are the same, and Aave's `_isPositionManager` check short-circuits to true with no delegation needed (CertiK FNA-15). Returns `withdrawAsset = address(0)` — funds are already delivered via direct transfers, so `PoolLogic` should not attempt its own balance-delta tracking.

### `txGuard`

```solidity
function txGuard(address poolManagerLogic, address spoke, bytes calldata data) external returns (uint16 txType, bool isPublic)
```

Recognizes exactly one selector on the Spoke itself — `ISpoke.setUserPositionManager(positionManager, approve)` — required before either Aave PositionManager may act for the pool, including its very first supply (CertiK FNA-08). `positionManager` is restricted to `{giverPositionManager, takerPositionManager}`: Aave V4's `withdraw` sends funds to `msg.sender`, not `onBehalfOf`, so approving an arbitrary address here would let it withdraw the pool's entire position, bypassing every other guard.

### `removeAssetCheck` / `removeTokenCheck`

`removeAssetCheck` allows removing the Spoke once every tracked reserve's raw `getUserSuppliedAssets` is within a small dust tolerance (100 raw units — deliberately in raw units, not USD, since this check avoids price/decimals lookups to stay revert-safe). `removeTokenCheck` blocks removing a *different* supported asset from the pool while it's still the underlying of a non-dust tracked reserve (CertiK FNA-21).

---

## Configuration

| Parameter | Set at | Description |
|-----------|--------|-------------|
| `aaveV4SpokeManager` | constructor (immutable) | The [AaveV4SpokeManager](AaveV4SpokeManager.md) allowlist this guard consults for tracked/active reserves |
| `takerPositionManager` | constructor (immutable) | Aave V4's singleton TakerPositionManager — still needed for the manager-directed manual withdrawal path in [AaveV4SpokeContractGuard](AaveV4SpokeContractGuard.md), even though automatic `withdrawProcessing()` no longer routes through it |
| `giverPositionManager` | constructor (immutable) | Aave V4's singleton GiverPositionManager — the only other address a pool may ever approve via `setUserPositionManager` |

No owner-settable parameters — this guard is a stateless, immutable-configured contract; all mutable allowlisting lives in `AaveV4SpokeManager`.

---

## Access Control

| Role | Permissions |
|------|-------------|
| `PoolLogic` (caller) | The only accepted `msg.sender` for `txGuard()` — enforced via `IPoolManagerLogic(poolManagerLogic).poolLogic()` |
| Protocol owner (via `AaveV4SpokeManager`) | Whitelists which `(pool, spoke, reserveId)` combinations may hold *new* exposure |

---

## Related

- [AaveV4SpokeManager](AaveV4SpokeManager.md) — the active/tracked reserve allowlist this guard reads
- [AaveV4SpokeContractGuard](AaveV4SpokeContractGuard.md) — gates `execTransaction()` calls into the Spoke (supply/approveWithdraw/withdraw), including the manager-directed manual path
- [AaveV4TokenizationAssetGuard](AaveV4TokenizationAssetGuard.md) — the parallel Aave V4 integration for TokenizationSpoke (ERC-4626) positions, sharing the same underlying Hub liquidity model
