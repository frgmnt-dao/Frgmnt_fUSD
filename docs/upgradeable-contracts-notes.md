# Upgradeable Contracts Notes

## Scope

This document records upgrade-specific notes for contracts using proxy storage. It is intended for audit review, deployment planning, and post-upgrade verification.

## TokenLogic Deposit Cap Upgrade

### Feature Summary

`TokenLogic` now supports a protocol-wide deposit threshold denominated in fUSD units.

The cap is enforced only on user deposits. PoolLogic reward and fee mints are not capped, but they still increase cap utilization so that future deposits can be blocked until fUSD is burned.

### New State

| Variable                  | Purpose                                                                   |
| ------------------------- | ------------------------------------------------------------------------- |
| `maxDepositFusdSupply`    | Maximum outstanding fUSD level at which deposits may mint additional fUSD |
| `protocolFusdOutstanding` | Tracked outstanding fUSD used for deposit-cap utilization                 |

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

## Attested Selective Withdrawal Upgrade

See `docs/attested-selective-withdrawal-design.md` for the full feature design. This section covers the upgrade-specific mechanics only.

### Feature Summary

`PoolLogic` gains `withdrawCashImmediateWithPlan()`: a user redeems fUSD for a specific, non-uniform mix of vault assets composed and signed off-chain by a new `withdrawalAttester` role, instead of the strict pro-rata slice `withdrawCashImmediate()` enforces. The pre-existing pro-rata withdrawal path (`_withdrawCashImmediateToSafe` and its internal helpers) was also relocated into the new `WithdrawalPlanLib.sol` externally-linked library in the same change — pure code motion, not a behavior change — because `PoolLogic` had no bytecode headroom left for the new feature otherwise (see that library's own file-level docs and `docs/attested-selective-withdrawal-design.md`'s "Implementation Note: Bytecode Size Budget" section).

### New State

| Variable                             | Purpose                                                                                               |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `withdrawalAttester`                 | Active signer verified (EOA or ERC-1271) against every `WithdrawalPlan`                               |
| `pendingWithdrawalAttester`          | Candidate attester awaiting its rotation delay                                                        |
| `pendingAttesterActivationTime`      | Timestamp after which `activateWithdrawalAttester()` may commit the pending candidate                 |
| `attesterRotationDelay`              | `factoryOwner`-only, floor-enforced delay between proposing and activating a new attester             |
| `consumedPlanNonce`                  | Per-user single-use nonces, preventing replay of a signed `WithdrawalPlan`                            |
| `isAttestedWithdrawEnabled`          | Independent of `isImmediateWithdrawEnabled` — manager-togglable kill switch for this feature only     |
| `attestedWithdrawVolume`             | Decaying accumulator (mirrors `SlippageAccumulator.sol`'s math) tracking attested-withdraw USD volume |
| `attestedWithdrawDecayWindow`        | Manager-settable, floor-enforced decay window for the volume accumulator                              |
| `maxAttestedWithdrawVolumePerWindow` | Manager-settable cap on decayed volume releasable via this path                                       |
| `maxSurchargeBps`                    | `factoryOwner`-only, no floor/ceiling of its own — see below                                          |

All appended strictly after `pendingCashWithdrawCount` (the previous last state variable) — `PoolLogic` has no `__gap`, so append-only ordering is what upgrade safety relies on here, same as every prior `PoolLogic` migration. `maxSurchargeBps` was added after the rest of this table and had to go strictly last too, not next to the conceptually-related `attestedWithdrawVolume` block above it.

### Surcharge (added after initial implementation)

`withdrawCashImmediateWithPlan()` withholds a small, usage-scaled slice of a withdrawal's value and retains it inside the fund, to compensate remaining stakers for the composition-skew cost this withdrawal path can create — see `docs/attested-selective-withdrawal-design.md`'s "Surcharge: Pricing the Composition-Skew Externality" section for the full rationale. Upgrade-relevant specifics:

- The real applied surcharge is bounded by `WithdrawalPlanLib.MAX_SURCHARGE_BPS_CEILING`, a hardcoded constant, regardless of what governed `maxSurchargeBps` is set to — `setMaxSurchargeBps()` (`factoryOwner`-only) itself performs no bound check, by design, to keep it the cheapest possible shape against `PoolLogic`'s tight budget.
- `CashWithdrawImmediateProRata` and `AttestedWithdrawPlanExecuted` are now emitted from inside `WithdrawalPlanLib.executeWithdrawalPlan()` rather than from `PoolLogic` — a delegatecall preserves the caller's address for the EVM's `LOG` opcode, so this doesn't change what a consumer of `PoolLogic`'s own event log sees, but it was necessary to keep this fitting in `PoolLogic`'s EIP-170 budget at all (see the design doc's "Bytecode Size Budget" section for the exact headroom numbers before and after this change). `PoolLogic` still declares both events for ABI completeness; it no longer contains the code to emit them from this path.

