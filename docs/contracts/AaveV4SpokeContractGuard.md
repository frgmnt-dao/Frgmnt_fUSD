# AaveV4SpokeContractGuard

**Source:** `contracts/contracts/guards/contractGuards/AaveV4SpokeContractGuard.sol`
**Registered in Governance against:** `GiverPositionManager` **and** `TakerPositionManager` (both singletons, shared across every Spoke/reserve) — **not** against any Spoke address. The Spoke being acted on is passed as a parameter of the call, not as `to`.

---

## Overview

Gates manager/trader-initiated Aave V4 Spoke supply/withdraw operations executed through `PoolLogic.execTransaction()`. This integration deliberately supports **supply-only** — `borrowOnBehalfOf`, `approveBorrow`, and any debt-repayment selectors are simply not handled here, falling through to `TransactionType.NotUsed` and reverting via `PoolTxExecutor`. "No borrowing on Aave V4" is enforced at the guard level, not by convention.

The automatic pro-rata `withdrawProcessing()` path lives in [AaveV4SpokeAssetGuard](AaveV4SpokeAssetGuard.md); this guard covers the **manual**, manager-directed path via `execTransaction()` — supply, and the two-step Taker-mediated withdrawal (`approveWithdraw` then `withdrawOnBehalfOf`).

---

## Critical Security Property

Aave V4's `withdrawOnBehalfOf` sends withdrawn funds to `msg.sender` (the caller), **not** to `onBehalfOf` — `onBehalfOf` only identifies whose position is debited. Withdrawing requires a prior `approveWithdraw(spoke, reserveId, spender, amount)` granting `spender` an allowance. `_handleApproveWithdraw` enforces `spender == pool` unconditionally — the single most important check in this contract. If `spender` could ever be anything else, that address could call `withdrawOnBehalfOf` directly, bypassing this guard entirely, and receive the pool's funds.

---

## Functions

### `txGuard`

```solidity
function txGuard(address poolManagerLogic, address /* to */, bytes calldata data) external returns (uint16 txType, bool isPublic)
```

Dispatches on the calldata's selector to one of three handlers. Every operation requires the target Spoke to be a registered supported asset of the pool. Beyond that, the reserveId check differs by **direction** (CertiK FNA-10):

| Selector | Handler | reserveId gate | `onBehalfOf`/`spender` |
|----------|---------|-----------------|--------------------------|
| `IGiverPositionManager.supplyOnBehalfOf` | `_handleSupply` | **active** allowlist (`isValidPoolReserve`) — new exposure only into governance-sanctioned reserves | `onBehalfOf == pool` |
| `ITakerPositionManager.approveWithdraw` | `_handleApproveWithdraw` | **tracked** set (`isTrackedPoolReserve`) — includes delisted-but-not-yet-empty reserves | `spender == pool` (the critical check above) |
| `ITakerPositionManager.withdrawOnBehalfOf` | `_handleWithdraw` | **tracked** set | `onBehalfOf == pool` |

Withdraw-side operations deliberately gate on the *tracked*, not active, set — so a reserve the protocol owner has since delisted can still be unwound through this manual path, matching `AaveV4SpokeAssetGuard`'s own automatic `withdrawProcessing()` (which already iterates the tracked set).

### `_requireSupportedUnderlying` (CertiK FNA-44)

Neither the Spoke-level `isSupportedAsset` check nor the reserveId allowlist ever resolves the reserve's actual underlying ERC-20 — Aave V4 addresses a market as `(spoke, reserveId)`, not by the underlying's own address. This resolves the underlying via the same trusted `getReserve(uint256)` raw-staticcall pattern [AaveV4SpokeAssetGuard](AaveV4SpokeAssetGuard.md) uses, and requires it to be a supported pool asset — **reverting** (not failing open) on an unresolvable reserve, since this is a fund-moving transaction gate, not a passive valuation read. The withdraw-side check deliberately does *not* relax for a delisted underlying the way tracked-vs-active does for the reserve itself: withdrawing into an unsupported idle balance is strictly worse than leaving the position parked in the still-valued Spoke.

### `_requireActiveReserve` / `_requireTrackedReserve`

Shared validation helpers: both require the Spoke to be `isSupportedAsset`, both call `_requireSupportedUnderlying`, and they differ only in which reserveId set (active vs. tracked) they consult — see the table above.

---

## Deliberately Out of Scope

- **Merkl/Points reward claims** (CertiK FNA-19): this guard does not handle Aave V4's incentive claims. Those settle through Merkl's own Distributor contract, a separate target with a generic `claim()` interface shared across every Merkl-integrated protocol. See [MerklRewardClaimGuard](MerklRewardClaimGuard.md), registered separately against Merkl's Distributor address.

---

## Configuration

| Parameter | Set at | Description |
|-----------|--------|-------------|
| `aaveV4SpokeManager` | constructor (immutable) | The [AaveV4SpokeManager](AaveV4SpokeManager.md) allowlist consulted for every reserveId check |

Stateless, immutable-configured contract — no owner-settable parameters.

---

## Related

- [AaveV4SpokeManager](AaveV4SpokeManager.md) — the active/tracked reserve allowlist this guard reads
- [AaveV4SpokeAssetGuard](AaveV4SpokeAssetGuard.md) — the automatic pro-rata withdrawal path, and the source of `_requireSupportedUnderlying`'s reserve-decoding pattern
- [MerklRewardClaimGuard](MerklRewardClaimGuard.md) — handles Merkl reward claims for this and other integrations
