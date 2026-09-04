# UniswapV3NonfungiblePositionGuard

**Source:** `contracts/contracts/guards/contractGuards/uniswapV3/UniswapV3NonfungiblePositionGuard.sol`
**Registered in Governance against:** the Uniswap V3 `NonfungiblePositionManager` singleton

---

## Overview

Validates and tracks Uniswap V3 LP NFT operations (`mint`/`increaseLiquidity`/`decreaseLiquidity`/`burn`/`collect`/`multicall`) executed through `PoolLogic.execTransaction()`. Unlike the lending-style guards, a Uniswap V3 position is itself an NFT — one `tokenId` per position, potentially several per pool — so this guard maintains its own owned-tokenId tracking via an external `NftTrackerStorage` contract (add on mint, remove on burn), rather than relying on `ERC20Guard`-style balance checks. `isTxTrackingGuard = true`: `afterTxGuard()` is where the tracker is actually updated, since the real `tokenId` a `mint()` call produces is only knowable after execution.

---

## Functions

### `txGuard`

```solidity
function txGuard(address poolManagerLogic, address to, bytes memory data) public override returns (uint16 txType, bool)
```

| Selector | Checks |
|----------|--------|
| `mint` | `token0`/`token1`/`to` (the position manager itself) all supported assets; `recipient == pool`; Uniswap TWAP "fair price" check (`UniswapV3PriceLibrary.assertFairPrice`) against the target tick range |
| `increaseLiquidity` | `tokenId` must already be tracked; position manager and the position's own `token0`/`token1` (read live via `positions()`) must be supported; same fair-price check |
| `decreaseLiquidity` | `tokenId` must already be tracked |
| `burn` | `tokenId` must already be tracked |
| `collect` | `tokenId` must already be tracked; the position's `token0`/`token1` must be supported; `recipient == pool` |
| `multicall` | recurses into `txGuard()` for each inner call (see below) |

Every non-mint operation requires the target `tokenId` to already be in this pool's own tracked set (`_isValidOwnedTokenId`) — an NFT the pool never minted, or one it already burned, can never be operated on through this guard regardless of who currently custodies it.

### `increaseLiquidity`'s position-manager/token checks (CertiK FNA-48)

`increaseLiquidity` was, until fixed, the only branch that never re-verified the position manager or the position's own underlying tokens were still pool-supported — letting real ERC-20 capital be injected into an already-delisted position. The primary fix is [UniswapV3AssetGuard](UniswapV3AssetGuard.md)'s `removeAssetCheck()` (blocks delisting the position-manager asset entirely while any NFT remains tracked); this guard's own check closes the same gap defensively at the call site itself, mirroring `mint`'s existing checks.

### `multicall` (recursive dispatch)

Decodes each inner call and re-invokes `txGuard()` on it, requiring every inner call to return a nonzero `txType` (`"invalid tx in multicall"`) — the same recursive pattern [MorphoVaultV2ContractGuard](MorphoVaultV2ContractGuard.md) later adopted for its own `forceDeallocate`-bundling multicall support.

### `afterTxGuard` / `afterTxGuardHandle`

```solidity
function afterTxGuard(address poolManagerLogic, address to, bytes memory data) public virtual override
```

For `mint`: reads the newly-minted `tokenId` via `nonfungiblePositionManager.tokenByIndex(totalSupply() - 1)`, records it in `NftTrackerStorage`, emits `PositionTracked`, and enforces `uniV3PositionsLimit` — a pool cannot mint past its configured maximum concurrent position count. For `burn`: removes the `tokenId` from the tracker, emits `PositionUntracked`. For `multicall`: recurses the same way `txGuard()` does, but additionally requires **at most one** mint-or-burn per multicall batch (`"invalid multicall"`) — a defensive limit on how much tracking-state churn one transaction can cause.

---

## Configuration Parameters

| Parameter | Set at | Description |
|-----------|--------|-------------|
| `nftTracker` | constructor (immutable) | The `NftTrackerStorage` instance this guard reads/writes owned `tokenId`s through |
| `uniV3PositionsLimit` | constructor | Maximum concurrent Uniswap V3 positions allowed per pool |

---

## Related

- [UniswapV3AssetGuard](UniswapV3AssetGuard.md) — valuation/withdrawal for the tracked NFT positions this guard mints/tracks; owns the FNA-48 removal-safety fix
- [UniswapV3RouterGuard](UniswapV3RouterGuard.md) — the separate guard for Uniswap V3 swap-router calls, as opposed to LP-position management
