# AaveV4TokenizationContractGuard

**Source:** `contracts/contracts/guards/contractGuards/AaveV4TokenizationContractGuard.sol`
**Registered in Governance against:** each individual TokenizationSpoke vault address (unlike `AaveV4SpokeContractGuard`, which registers against the shared PositionManager singletons)

---

## Overview

Gates manager/trader-initiated Aave V4 TokenizationSpoke operations (`deposit`/`mint`/`withdraw`/`redeem`) executed through `PoolLogic.execTransaction()`. A TokenizationSpoke is a standard ERC-4626 vault wrapping a single Hub asset — structurally identical to a Morpho Vault V2 instance — so this guard closely mirrors [MorphoVaultV2ContractGuard](MorphoVaultV2ContractGuard.md). It deposits/withdraws directly against Aave's Liquidity Hub, bypassing the main lending Spoke entirely, so — like Morpho Vault V2 — there is no debt, no liquidation risk, and no `afterTxGuard`/`ITxTrackingGuard` implementation.

The automatic pro-rata `withdrawProcessing()` path lives in [AaveV4TokenizationAssetGuard](AaveV4TokenizationAssetGuard.md); this guard covers the manual, manager-directed `execTransaction()` path.

---

## Functions

### `txGuard`

```solidity
function txGuard(address poolManagerLogic, address to, bytes calldata data) external returns (uint16 txType, bool isPublic)
```

Every operation requires the target vault to be a registered supported asset of the pool. Beyond that, the `AaveV4TokenizationManager` allowlist check differs by **direction** (CertiK FNA-51):

| Selector | Handler | Vault allowlist gate | Receiver/owner restriction |
|----------|---------|-----------------------|------------------------------|
| `deposit(assets, receiver)` | `_handleDeposit` | **active** (`isValidPoolVault`) | `receiver == pool` |
| `mint(shares, receiver)` | `_handleMint` | **active** | `receiver == pool` |
| `withdraw(assets, receiver, owner)` | `_handleWithdraw` | **tracked** (`isTrackedPoolVault`) | `receiver == pool` and `owner == pool` |
| `redeem(shares, receiver, owner)` | `_handleRedeem` | **tracked** | `receiver == pool` and `owner == pool` |

Withdraw/redeem deliberately gate on the tracked, not active, set — so a delisted vault can still be unwound manually, matching `AaveV4TokenizationAssetGuard`'s own automatic path (which never consults either allowlist at all). The receiver/owner restrictions ensure minted shares or withdrawn assets can never be redirected to an address other than the pool itself.

---

## Configuration

| Parameter | Set at | Description |
|-----------|--------|-------------|
| `aaveV4TokenizationManager` | constructor (immutable) | The [AaveV4TokenizationManager](AaveV4TokenizationManager.md) allowlist consulted for every vault check |

Stateless, immutable-configured contract — no owner-settable parameters.

---

## Related

- [AaveV4TokenizationManager](AaveV4TokenizationManager.md) — the active/tracked vault allowlist this guard reads
- [AaveV4TokenizationAssetGuard](AaveV4TokenizationAssetGuard.md) — the automatic pro-rata withdrawal path
- [MorphoVaultV2ContractGuard](MorphoVaultV2ContractGuard.md) — the structurally identical Morpho Vault V2 analog
