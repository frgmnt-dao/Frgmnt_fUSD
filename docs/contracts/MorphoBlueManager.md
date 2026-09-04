# MorphoBlueManager

**Source:** `contracts/contracts/guards/contractGuards/MorphoBlueManager.sol`
**Owner:** protocol owner (intended to be the Timelock)

---

## Overview

Protocol-owned allowlist of Morpho Blue market IDs each pool is permitted to supply/borrow/collateralize against. Mirrors [AaveV4SpokeManager](AaveV4SpokeManager.md)'s and [MorphoVaultV2Manager](MorphoVaultV2Manager.md)'s two-key model: `PoolManagerLogic.changeAssets()` alone would let a manager register exposure to an arbitrary, unvetted market — this contract adds a second, independent, protocol-owner-only approval step.

Keyed by `Id` (Morpho Blue's `MarketParams` hash), one market ID per lending pair — the loan/collateral/oracle/IRM/LLTV combination is fixed at market-creation time on Morpho Blue itself and is not re-validated here; this contract only decides which of those markets a given Frgmnt pool may use.

---

## The Active/Tracked Split (CertiK FNA-52)

`poolMarkets`/`isValidPoolMarket` (**the active allowlist**) only ever gates *new* manager-directed exposure — see [MorphoBlueContractGuard](MorphoBlueContractGuard.md)'s supply/borrow/supplyCollateral/liquidate handlers. It must never be consulted on the withdrawal/valuation/removal-safety path — that path (`MorphoCollectLib.getBalance`/`getDeficit`/`collectDebts`/`collectSupplies`/`collectCollaterals`, `MorphoChecksLib.removeAssetCheck`/`removeTokenCheck`, and the contract guard's withdraw/repay/withdrawCollateral handlers) instead reads `trackedPoolMarkets`, a **superset** of the active allowlist that also retains any market the protocol owner has since delisted, for as long as it may still hold pool supply/collateral/debt. This is what keeps the promise that revoking a market from the active allowlist can never trap a pool's existing position, silently drop it from NAV, or let pool-level asset removal proceed while it's still open: `trackedPoolMarkets` is untouched by `setPoolMarkets()` and only ever shrinks via `pruneTrackedMarket()` once the position is provably empty.

---

## Functions

### `setPoolMarkets`

```solidity
function setPoolMarkets(address pool, Id[] calldata markets) external onlyOwner
```

Replaces the full previous active list. Reverts on a duplicate `marketId` within the call (CertiK FNA-12) — `MorphoCollectLib` iterates and *sums* `trackedPoolMarkets` across four separate supply/collateral/debt collection passes, so a duplicate entry would double-count that market's position in both NAV and withdrawal/repay planning, and could make withdrawal processing revert once the first operation changes a position an immediately-following duplicate still expects unchanged. Omitting a previously-allowed `marketId` revokes it from *new* exposure only; `trackedPoolMarkets` is left untouched. Every newly-authorized market is automatically added to the tracked set too.

### `pruneTrackedMarket`

```solidity
function pruneTrackedMarket(address pool, Id market) external
```

Permissionless — the three on-chain conditions are the real gate, not caller identity: (1) currently tracked, (2) **not** in the active allowlist (an active market is never prunable, since supplying/borrowing into it again with no tracking would silently recreate the FNA-52 bug), (3) zero live position (`collateral == 0 && supplyShares == 0 && borrowShares == 0`) read from the real Morpho Blue core.

> **CertiK FNA-52 follow-up**: `morpho` used to be a caller-supplied parameter to this function. Since `pruneTrackedMarket` is deliberately permissionless, anyone could pass a stub contract whose `position()` always returns an empty `Position`, untracking a delisted market that still holds a live position on the *real* Morpho Blue — silently restoring the exact NAV/withdrawal-safety gap FNA-52 had just closed. `morpho` is now `immutable`, fixed at deploy time via the constructor (which reverts with `MorphoZero()` on a zero address) — there is no longer any address for a caller to spoof.

### Getters

`getPoolMarkets`/`getPoolMarketsLength` (active), `getTrackedPoolMarkets`/`getTrackedPoolMarketsLength` (tracked).

---

## Configuration

| Parameter | Set at | Description |
|-----------|--------|-------------|
| `morpho` | constructor (immutable) | The real Morpho Blue core contract, read by `pruneTrackedMarket()` — see the FNA-52 follow-up note above |

---

## Related

- [MorphoBlueContractGuard](MorphoBlueContractGuard.md) — reads both `isValidPoolMarket` (new exposure) and `isTrackedPoolMarket` (withdraw-side)
- [MorphoBlueLendingPoolAssetGuard](MorphoBlueLendingPoolAssetGuard.md) — reads `trackedPoolMarkets` for all valuation/withdrawal/removal-safety via `MorphoCollectLib`/`MorphoChecksLib`
- [AaveV4SpokeManager](AaveV4SpokeManager.md) / [MorphoVaultV2Manager](MorphoVaultV2Manager.md) — the same active/tracked pattern applied to Aave V4 Spoke reserves and Morpho Vault V2 instances respectively
