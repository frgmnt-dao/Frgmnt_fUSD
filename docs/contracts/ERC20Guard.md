# ERC20Guard

**Source:** `contracts/contracts/guards/assetGuards/ERC20Guard.sol`
**Asset Type:** `4` (Standard ERC20) — see [Governance's Asset Type Registry](Governance.md#asset-type-registry) for the on-chain-verified mapping (CertiK FNA-33)

---

## Overview

ERC20Guard is the asset guard for standard ERC20 tokens held in the vault. It validates `approve()` calls executed by the vault (the only call it authorizes at all), computes proportional withdrawal amounts, and enforces that assets cannot be removed while a balance remains.

---

## Functions

### `txGuard`

```solidity
function txGuard(address poolManagerLogic, address to, bytes calldata data) external override returns (uint16 txType, bool isPublic)
```

Only handles `approve(address spender, uint256 amount)` on `to` (the ERC20 asset). Any other selector returns `(0, false)` — a no-op, not a revert.

**Validation:**
- `spender` must have a registered contract guard in `Governance`, and that guard must not be this generic `ERC20Guard` itself (`UnsupportedApproval()`) — approvals may only target whitelisted protocol contracts, never an arbitrary address.
- **CertiK FNA-03 follow-up**: if the asset has a nonzero `reservedAssetBalance` (liquidity earmarked for a finalized-but-unclaimed queued withdrawal), the approval is capped: it reverts (`ApprovalExceedsUnreservedBalance()`) unless `amount <= unreservedBalance` **or** `amount <= the spender's existing allowance already` (a reduction, or no change, is never a new risk). `approve()` does not move `balanceOf`, so `PoolTxExecutor`'s post-call reserved-balance check can never catch an over-large approval here — once granted, the spender can call `transferFrom()` directly at any later time of their choosing, entirely outside this pool's own guarded transaction flow, draining liquidity reserved for a withdrawal claim long after this `approve()` call itself passed every check. Blocking it at the source is the only place this can actually be caught.

### `withdrawProcessing`

```solidity
function withdrawProcessing(address pool, address asset, uint256 portion, address) external virtual override returns (address withdrawAsset, uint256 withdrawAmount, MultiTransaction[] memory txs)
```

`withdrawAmount = (balance - reservedAssetBalance[asset]) * portion / 1e18` (reserved capped at `balance` if larger). Returns `txs` empty — a plain ERC-20 withdrawal needs no extra transactions; `PoolLogic` uses `(withdrawAsset, withdrawAmount)` directly.

### `getBalance` / `getDecimals`

Plain passthroughs to `IERC20(asset).balanceOf(pool)` / `IERC20Extended(asset).decimals()`.

### `removeAssetCheck` (CertiK FNA-53)

```solidity
function removeAssetCheck(address pool, address asset) public view virtual override
```

Reverts (`NonZeroAssetBalance()`) only if the pool holds a nonzero balance of `asset`. The cross-asset dependency check that used to live here too (asking every *other* supported asset's guard whether it still depends on `asset`, via `removeTokenCheck()`) moved to `PoolManagerLogic._removeAsset()` itself — it now runs for every removal regardless of the candidate's own guard type, not only when the candidate happens to be ERC20Guard-typed. See [PoolManagerLogic](PoolManagerLogic.md)'s own documentation.

### `removeTokenCheck`

Always returns `true` (permissive) — a plain ERC-20 balance is never itself the *underlying* token of some other position, so there is nothing for it to block.

---

## Events

| Event | Emitted When |
|-------|-------------|
| `Approve` | A valid `approve()` call passes every check |

---

## Access Control

ERC20Guard is called exclusively by `PoolLogic`/`PoolManagerLogic` as part of the guard dispatch flow. It has no owner or privileged roles — every check is either structural (spender must have a registered guard) or state-derived (reserved balance).

---

## Related

- [PoolManagerLogic](PoolManagerLogic.md) — hosts the FNA-53 centralized cross-asset removal check this guard's `removeAssetCheck()` no longer performs itself
- [WithdrawalEscrow](WithdrawalEscrow.md) — the FNA-03 fix's complementary contract-level mechanism (physically segregating reserved funds) for the class of bug this guard's approval cap defends against at the approval layer
