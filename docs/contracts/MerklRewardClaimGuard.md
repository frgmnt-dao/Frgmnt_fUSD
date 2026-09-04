# MerklRewardClaimGuard

**Source:** `contracts/contracts/guards/contractGuards/MerklRewardClaimGuard.sol`
**Registered in Governance against:** Merkl's Distributor contract address (one shared registration, not per-integration)

---

## Overview

Claim-only guard allowing `PoolLogic.execTransaction()` to claim Merkl-distributed incentive rewards. Deliberately protocol-agnostic: Merkl's Distributor is shared infrastructure that any integrated protocol's incentive campaigns settle through (Morpho Blue, Aave V4 Spoke, and any future integration), all via the same standard `claim(address[],address[],uint256[],bytes32[][])` interface. A single instance of this guard, registered once against Merkl's Distributor address, covers every Merkl-sourced reward stream a pool is exposed to — not just one integration's.

> **CertiK FNA-19**: this contract was previously named `MorphoBlueRewardClaimGuard`, which read as Morpho-specific and left Aave V4 Spoke's own Merkl/Points supply incentives unclaimable even though the on-chain claim mechanism this guard already validated was identical. Renamed rather than building a redundant second guard — stateless guards can be re-registered against a new target without redeployment, so no new contract was needed, only a rename and Governance re-registration.

Rewards are transferred directly to `PoolLogic` by the Distributor itself — this guard only validates the claim call's shape, it does not move funds. A claimed `payoutToken` only counts toward fund NAV once governance separately registers it as a supported asset (`changeAssets()` + [ERC20Guard](ERC20Guard.md)), the same as any other ERC-20 balance the pool happens to hold.

---

## Functions

### `txGuard`

```solidity
function txGuard(address poolManagerLogic, address to, bytes calldata data) external returns (uint16 txType, bool isPublic)
```

Only allows the `claim()` selector — any other call reverts with `"invalid method"`. `_handleClaim` decodes the call and requires `users.length == 1` and `users[0] == poolLogic` — rewards can only ever be claimed on behalf of the pool itself, never redirected to another address or claimed for a batch including other users. Returns `TransactionType.MerklRewardClaim`. `isPublic = false` — manager/trader only.

### `afterTxGuard`

Implements `ITxTrackingGuard` (`isTxTrackingGuard = true`) purely to re-assert `msg.sender == poolLogic` post-execution — no state bookkeeping happens here, unlike [UniswapV3NonfungiblePositionGuard](UniswapV3NonfungiblePositionGuard.md)'s NFT-tracking use of the same hook.

---

## Deliberately Out of Scope

- **Accounting**: recognizing a claimed reward token's USD value against pool NAV is handled off-cycle by the manager (via `changeAssets()`), not automatically by this guard.

---

## Related

- [AaveV4SpokeContractGuard](AaveV4SpokeContractGuard.md) — explicitly documents Merkl claims as out of its own scope, deferring to this guard
- [ERC20Guard](ERC20Guard.md) — the guard a claimed reward token uses once registered as a supported asset
