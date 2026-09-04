# MorphoVaultV2ContractGuard

**Source:** `contracts/contracts/guards/contractGuards/MorphoVaultV2ContractGuard.sol`
**Registered in Governance against:** each individual Morpho Vault V2 instance address (one registration per vault, same pattern as `AaveV4TokenizationContractGuard`)

---

## Overview

Gates manager/trader-initiated Morpho Vault V2 operations (`deposit`/`mint`/`withdraw`/`redeem`/`multicall`) executed through `PoolLogic.execTransaction()`. A Morpho Vault V2 instance is a standard ERC-4626 vault that routes deposits across curator-selected adapters (see [Morpho's Vault V2 docs](https://docs.morpho.org/learn/concepts/vault-v2/)) — structurally identical to an Aave V4 TokenizationSpoke, so this guard closely mirrors [AaveV4TokenizationContractGuard](AaveV4TokenizationContractGuard.md). A Vault V2 position carries no debt and therefore no liquidation risk, so there is no `afterTxGuard`/`ITxTrackingGuard` implementation here either.

The automatic pro-rata `withdrawProcessing()` path lives in [MorphoVaultV2AssetGuard](MorphoVaultV2AssetGuard.md); this guard covers the manual, manager-directed `execTransaction()` path — including the manager-only `forceDeallocate` recovery mechanism the asset guard deliberately does not use automatically.

Every operation additionally requires the vault's own underlying asset (`IERC4626(vault).asset()`) to itself be a registered supported asset of the pool — the vault being supported says nothing about its underlying being supported too, since they're registered independently via `changeAssets()`. Without this check, a manager could register a vault whose underlying was never added to the pool, then convert between vault shares (counted in `totalFundValue()`) and the raw underlying (uncounted, if never separately added) to produce an artificial swing in reported TVL/share price. Every sibling contract guard in this codebase (`AaveLendingPoolGuardV3`, `MorphoBlueContractGuard`) already enforces this on both directions; this mirrors that pattern.

---

## Functions

### `txGuard`

```solidity
function txGuard(address poolManagerLogic, address to, bytes calldata data) external returns (uint16 txType, bool isPublic)
```

Every operation requires the target vault to be a registered supported asset of the pool. Beyond that, the `MorphoVaultV2Manager` allowlist check differs by **direction** (CertiK FNA-51):

| Selector | Handler | Vault allowlist gate | Receiver/owner restriction |
|----------|---------|-----------------------|------------------------------|
| `deposit(assets, receiver)` | `_handleDeposit` | **active** (`isValidPoolVault`) | `receiver == pool` |
| `mint(shares, receiver)` | `_handleMint` | **active** | `receiver == pool` |
| `withdraw(assets, receiver, owner)` | `_handleWithdraw` | **tracked** (`isTrackedPoolVault`) | `receiver == pool` and `owner == pool` |
| `redeem(shares, receiver, owner)` | `_handleRedeem` | **tracked** | `receiver == pool` and `owner == pool` |
| `multicall(bytes[])` | `_handleMulticall` | delegates to the legs it decodes (see below) | delegates to the legs it decodes |

Withdraw/redeem deliberately gate on the tracked, not active, set — so a delisted vault can still be unwound manually, matching `MorphoVaultV2AssetGuard`'s own automatic `withdrawProcessing()` (which never consults either allowlist at all). A bare `forceDeallocate` call is **not** dispatched by this switch at all — falls through to `TransactionType.NotUsed` — it is only ever reachable as a leg inside `multicall` (see below, CertiK FNA-46).

### `_handleMulticall` (CertiK FNA-46)

```solidity
function _handleMulticall(address poolLogic, address vault, address poolManagerLogic, bytes memory params) internal returns (uint16 txType)
```

The only way to reach `forceDeallocate`. Decodes the vault's native `multicall(bytes[])` and requires every leg but the last to be a validated `forceDeallocate` (tracked-vault-gated, `onBehalf == pool`, adapter must be registered on the vault via `isAdapter`), with the **last** leg required to be exactly one pool-bound `withdraw` or `redeem`. A batch of zero `forceDeallocate` legs (just the withdraw/redeem) is permitted; a batch ending in anything else — including another `forceDeallocate` — reverts.

> **Why atomicity matters**: a standalone `forceDeallocate` burns the pool's penalty shares and moves the freed assets into the vault's *shared* idle liquidity, not to the caller. Between that call and a separate, later withdraw/redeem, any other vault shareholder can withdraw against that same freed liquidity first — the pool pays the penalty and still doesn't get its exit. Bundling both legs into one atomic `multicall` transaction closes that race: no other shareholder gets a window between the two legs. Mirrors the recursive `txGuard()`-call pattern `UniswapV3RouterGuard` already uses for its own multicall support.

### `_requireActiveVault` / `_requireTrackedVault` / `_requireUnderlyingSupported`

Shared validation helpers. The first two both require the vault to be `isSupportedAsset` and differ only in which `MorphoVaultV2Manager` set (active vs. tracked) they consult — see the table above. `_requireUnderlyingSupported` is the underlying-asset check described in the Overview, called by every per-operation handler.

---

## Deployment Note

Onboarding a new vault instance for active manager/trader use is a four-step process, all required before deposit/mint/withdraw/redeem can succeed via `execTransaction`:

1. `Governance.setContractGuard(vaultAddress, address(this))` — registered per vault address. Without this, `PoolTxExecutor` never reaches this guard for that vault; it falls through to the asset guard's `txGuard`, which is intentionally a no-op (see [ClosedAssetGuard](ClosedAssetGuard.md)), so `execTransaction` simply reverts with `InvalidTransaction`.
2. `MorphoVaultV2Manager.setPoolVaults(pool, [...])` — the protocol-owner whitelist.
3. `PoolManagerLogic.changeAssets()` — registers the vault itself as a supported asset (running `MorphoVaultV2AssetGuard.addAssetCheck`, which re-checks step 2).
4. `PoolManagerLogic.changeAssets()` again — separately registers the vault's own underlying token as a supported asset. Independent of step 3 and easy to miss: registering the vault does not register its underlying, and vice versa. Skipping this step blocks every deposit/mint/withdraw/redeem call against *this* vault (reverts with "underlying not supported") without affecting other already-supported assets.

Missing step (1) only blocks the manual `execTransaction` path — it does not affect valuation (`getBalance`) or the automatic `withdrawProcessing()` path, both of which run independently of this contract guard.

---

## Configuration

| Parameter | Set at | Description |
|-----------|--------|-------------|
| `morphoVaultV2Manager` | constructor (immutable) | The [MorphoVaultV2Manager](MorphoVaultV2Manager.md) allowlist consulted for every vault check |

Stateless, immutable-configured contract — no owner-settable parameters.

---

## Related

- [MorphoVaultV2Manager](MorphoVaultV2Manager.md) — the active/tracked vault allowlist this guard reads
- [MorphoVaultV2AssetGuard](MorphoVaultV2AssetGuard.md) — the automatic pro-rata withdrawal path
- [AaveV4TokenizationContractGuard](AaveV4TokenizationContractGuard.md) — the structurally identical Aave V4 Tokenization analog
