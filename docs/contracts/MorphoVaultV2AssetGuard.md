# MorphoVaultV2AssetGuard

**Source:** `contracts/contracts/guards/assetGuards/MorphoVaultV2AssetGuard.sol`
**Asset Type:** registered per deployment against `AssetHandler`/`Governance` — see [Governance's Asset Type Registry](Governance.md#asset-type-registry) for the on-chain-verified mapping.

---

## Overview

MorphoVaultV2AssetGuard values and unwinds a pool's position in a Morpho Vault V2 — an ERC-4626 vault that routes deposits across curator-selected adapters (see [Morpho's Vault V2 docs](https://docs.morpho.org/learn/concepts/vault-v2/)). One guard instance services any number of registered Vault V2 instances; unlike the Aave V3/Morpho Blue integrations (which wrap a single singleton protocol contract and need a per-pool market allowlist), each vault instance is itself the registered "supported asset" address, so no per-position bookkeeping lives in this guard.

The pool's position carries no debt, so balances are simply `convertToAssets(shares)` — no flashloan-based unwind path, no health factor.

`getBalance()`/`withdrawProcessing()` deliberately **do not** consult the [MorphoVaultV2Manager](MorphoVaultV2Manager.md) whitelist — a vault must remain valuable and exitable even after governance revokes it. Only *new* exposure ([MorphoVaultV2ContractGuard](MorphoVaultV2ContractGuard.md), and `addAssetCheck` below) is gated by the whitelist.

---

## Responsibilities

- Report the pool's USD-denominated share balance (`convertToAssets(shares)`, priced through the underlying)
- Cap that balance to what's actually redeemable right now without touching a vault adapter (idle-balance floor)
- Build the pro-rata `redeem()` transaction for a withdrawal
- Value one whole share in USD via `getUnitPrice()`

---

## Guard Markers Implemented

| Interface | Meaning |
|-----------|---------|
| `IAddAssetCheckGuard` | `addAssetCheck()` must run before a vault can be registered |
| `IPreValuedAssetGuard` | `getBalance()` returns a fully priced USD-18 figure; `getUnitPrice()` values one real share via the underlying (CertiK FNA-45/56 — one of only two guards with a genuine, non-reverting `getUnitPrice()`, the other being `AaveV4TokenizationAssetGuard`) |
| `IIncompleteValuationGuard` | Distinguishes a genuinely-empty position from a temporarily-unpriceable one |
| `IWithdrawableBalanceGuard` | Liquidity-capped counterpart to `getBalance()` for immediate-withdrawal sizing (CertiK FNA-07 follow-up) |

---

## Functions

### `addAssetCheck`

```solidity
function addAssetCheck(address poolLogic, IHasSupportedAsset.Asset calldata asset) external view
```

Two conditions: the vault is whitelisted for this pool in `MorphoVaultV2Manager`, and its underlying already has a registered price feed and asset guard globally.

### `getBalance` / `getWithdrawableBalance`

```solidity
function getBalance(address pool, address asset) public view returns (uint256 balanceUsd18)
function getWithdrawableBalance(address pool, address asset) external view returns (uint256 balanceUsd18)
```

Both value `convertToAssets(shares)` through the underlying's real price/decimals, fully fault-isolated (any failing call degrades to 0 and marks the reading incomplete rather than reverting `getBalance()` for the whole pool — `convertToAssets` itself calls `accrueInterestView()` internally, so the reading always reflects live interest). `getWithdrawableBalance()` additionally caps `shares` by `_capSharesByIdleLiquidity()`.

> **FNA-25 history**: this guard previously capped withdrawable shares by `IERC4626(asset).maxRedeem(pool)` — wrong for Morpho Vault V2 specifically, since the canonical implementation's `maxRedeem()` unconditionally returns 0 (not a genuine liquidity estimate), which made every position read as fully illiquid on every immediate withdrawal. FNA-25 removed the cap entirely; the CertiK FNA-07 follow-up (below) re-added it using a verified-safe mechanism instead of trusting `maxRedeem()` again.

### `_capSharesByIdleLiquidity`

Caps `shares` by the vault's own **idle** balance of its underlying (`IERC20(underlying).balanceOf(vault)`, converted to shares) — deliberately *not* an attempt to estimate adapter liquidity, since Vault V2's adapters are curator-chosen and pluggable with no generic way to inspect them. Idle balance is instead a *provable* floor: confirmed against Morpho's published source that idle balance is drawn down first and unconditionally before any adapter is touched, so redeeming at most this many shares can never need an adapter at all.

### `getUnitPrice`

```solidity
function getUnitPrice(address asset) external view returns (uint256)
```

Values one whole share (`10**shareDecimals`) via `convertToAssets`, priced through the underlying via `IPoolManagerLogic(msg.sender).getAssetPrice()`/`.assetDecimal()`. Reverts on any failed dependency or a zero result rather than degrading (CertiK FNA-45/56) — the opposite of `getBalance()`'s fail-open stance, since a caller pricing a swap needs a trustworthy number or nothing at all. Uses `Math.mulDiv` for the final multiplication.

### `withdrawProcessing`

```solidity
function withdrawProcessing(
    address pool,
    address asset,
    uint256 withdrawPortion,
    address /* to */
) external view returns (address withdrawAsset, uint256 withdrawAmount, MultiTransaction[] memory txs)
```

Redeems `sharesToRedeem = min(shares, idleLiquidityCap) * withdrawPortion / 1e18` directly to the pool itself, matching `AaveV4TokenizationAssetGuard`'s pattern. Deliberately only calls `redeem()` — it does **not** fall back to `forceDeallocate()` if a liquidity adapter is dry (see [MorphoVaultV2ContractGuard](MorphoVaultV2ContractGuard.md) for why `forceDeallocate` stays a manager-only, deliberate action rather than an automatic fallback). Beyond the idle-balance floor, `redeem()` can still revert if a request needs more than an adapter has — the same accepted risk class as an Aave/Morpho Blue market being fully utilized.

### `removeAssetCheck`

Requires the pool's raw share balance to be exactly zero — checked directly (not via `getBalance()`) so a transient valuation failure can never make a live, nonzero position look removable.

---

## Configuration

| Parameter | Set at | Description |
|-----------|--------|-------------|
| `morphoVaultV2Manager` | constructor (immutable) | The [MorphoVaultV2Manager](MorphoVaultV2Manager.md) whitelist consulted only at `addAssetCheck()` time |

No owner-settable parameters — stateless, immutable-configured contract.

---

## Related

- [MorphoVaultV2Manager](MorphoVaultV2Manager.md) — the vault whitelist this guard's `addAssetCheck()` consults
- [MorphoVaultV2ContractGuard](MorphoVaultV2ContractGuard.md) — gates `execTransaction()` calls into a vault, including the manager-only `forceDeallocate` recovery path
- [AaveV4TokenizationAssetGuard](AaveV4TokenizationAssetGuard.md) — the closest architectural analog (single ERC-4626 vault per registered asset, real `getUnitPrice()`), but with a Hub-liquidity cap instead of an idle-balance one, since it draws from Aave's Liquidity Hub rather than curator-chosen adapters
