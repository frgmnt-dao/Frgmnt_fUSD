# AaveV4TokenizationManager

**Source:** `contracts/contracts/guards/contractGuards/AaveV4TokenizationManager.sol`
**Owner:** protocol owner (intended to be the Timelock)

---

## Overview

Protocol-owned allowlist of Aave V4 TokenizationSpoke instances each pool is permitted to use. Mirrors [MorphoVaultV2Manager](MorphoVaultV2Manager.md) exactly — each TokenizationSpoke is its own ERC-4626 vault address (one per underlying asset), unlike the main-Spoke supply path ([AaveV4SpokeManager](AaveV4SpokeManager.md)), where one Spoke address serves many reserves identified by a numeric `reserveId`. `PoolManagerLogic.changeAssets()` alone would let a pool manager register an arbitrary, unvetted ERC-4626-shaped contract as a "TokenizationSpoke" asset; this contract adds a second, independent, protocol-owner-only approval step.

---

## The Active/Tracked Split (CertiK FNA-51)

`poolVaults`/`isValidPoolVault` (**the active allowlist**) only ever gates *new* manager-directed deposits — see [AaveV4TokenizationContractGuard](AaveV4TokenizationContractGuard.md)'s entry-side handlers and `AaveV4TokenizationAssetGuard.addAssetCheck`. It must never gate withdrawal/valuation — that path (`AaveV4TokenizationAssetGuard.getBalance`/`withdrawProcessing`, and the contract guard's exit-side handlers) instead reads `trackedPoolVaults`, a superset that also retains any vault the protocol owner has since delisted for as long as it may still hold pool shares. Revoking a vault from the active allowlist can therefore never trap a pool's existing position — `trackedPoolVaults` is untouched by `setPoolVaults()` and only ever shrinks via `pruneTrackedVault()` once the position is provably empty.

---

## Functions

### `setPoolVaults`

```solidity
function setPoolVaults(address pool, address[] calldata vaults) external onlyOwner
```

Replaces the full previous active list. Rejects a zero-address entry (CertiK FNA-09) rather than silently recording an unmatched "allowed vault". Every newly-authorized vault is also added to the tracked set automatically.

### `pruneTrackedVault`

```solidity
function pruneTrackedVault(address pool, address vault) external
```

Permissionless: (1) currently tracked, (2) **not** in the active allowlist, (3) the pool's raw share balance of the vault is zero (`IERC20(vault).balanceOf(pool) == 0`).

### Getters

`getPoolVaults`/`getPoolVaultsLength` (active), `getTrackedPoolVaults`/`getTrackedPoolVaultsLength` (tracked).

---

## Related

- [AaveV4TokenizationAssetGuard](AaveV4TokenizationAssetGuard.md) — reads `trackedPoolVaults` for all valuation/withdrawal
- [AaveV4TokenizationContractGuard](AaveV4TokenizationContractGuard.md) — reads both allowlists depending on operation direction
- [MorphoVaultV2Manager](MorphoVaultV2Manager.md) — the structurally identical Morpho Vault V2 analog
