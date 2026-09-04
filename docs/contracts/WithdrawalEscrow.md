# WithdrawalEscrow

**Source:** `contracts/contracts/WithdrawalEscrow.sol`
**Deployment:** one instance per pool, deployed and bound to it for its lifetime — never shared across pools

---

## Overview

Physically segregates a pool's finalized-but-unclaimed queued-withdrawal assets away from that pool's own balance, so guarded manager/trader transactions (investment approvals, swaps, any protocol interaction routed through `PoolLogic.execTransaction()`) can never reach funds already earmarked for a specific claimant.

> **CertiK FNA-03 history**: earlier bookkeeping capped individual or aggregate approvals against a `reservedAssetBalance` figure while the actual tokens still sat in the pool's own `balanceOf()`. Follow-up findings showed this could not fully close the gap — a spender approved *before* a reservation was created, or a second spender approved independently of the first, could still drain the "reserved" tokens, since nothing on-chain actually prevented it beyond the reservation bookkeeping itself. Physically moving the asset out of the pool's balance removes the bug class entirely: there is nothing left in the pool's balance for an unrelated approval to reach.

Deliberately minimal and non-upgradeable — the security property this contract exists to provide depends on its own logic never changing in a way the bound pool doesn't expect. Its own `balanceOf(asset)` (via plain ERC-20 balance, not tracked separately) *is* the ground truth of what's reserved for its one pool — no internal ledger to keep in sync, no risk of one pool's accounting being affected by another's.

---

## Functions

### `reserve`

```solidity
function reserve(address asset, uint256 amount) external onlyPool
```

Pulls `amount` of `asset` from the pool into the escrow via `safeTransferFrom` (the pool must have approved the escrow first — see [FundCalculationLibrary](FundCalculationLibrary.md)'s `finalizeReserveAndUpdateBaseline`, which does exactly that in the same call). Emits `Reserved`.

### `release`

```solidity
function release(address asset, uint256 amount, address recipient) external onlyPool returns (uint256 delivered)
```

Transfers `amount` to `recipient` and returns what the recipient's balance *actually* increased by, rather than assuming it equals `amount` — mirroring the same balance-delta principle as `TokenLogic._deposit()` (CertiK FNA-23): a recipient-fee asset can deliver less than the nominal amount. This contract does not independently re-validate that the asset is fee-free; it relies on the same "no fee-on-transfer, no rebasing" baseline trust assumption already documented for every supported asset in the protocol (see `docs/security.md`), and reports the real delivered amount so the caller ([FundCalculationLibrary.claimCashWithdrawRelease](FundCalculationLibrary.md)) can react correctly either way.

---

## Access Control

`onlyPool` modifier: every state-changing function reverts `OnlyPool()` unless `msg.sender == pool`, where `pool` is set once, immutably, in the constructor (reverting `ZeroAddress()` on a zero argument). No owner, no admin function, no upgrade path — the bound pool is the sole caller for the contract's entire lifetime.

---

## Related

- [PoolLogic](PoolLogic.md) — the bound pool; the sole caller of `reserve`/`release`
- [FundCalculationLibrary](FundCalculationLibrary.md) — `finalizeReserveAndUpdateBaseline()` calls `reserve()`, `claimCashWithdrawRelease()` calls `release()`
