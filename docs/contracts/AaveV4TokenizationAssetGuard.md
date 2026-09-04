# AaveV4TokenizationAssetGuard

**Source:** `contracts/contracts/guards/assetGuards/AaveV4TokenizationAssetGuard.sol`
**Asset Type:** registered per deployment against `AssetHandler`/`Governance` — see [Governance's Asset Type Registry](Governance.md#asset-type-registry) for the on-chain-verified mapping.

---

## Overview

AaveV4TokenizationAssetGuard values and unwinds a pool's position in an Aave V4 **TokenizationSpoke** — an ERC-4626 vault that deposits directly into Aave's Liquidity Hub, bypassing the main lending Spoke entirely. One guard instance services any number of TokenizationSpoke instances; each instance is itself the registered "supported asset" (one per underlying), the same 1:1 shape as [MorphoVaultV2AssetGuard](MorphoVaultV2AssetGuard.md), and unlike [AaveV4SpokeAssetGuard](AaveV4SpokeAssetGuard.md) there is no multi-reserve aggregation and no side allowlist of reserve IDs.

The pool's position carries no debt, so balances are simply `convertToAssets(shares)` — no flashloan-based unwind path, no health factor.

`getBalance()`/`withdrawProcessing()` deliberately **do not** consult the [AaveV4TokenizationManager](AaveV4TokenizationManager.md) whitelist — a vault must remain valuable and exitable even after governance revokes it. Only *new* exposure ([AaveV4TokenizationContractGuard](AaveV4TokenizationContractGuard.md), and `addAssetCheck` below) is gated by the whitelist.

---

## Responsibilities

- Report the pool's USD-denominated share balance (`convertToAssets(shares)`, priced through the underlying)
- Cap that balance to what's actually redeemable right now, against the Aave V4 Hub's real liquidity for this vault's `(hub, assetId)`
- Build the pro-rata `redeem()` transaction for a withdrawal
- Value one whole share in USD via `getUnitPrice()`, so this transferable ERC-20 is priced correctly wherever it's swapped or valued outside `getBalance()`'s own aggregate path
- Block onboarding a vault whose underlying isn't already priced, guarded, *and* independently supported by this specific pool (CertiK FNA-20)

---

## Guard Markers Implemented

| Interface | Meaning |
|-----------|---------|
| `IAddAssetCheckGuard` | `addAssetCheck()` must run before a TokenizationSpoke can be registered |
| `IPreValuedAssetGuard` | `getBalance()` returns a fully priced USD-18 figure; `getUnitPrice()` values one real share via the underlying (CertiK FNA-45/56 — this is one of only two guards where `getUnitPrice()` is a genuine, non-reverting implementation, the other being `MorphoVaultV2AssetGuard`) |
| `IIncompleteValuationGuard` | Distinguishes a genuinely-empty position from a temporarily-unpriceable one |
| `IWithdrawableBalanceGuard` | Liquidity-capped counterpart to `getBalance()` for immediate-withdrawal sizing (CertiK FNA-07) |

---

## Functions

### `addAssetCheck`

```solidity
function addAssetCheck(address poolLogic, IHasSupportedAsset.Asset calldata asset) external view
```

Three independent conditions, all required: (1) the vault is whitelisted for this pool in `AaveV4TokenizationManager`; (2) the vault's underlying already has a registered price feed and asset guard globally; (3) the underlying is **also** a supported asset of *this specific pool* (CertiK FNA-20 — global pricing alone doesn't prove this pool has independently vetted it).

### `getBalance` / `getWithdrawableBalance`

```solidity
function getBalance(address pool, address asset) public view returns (uint256 balanceUsd18)
function getWithdrawableBalance(address pool, address asset) external view returns (uint256 balanceUsd18)
```

Both value `convertToAssets(shares)` through the underlying's real price/decimals, fully fault-isolated (any failing call — vault or pricing layer — degrades to 0 and marks the reading incomplete, rather than reverting the whole `getBalance()` for the pool). `getWithdrawableBalance()` additionally caps `shares` by `_capSharesByAvailableLiquidity()`: `min(shares, convertToShares(IHubBase.getAssetLiquidity(assetId)))`.

> **Known residual gap** (documented, not fixed): the liquidity cap only knows about *this vault's own* `(hub, assetId)`. A pool that also holds an `AaveV4SpokeAssetGuard` reserve drawing from the same pair could, within one withdrawal transaction, have both guards independently see the Hub's full liquidity — together attempting more than the Hub can deliver. Closing this needs a pool-level, cross-guard liquidity ledger; deliberately out of scope here, tracked as a follow-up (mirrors the identical note on `AaveV4SpokeAssetGuard`).

### `getUnitPrice`

```solidity
function getUnitPrice(address asset) external view returns (uint256)
```

Values one whole share (`10**shareDecimals`) via `convertToAssets`, priced through the underlying via `IPoolManagerLogic(msg.sender).getAssetPrice()`/`.assetDecimal()` — `msg.sender` is trusted as the pricing context because the only legitimate caller is `PoolManagerLogic.getAssetPrice()` itself. Unlike `getBalance()`, this **reverts** on any failed dependency or a zero result rather than degrading — a caller pricing a swap needs a trustworthy number or nothing at all (CertiK FNA-45/56). Uses `Math.mulDiv` for the final multiplication to avoid a theoretical intermediate-overflow path.

### `withdrawProcessing`

```solidity
function withdrawProcessing(
    address pool,
    address asset,
    uint256 withdrawPortion,
    address /* to */
) external view returns (address withdrawAsset, uint256 withdrawAmount, MultiTransaction[] memory txs)
```

Redeems `sharesToRedeem = min(shares, liquidityCap) * withdrawPortion / 1e18` directly to the pool itself (`receiver = owner = pool`), not to `to` — `PoolLogic` tracks the pool's own balance delta of `withdrawAsset` and forwards it, which also means the caller's own slippage-tolerance check applies automatically with no extra logic here.

### `removeAssetCheck` / `removeTokenCheck`

`removeAssetCheck` requires the pool's raw share balance to be exactly zero. `removeTokenCheck` (CertiK FNA-20) blocks removing a *different* supported asset while this vault still wraps it as its underlying — and fails **closed** (blocks removal) if the vault holds shares but its own `asset()` call reverts, rather than failing open, since a live underlying being removed while a possibly-recoverable vault still wraps it risks silently corrupting NAV later.

---

## Configuration

| Parameter | Set at | Description |
|-----------|--------|-------------|
| `aaveV4TokenizationManager` | constructor (immutable) | The [AaveV4TokenizationManager](AaveV4TokenizationManager.md) whitelist consulted only at `addAssetCheck()` time |

No owner-settable parameters — stateless, immutable-configured contract.

---

## Related

- [AaveV4TokenizationManager](AaveV4TokenizationManager.md) — the vault whitelist this guard's `addAssetCheck()` consults
- [AaveV4TokenizationContractGuard](AaveV4TokenizationContractGuard.md) — gates `execTransaction()` calls into a TokenizationSpoke
- [AaveV4SpokeAssetGuard](AaveV4SpokeAssetGuard.md) — the parallel Aave V4 integration for direct Spoke reserves, sharing the same underlying Hub liquidity model and its cross-guard residual gap
- [MorphoVaultV2AssetGuard](MorphoVaultV2AssetGuard.md) — the closest architectural analog (single ERC-4626 vault per registered asset, `getUnitPrice()` implemented for real)