### Migration Requirements

- `initializeAttestedWithdrawal(address attester_, uint256 attesterRotationDelay_, uint256 attestedWithdrawDecayWindow_, uint256 maxAttestedWithdrawVolumePerWindow_, uint256 maxSurchargeBps_)` is protected by `onlyOwner` and `reinitializer(3)` — can only run once, and only after `initialize()` (version 1); it does not require `initializeAutoCompounding()` (version 2) to have run first, since `reinitializer(n)` only requires the current version be `< n`, not that every intermediate version was explicitly called. The fifth parameter, `maxSurchargeBps_`, was folded into this same initializer (rather than a later, separate migration) because this feature had not yet been deployed to any live pool when the surcharge was added — no reinitializer-version conflict to manage, so bundling had zero downside.
- Reverts `RotationDelayTooShort`/`DecayWindowTooShort` if either argument is below its respective floor (`MIN_ATTESTER_ROTATION_DELAY` = 24h, `MIN_ATTESTED_WITHDRAW_DECAY_WINDOW` = 1h) — the feature cannot launch in an already-defeated state via this call.
- **Audit finding, fixed before this upgrade shipped:** `proposeWithdrawalAttester()` (manager-gated) did not originally check that `attesterRotationDelay` had ever been set. Before this initializer runs, the delay defaults to storage-zero, so a manager could otherwise propose-then-instantly-activate an attester with no real delay — bypassing the floor entirely. `proposeWithdrawalAttester()` now reverts `AttestedWithdrawalNotInitialized` until `attesterRotationDelay != 0`, which is only ever true after this initializer or the floor-enforced `setAttesterRotationDelay()` (`factoryOwner`-only) has run. **This means `attesterRotationDelay` can legitimately become nonzero via `setAttesterRotationDelay()` alone, without this initializer ever running** — a valid alternate bootstrap path, not a bug (see `WithdrawalPlanLib`/`PoolLogic` commit history and `test/AttestedWithdrawal.test.ts`'s governance tests for both paths).
- `withdrawalAttester`'s real address is a deployment-time operational parameter — **not chosen by this codebase**. It must be the address (EOA or ERC-1271 contract) of the actual off-chain attester backend service before this migration is executed; there is no safe default.
- Must be included in the same governance/Timelock upgrade transaction as the `PoolLogic` implementation swap (via `upgradeAndCall`'s data parameter), for the same reason every other `PoolLogic` reinitializer-migration in this document is bundled atomically: leaving the proxy upgraded but uninitialized is not itself unsafe for this specific feature (the new withdrawal path simply reverts `ImmediateWithdrawalDisabled` while `isAttestedWithdrawEnabled == false`, its default), but bundling avoids an extra, separately-reviewed transaction and an unnecessary window with mismatched intended-vs-actual configuration.
- **Audit finding, fixed before this upgrade shipped:** `FundCalculationLibrary.computeImmediateWithdrawPortion()` (shared by both the pro-rata and attested-plan withdrawal paths) already computed a solvency-haircut-adjusted `fairFusd` internally, but the attested-plan path's value-conservation check originally bounded delivered value against the raw, nominal `netFusd` instead — a no-op difference while the pool is solvent, but in an underwater pool the attested path could pay out at par while the pro-rata path haircuts everyone else, extracting more than a fair share from remaining stakers (the exact loss-socialization invariant FNA-05 protects). `computeImmediateWithdrawPortion()` now returns `fairFusd` as a fourth value; `WithdrawalPlanLib.executeWithdrawalPlan()` bounds both sides of the value-conservation check against it instead, and reverts `WithdrawAmountTooSmall` (matching the pro-rata path) when it is zero. This also corrected `completeFundValue` being computed after the allocations loop instead of before, which had been handing `computeAccountedAssetsReduction` an already-withdrawal-reduced figure instead of the pre-withdrawal one its own docs specify.

### Storage Layout Notes

- No existing state variable removed, reordered, or resized.
- All new state appended strictly after `pendingCashWithdrawCount`.
- `_withdrawProcessing`/`_checkCallResult` and the pro-rata orchestration (`_withdrawCashImmediateToSafe`/`_withdrawProRata`/`_withdrawProRataInternal`/`_withdrawOne`) moved into `WithdrawalPlanLib.sol` — pure code motion, declares no storage of its own, does not affect this migration's storage-layout accounting.

### Library Linking

`PoolLogic` now also links `WithdrawalPlanLib` (in addition to the existing `FundCalculationLibrary`, `PoolTxExecutor`, `CallResultChecker`). `WithdrawalPlanLib` itself links `FundCalculationLibrary`. Confirm the deploy/upgrade script links against currently-correct addresses for every library — do not assume addresses from a prior script's comments are still current without independently re-verifying on-chain first (the OZ upgrades plugin's `forceImport`/`validateUpgrade` does not support externally-linked libraries the way `deployProxy` does; storage-layout safety for `PoolLogic` rests on this document's manual diff, same as every prior `PoolLogic` upgrade).

### Validation Notes

Expected checks before this migration executes against real deposited funds:

```bash
npx hardhat compile
npx hardhat test test/AttestedWithdrawal.test.ts
npm run test
npm run check:contract-size
```

Latest local verification for this feature (this branch):

```text
npx hardhat compile: passed
npx hardhat test test/AttestedWithdrawal.test.ts: 48 passing
npm run test: 1130 passing
npm run check:contract-size: PoolLogic at 200 bytes of EIP-170 headroom
```

STRONGLY RECOMMENDED, not yet done: dry-run the upgrade + `initializeAttestedWithdrawal()` migration against a forked copy of the actual live mainnet state before executing for real, mirroring the same recommendation already made (and not yet completed, per its own notes) for the `initializeAutoCompounding()` migration in `scripts/upgrade_core_contracts.ts`.

### Audit Focus Points

Auditors should specifically review:

- Whether `attesterRotationDelay`/`isAttestedWithdrawEnabled`/`withdrawalAttester` can be manipulated into an unsafe state via any path other than `initializeAttestedWithdrawal()` or the dedicated, floor-enforced setters — see the `proposeWithdrawalAttester()` fix above.
- Whether the two-sided value-conservation bound in `WithdrawalPlanLib.executeWithdrawalPlan()` correctly rejects both over- and under-delivery for every allocation mode (portion and fixed-amount).
- Whether the decaying volume accumulator can be pushed above `type(uint128).max` via any combination of governance settings and withdrawal sizes (see the explicit overflow guard in `WithdrawalPlanLib._checkAndRecordVolume`).
- Whether `withdrawalAttester`'s address supplied at migration time is a real, currently-operational signer before the migration is executed — this codebase has no way to validate that on-chain.
