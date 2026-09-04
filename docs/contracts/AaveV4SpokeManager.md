# AaveV4SpokeManager

**Source:** `contracts/contracts/guards/contractGuards/AaveV4SpokeManager.sol`
**Owner:** protocol owner (intended to be the Timelock)

---

## Overview

Protocol-owned allowlist of Aave V4 Spoke reserves each pool is permitted to supply to / withdraw from. Mirrors [MorphoBlueManager](MorphoBlueManager.md)'s and [MorphoVaultV2Manager](MorphoVaultV2Manager.md)'s two-key model: `PoolManagerLogic.changeAssets()` is callable by the pool manager or trader, so it alone would let a manager register an arbitrary, unvetted Spoke as a supported asset — this contract adds a second, independent, protocol-owner-only approval step before any reserve becomes usable.

Keyed by `(pool, spoke, reserveId)` rather than `(pool, vault)` — unlike a Morpho Vault V2 instance or an Aave V4 TokenizationSpoke, a single Spoke contract serves many reserves (assets), each identified by a numeric `reserveId`, not its own address.

---

## The Active/Tracked Split (CertiK FNA-10)

`poolReserves`/`isValidPoolReserve` (**the active allowlist**) only ever gates *new* manager-directed exposure — see [AaveV4SpokeContractGuard](AaveV4SpokeContractGuard.md)'s supply handler and `AaveV4SpokeAssetGuard.addAssetCheck`. It must never be consulted on the withdrawal/valuation path. That path — [AaveV4SpokeAssetGuard](AaveV4SpokeAssetGuard.md)'s `getBalance`/`getWithdrawableBalance`/`withdrawProcessing`/`removeAssetCheck`, and `AaveV4SpokeContractGuard`'s withdraw-side handlers — instead reads `trackedPoolReserves`, a **superset** of the active allowlist that also retains any reserve the protocol owner has since delisted, for as long as it may still hold pool supply. This is what actually keeps the promise that revoking a reserve can never trap a pool's existing position: `trackedPoolReserves` is untouched by `setPoolReserves()` and only ever shrinks via `pruneTrackedReserve()` once the position is provably empty.

---

## Functions

### `setPoolReserves`

```solidity
function setPoolReserves(address pool, address spoke, uint256[] calldata reserveIds) external onlyOwner
```

Replaces the full previous active list for `(pool, spoke)` — omitting a previously-allowed `reserveId` revokes it from *new* exposure immediately, but leaves it in `trackedPoolReserves` untouched. Reverts on a duplicate `reserveId` within the call: `AaveV4SpokeAssetGuard.getBalance()` iterates and *sums* the tracked list, so a duplicate would double-count that reserve's value. Every newly-authorized reserve is automatically added to the tracked set too, so it's valued/withdrawable from the moment supply becomes possible.

### `pruneTrackedReserve`

```solidity
function pruneTrackedReserve(address pool, address spoke, uint256 reserveId) external
```

Permissionless — the three on-chain conditions are the real gate, not caller identity: (1) currently tracked, (2) **not** in the active allowlist (an active reserve is never prunable), (3) zero live supplied balance on the Spoke right now (`ISpoke.getUserSuppliedAssets == 0`).

### Getters

`getPoolReserves`/`getPoolReservesLength` (active allowlist), `getTrackedPoolReserves`/`getTrackedPoolReservesLength` (tracked superset).

---

## Related

- [AaveV4SpokeAssetGuard](AaveV4SpokeAssetGuard.md) — reads `trackedPoolReserves` for all valuation/withdrawal
- [AaveV4SpokeContractGuard](AaveV4SpokeContractGuard.md) — reads both `isValidPoolReserve` (supply) and `isTrackedPoolReserve` (withdraw-side)
- [MorphoBlueManager](MorphoBlueManager.md) / [MorphoVaultV2Manager](MorphoVaultV2Manager.md) — the same active/tracked pattern applied to Morpho Blue markets and Morpho Vault V2 instances respectively
