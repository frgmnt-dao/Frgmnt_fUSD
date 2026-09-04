# MorphoVaultV2Manager

**Source:** `contracts/contracts/guards/contractGuards/MorphoVaultV2Manager.sol`
**Owner:** protocol owner (intended to be the Timelock)

---

## Overview

Protocol-owned allowlist of Morpho Vault V2 instances each pool is permitted to use. Mirrors [AaveV4TokenizationManager](AaveV4TokenizationManager.md) and [AaveV4SpokeManager](AaveV4SpokeManager.md)'s two-key model exactly: `PoolManagerLogic.changeAssets()` is callable by the pool manager or trader, so it alone would let a manager register an arbitrary, unvetted ERC-4626-shaped contract as a "Morpho Vault V2" asset — this contract adds a second, independent, protocol-owner-only approval step before any vault becomes usable by a pool.

Also exposes `getVaultAdapterPenalties`, a read-only helper letting the owner inspect a candidate vault's per-adapter `forceDeallocate` penalty configuration *before* whitelisting it — not an enforcement point, since `forceDeallocate` is permissionless on the vault itself regardless of what this contract allows.

---

## The Active/Tracked Split (CertiK FNA-51)

`poolVaults`/`isValidPoolVault` (**the active allowlist**) only ever gates *new* manager-directed exposure — depositing into a vault (see [MorphoVaultV2ContractGuard](MorphoVaultV2ContractGuard.md)'s entry-side handlers) and registering a vault as a supported asset (`MorphoVaultV2AssetGuard.addAssetCheck`). It must never be consulted on the withdrawal/valuation path — that path (`MorphoVaultV2AssetGuard.getBalance`/`withdrawProcessing`, and the contract guard's exit-side handlers) instead reads `trackedPoolVaults`, a **superset** of the active allowlist that also retains any vault the protocol owner has since delisted, for as long as it may still hold pool shares. This is what keeps the promise that revoking a vault from the active allowlist can never trap a pool's existing position: `trackedPoolVaults` is untouched by `setPoolVaults()` and only ever shrinks via `pruneTrackedVault()` once the position is provably empty. Mirrors the `poolReserves`/`trackedPoolReserves` split `AaveV4SpokeManager` uses for the same reason (CertiK FNA-10).

---

## Functions

### `setPoolVaults`

```solidity
function setPoolVaults(address pool, address[] calldata vaults) external onlyOwner
```

Replaces the full previous active list. Rejects a zero-address entry (CertiK FNA-09) rather than silently recording an unmatched "allowed vault". Every newly-authorized vault is automatically added to the tracked set too, so it's exitable/withdrawable from the moment deposits into it become possible, not only after a later `setPoolVaults` call. Omitting a previously-allowed vault revokes it from *new* deposits only — `trackedPoolVaults` is left untouched.

### `pruneTrackedVault`

```solidity
function pruneTrackedVault(address pool, address vault) external
```

Permissionless — the three on-chain conditions are the real gate, not caller identity: (1) currently tracked, (2) **not** in the active allowlist (an active vault is never prunable, since depositing into it again with no tracking would silently recreate the FNA-51 bug), (3) the pool's raw share balance of the vault is zero (`IERC20(vault).balanceOf(pool) == 0`).

### `getVaultAdapterPenalties`

```solidity
function getVaultAdapterPenalties(address vault) external view returns (address[] memory adapters, uint256[] memory penalties)
```

Returns every adapter registered on `vault` alongside its configured `forceDeallocate` penalty rate (WAD-scaled, 1e18 = 100%). Governance/tooling helper only, meant to be checked before calling `setPoolVaults` to whitelist a candidate vault — `forceDeallocate` is permissionless on the vault itself and Morpho caps the penalty at the vault level, so this helper cannot restrict anything by itself; it exists purely for informed vetting.

### Getters

`getPoolVaults`/`getPoolVaultsLength` (active), `getTrackedPoolVaults`/`getTrackedPoolVaultsLength` (tracked).

---

## Related

- [MorphoVaultV2AssetGuard](MorphoVaultV2AssetGuard.md) — reads `trackedPoolVaults` for all valuation/withdrawal
- [MorphoVaultV2ContractGuard](MorphoVaultV2ContractGuard.md) — reads both allowlists depending on operation direction, including the `forceDeallocate` recovery path this manager's `getVaultAdapterPenalties` helps vet
- [AaveV4TokenizationManager](AaveV4TokenizationManager.md) / [AaveV4SpokeManager](AaveV4SpokeManager.md) — the same active/tracked pattern applied to Aave V4 Tokenization vaults and Aave V4 Spoke reserves respectively
