# Upgradeable Contracts Notes

## Scope

This document records upgrade-specific notes for contracts using proxy storage. It is intended for audit review, deployment planning, and post-upgrade verification.

## TokenLogic Deposit Cap Upgrade

### Feature Summary

`TokenLogic` now supports a protocol-wide deposit threshold denominated in fUSD units.

The cap is enforced only on user deposits. PoolLogic reward and fee mints are not capped, but they still increase cap utilization so that future deposits can be blocked until fUSD is burned.

### New State

| Variable | Purpose |
|----------|---------|
| `maxDepositFusdSupply` | Maximum outstanding fUSD level at which deposits may mint additional fUSD |
| `protocolFusdOutstanding` | Tracked outstanding fUSD used for deposit-cap utilization |

`protocolFusdOutstanding` is updated in the ERC20 `_update` hook:

- Mint: increases `protocolFusdOutstanding`
- Burn: decreases `protocolFusdOutstanding`
- Transfer: no change

This means deposits, PoolLogic reward mints, manager fee mints, harvest mints, cash-withdraw burns, and user burns all update the tracker consistently.

### Deposit Enforcement

Deposits enforce:

```solidity
protocolFusdOutstanding + fusdAmount <= maxDepositFusdSupply
```

If the check fails, the deposit reverts with:

```text
TokenLogic: deposit cap exceeded
```

PoolLogic mints through `mintFromPool()` do not enforce this cap.

### Legacy Per-Asset Cap

`AssetConfig.cap_` and `setAssetCap()` are retained for storage and ABI compatibility, but per-asset caps are no longer enforced on deposits.

Operators should use:

```solidity
setMaxDepositFusdSupply(uint256 newCap)
```

for the active deposit threshold.

## Fresh Deployment Checklist

For a new deployment with no existing fUSD supply:

1. Deploy and initialize `TokenLogic`.
2. Set the deposit threshold:

```solidity
setMaxDepositFusdSupply(10_000e18)
```

3. Configure supported deposit assets.
4. Verify `protocolFusdOutstanding == 0`.
5. Verify deposits revert once `protocolFusdOutstanding` would exceed `maxDepositFusdSupply`.

## Upgrade Migration Checklist

For an existing proxy with already minted fUSD, new storage variables start at zero after the implementation upgrade. The tracker must be initialized once so existing supply is counted.

After upgrading `TokenLogic`, governance must call:

```solidity
initializeDepositFusdCap(uint256 newCap)
```

This sets:

```solidity
protocolFusdOutstanding = totalSupply();
maxDepositFusdSupply = newCap;
```

Example:

```text
Before upgrade:
totalSupply = 50,000 fUSD

After upgrade, before migration:
protocolFusdOutstanding = 0
maxDepositFusdSupply = 0

After initializeDepositFusdCap(100,000e18):
protocolFusdOutstanding = 50,000 fUSD
maxDepositFusdSupply = 100,000 fUSD
```

Remaining deposit capacity:

```text
100,000 - 50,000 = 50,000 fUSD
```

### Migration Requirements

- `initializeDepositFusdCap()` is protected by `onlyRole(DEFAULT_ADMIN_ROLE)`.
- `initializeDepositFusdCap()` is protected by `reinitializer(2)` and can only be executed once.
- The migration must be included in the governance/timelock upgrade execution plan.
- If the cap is intended to be 10,000 fUSD, pass `10_000e18`.
- If existing `totalSupply()` is already above the new cap, new deposits will remain blocked until burns reduce `protocolFusdOutstanding` below the cap.

## Storage Layout Notes

Upgradeable storage safety requirements:

- Do not remove or reorder existing state variables.
- Do not remove or reorder fields in `AssetConfig`.
- New variables were appended after existing storage.
- Storage gap was reduced to account for the new variables.

Current new variables added:

```solidity
uint256 public maxDepositFusdSupply;
uint256 public protocolFusdOutstanding;
```

Storage gap change:

```solidity
uint256[40] private __gap;
```

changed to:

```solidity
uint256[38] private __gap;
```

## Validation Notes

Expected checks before audit submission:

```bash
npx hardhat compile
npx hardhat test test/TokenLogic.test.ts
npm run test
```

Latest local verification for this feature:

```text
npx hardhat compile: passed
npx hardhat test test/TokenLogic.test.ts: 28 passing
npm run test: 508 passing
```

Hardhat Upgrades prints an informational warning that reinitializers are not included in validations by default. `initializeDepositFusdCap()` is a state-migration reinitializer and intentionally does not call parent initializers.

Do not add `@custom:oz-upgrades-validate-as-initializer` to this migration function unless it is refactored to satisfy the parent-initializer validation expectations.

## Audit Focus Points

Auditors should specifically review:

- Whether the intended cap is a deposit threshold, not a hard reward-mint cap.
- Whether `protocolFusdOutstanding` stays aligned with mints and burns through `_update`.
- Whether arbitrary transfers leave `protocolFusdOutstanding` unchanged.
- Whether PoolLogic rewards and fee mints can exceed `maxDepositFusdSupply` while still blocking future deposits.
- Whether burn paths restore deposit capacity as expected.
- Whether the upgrade migration initializes `protocolFusdOutstanding` from existing `totalSupply()`.
- Whether governance scripts include the migration call immediately after upgrade.
