# ClosedAssetGuard

**Source:** `contracts/contracts/guards/assetGuards/ClosedAssetGuard.sol`
**Kind:** abstract base contract, not deployed standalone

---

## Overview

Base class for asset guards covering positions that should not be freely transferable or callable through the manager/trader's own `execTransaction()` router. Nearly every position-style asset guard in this codebase inherits from it — [AaveV4SpokeAssetGuard](AaveV4SpokeAssetGuard.md), [AaveV4TokenizationAssetGuard](AaveV4TokenizationAssetGuard.md), [MorphoVaultV2AssetGuard](MorphoVaultV2AssetGuard.md), [MorphoBlueLendingPoolAssetGuard](MorphoBlueLendingPoolAssetGuard.md), [AaveLendingPoolAssetGuard](AaveLendingPoolAssetGuard.md), [UniswapV3AssetGuard](UniswapV3AssetGuard.md) — the common shape being: no arbitrary calls, but a paired *contract guard* separately authorizes a specific, narrow set of protocol calls (supply, withdraw, deposit, etc.).

---

## Functions

### `txGuard`

```solidity
function txGuard(address, address, bytes calldata) external virtual override returns (uint16 txType, bool isPublic)
```

Always returns `(0, false)` — authorizes nothing. Deliberately declared `virtual`, not `pure`: Solidity only allows overrides to become more restrictive along an override chain, never less, so a child guard can override this with a stateful implementation that authorizes one narrow, explicitly-checked selector while leaving every other call rejected exactly as before. [AaveV4SpokeAssetGuard](AaveV4SpokeAssetGuard.md) is the one guard in this codebase that does this (CertiK FNA-08, the Merkl-claims-forwarding exception).

### `getBalance`

```solidity
function getBalance(address, address) public view virtual override returns (uint256)
```

No default implementation — every concrete child guard must override this to report the pool's held value in the asset.

### `removeAssetCheck`

```solidity
function removeAssetCheck(address pool, address asset) public view virtual override
```

Default implementation: requires `getBalance(pool, asset) == 0`. A guard with removal-safety concerns beyond a simple zero-balance check (e.g. a delisted-but-still-tracked market, CertiK FNA-10/FNA-51/FNA-52) overrides this to add its own tracked-set condition — see those guards' own documentation.

### `removeTokenCheck`

```solidity
function removeTokenCheck(address, address, address) public view virtual returns (bool)
```

Default implementation: always returns `true` (permissive) — a child guard whose asset can hold a *different* ERC-20 as part of its position (e.g. a Uniswap V3 NFT's two underlying tokens) overrides this to block removal of a token still referenced by a live position. See CertiK FNA-53 (centralized cross-asset removal check in `PoolManagerLogic._removeAsset()`) for how this hook composes with the rest of the removal-safety system, and [MorphoVaultV2AssetGuard](MorphoVaultV2AssetGuard.md)'s own documentation for a guard that deliberately does **not** override this default — noted there as a factual scope statement (its position never holds a separate ERC-20 token beyond the vault share itself), not a flagged gap.

---

## Related

- Every position-style asset guard in this codebase inherits from `ClosedAssetGuard` — see the Overview list above
- [PoolManagerLogic](PoolManagerLogic.md) — calls `removeAssetCheck`/`removeTokenCheck` during `_removeAsset()`
