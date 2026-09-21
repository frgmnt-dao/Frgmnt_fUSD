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

`PoolLogic` gains `withdrawCashImmediateWithPlan()`: a user redeems fUSD for a specific, non-uniform mix of vault assets composed and signed off-chain by a new `withdrawalAttester` role, instead of the strict pro-rata slice `withdrawCashImmediate()` enforces. Each allocation in the plan names the asset, the guard the attester validated (bound to the pool's current guard, `GuardMismatch` otherwise), optionally the individual positions inside a guard that fronts several (Aave V4 Spoke reserves, Morpho Blue markets; requires the new selective guards), and the amount; the plan also carries the attester's ceiling on the usage surcharge. The pre-existing pro-rata withdrawal path (`_withdrawCashImmediateToSafe` and its internal helpers) was also relocated into the new `WithdrawalPlanLib.sol` externally-linked library in the same change — pure code motion, not a behavior change — because `PoolLogic` had no bytecode headroom left for the new feature otherwise (see that library's own file-level docs and `docs/attested-selective-withdrawal-design.md`'s "Implementation Note: Bytecode Size Budget" section).

### New State

| Variable                             | Purpose                                                                                                                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `withdrawalAttester`                 | Active signer verified (EOA or ERC-1271) against every `WithdrawalPlan`                                                                                                          |
| `pendingWithdrawalAttester`          | Candidate attester awaiting its rotation delay                                                                                                                                   |
| `pendingAttesterActivationTime`      | Timestamp after which `activateWithdrawalAttester()` may commit the pending candidate                                                                                            |
| `attesterRotationDelay`              | `factoryOwner`-only, floor-enforced delay between proposing and activating a new attester                                                                                        |
| `consumedPlanNonce`                  | Per-user single-use nonces, preventing replay of a signed `WithdrawalPlan`                                                                                                       |
| `isAttestedWithdrawEnabled`          | Independent of `isImmediateWithdrawEnabled` — kill switch for this feature only; the manager may toggle it, except while the `factoryOwner`'s stop is latched                    |
| `attestedWithdrawVolume`             | Decaying accumulator (mirrors `SlippageAccumulator.sol`'s math) tracking attested-withdraw USD volume                                                                            |
| `attestedWithdrawDecayWindow`        | Manager-settable, floor-enforced decay window for the volume accumulator                                                                                                         |
| `maxAttestedWithdrawVolumePerWindow` | Manager-settable cap on decayed volume releasable via this path                                                                                                                  |
| `maxSurchargeBps`                    | `factoryOwner`-only, no floor/ceiling of its own — see below                                                                                                                     |
| `attestedWithdrawOwnerStopped`       | Latched by the `factoryOwner` disabling the feature; the manager cannot re-enable while set; only the `factoryOwner` lifts it, and lifting it does not itself enable the feature |

All appended strictly after `pendingCashWithdrawCount` (the previous last state variable) — `PoolLogic` has no `__gap`, so append-only ordering is what upgrade safety relies on here, same as every prior `PoolLogic` migration. `maxSurchargeBps` and then `attestedWithdrawOwnerStopped` were added after the rest of this table and had to go strictly last too, not next to conceptually related variables above them.

### Surcharge (added after initial implementation)

`withdrawCashImmediateWithPlan()` withholds a small, usage-scaled slice of a withdrawal's value and retains it inside the fund, as extra collateral (it is not paid out and not credited as yield) to cushion remaining holders against the composition-skew cost this withdrawal path can create — see `docs/attested-selective-withdrawal-design.md`'s "Surcharge: Pricing the Composition-Skew Externality" section for the full rationale. Upgrade-relevant specifics:

- The real applied surcharge is bounded by `WithdrawalPlanLib.MAX_SURCHARGE_BPS_CEILING`, a hardcoded constant, regardless of what governed `maxSurchargeBps` is set to — `setMaxSurchargeBps()` (`factoryOwner`-only) itself performs no bound check, by design, to keep it the cheapest possible shape against `PoolLogic`'s tight budget.
- `CashWithdrawImmediateProRata` and `AttestedWithdrawPlanExecuted` are now emitted from inside `WithdrawalPlanLib.executeWithdrawalPlan()` rather than from `PoolLogic` — a delegatecall preserves the caller's address for the EVM's `LOG` opcode, so this doesn't change what a consumer of `PoolLogic`'s own event log sees, but it was necessary to keep this fitting in `PoolLogic`'s EIP-170 budget at all (see the design doc's "Bytecode Size Budget" section for the exact headroom numbers before and after this change). `PoolLogic` still declares both events for ABI completeness; it no longer contains the code to emit them from this path.

### Migration Requirements

- `initializeAttestedWithdrawal(address attester_, uint256 attesterRotationDelay_, uint256 attestedWithdrawDecayWindow_, uint256 maxAttestedWithdrawVolumePerWindow_, uint256 maxSurchargeBps_)` is protected by `onlyOwner` and `reinitializer(3)` — can only run once, and only after `initialize()` (version 1); it does not require `initializeAutoCompounding()` (version 2) to have run first, since `reinitializer(n)` only requires the current version be `< n`, not that every intermediate version was explicitly called. The fifth parameter, `maxSurchargeBps_`, was folded into this same initializer (rather than a later, separate migration) because this feature had not yet been deployed to any live pool when the surcharge was added — no reinitializer-version conflict to manage, so bundling had zero downside.
- Reverts `RotationDelayTooShort`/`DecayWindowTooShort` if either argument is below its respective floor (`MIN_ATTESTER_ROTATION_DELAY` = 24h, `MIN_ATTESTED_WITHDRAW_DECAY_WINDOW` = 1h) — the feature cannot launch in an already-defeated state via this call.
- **Internal review finding, fixed before this upgrade shipped:** `proposeWithdrawalAttester()` (manager-gated) did not originally check that `attesterRotationDelay` had ever been set. Before this initializer runs, the delay defaults to storage-zero, so a manager could otherwise propose-then-instantly-activate an attester with no real delay — bypassing the floor entirely. `proposeWithdrawalAttester()` now reverts `AttestedWithdrawalNotInitialized` until `attesterRotationDelay != 0`, which is only ever true after this initializer or the floor-enforced `setAttesterRotationDelay()` (`factoryOwner`-only) has run. **This means `attesterRotationDelay` can legitimately become nonzero via `setAttesterRotationDelay()` alone, without this initializer ever running** — a valid alternate bootstrap path, not a bug (see `WithdrawalPlanLib`/`PoolLogic` commit history and `test/AttestedWithdrawal.test.ts`'s governance tests for both paths).
- `withdrawalAttester`'s real address is a deployment-time operational parameter — **not chosen by this codebase**. It must be the address (EOA or ERC-1271 contract) of the actual off-chain attester backend service before this migration is executed; there is no safe default.
- **Migration sequence (one atomic Safe batch, in this order).** (1) `ProxyAdmin.upgradeAndCall(proxy, newImpl, "0x")` with EMPTY init data; (2) `initializeAutoCompounding()` (`reinitializer(2)`), only if the live pool has not run it; (3) `initializeAttestedWithdrawal(...)` (`reinitializer(3)`). The initializers are `onlyOwner`, and inside `upgradeAndCall`'s delegatecall `msg.sender` is the ProxyAdmin, not the owner — so passing the initializer as `upgradeAndCall` data reverts `OwnableUnauthorizedAccount`; they must be separate transactions sent by the Safe, made atomic by its MultiSend batch. When the audit -> `feature/06-aave-v4` upgrade is performed with `scripts/upgrade_core_contracts.ts`, that batch also wires the `WithdrawalEscrow` (see "Post-upgrade step inherited from the validated baseline" below). **Order matters:** if step 3 runs before step 2, the version-2 initializer permanently reverts `InvalidInitialization`, `compoundedRewardIndex` stays 0, and stake/unstake/harvest are dead until another implementation upgrade (`reinitializer(3)` not requiring version 2 is technically true, and is the trap). `scripts/upgrade_attested_withdrawal.ts` reads `compoundedRewardIndex` on the live proxy and includes step 2 automatically when it is 0 or the call reverts; `test/AttestedWithdrawal.test.ts` pins all three behaviours against a transparent proxy.
- **The live proxy is not on the CertiK-validated implementation.** It runs the older `audit`-branch implementation at initializer version 1 with no `compoundedRewardIndex`; the `audit` -> `feature/06-aave-v4` upgrade (`scripts/upgrade_core_contracts.ts`) has not been executed. From the live layout this branch appends 17 variables (slots 17-33), verified by diffing compiler storage-layout output and by `test/UpgradeFromAudit.test.ts`, which upgrades a proxy running the real `audit` implementation (slots 0-22 byte-identical before and after). Append-only holds.
- **The initializer leaves the feature disabled** (`isAttestedWithdrawEnabled == false`). The withdrawal path pays out user funds on the strength of a hot attester key, so it must not go live as a side effect of an upgrade transaction: the manager enables it with `setAttestedWithdrawEnabled(true)` only after the attester service and its parameters are verified. The new path reverts `ImmediateWithdrawalDisabled` until then.
- **Before enabling: attester service checklist.** The reference service is `services/attester/` (see its README). Deploy it with the attester key held in a KMS or HSM (implement `PlanSigner`), its config pointing at this pool's `FundCalculationLibrary` and the allowed plain assets, behind a TLS proxy on a private network. Confirm it refuses with `ATTESTER_MISMATCH` until the pool's `withdrawalAttester` is its address, that a plan it signs simulates and executes against a fork of the live pool state, and that alerts exist for `SIMULATION_FAILED` refusals and for plans signed but never executed. Run one instance per pool.
- **Internal review finding, fixed before this upgrade shipped:** `FundCalculationLibrary.computeImmediateWithdrawPortion()` (shared by both the pro-rata and attested-plan withdrawal paths) already computed a solvency-haircut-adjusted `fairFusd` internally, but the attested-plan path's value-conservation check originally bounded delivered value against the raw, nominal `netFusd` instead — a no-op difference while the pool is solvent, but in an underwater pool the attested path could pay out at par while the pro-rata path haircuts everyone else, extracting more than a fair share from remaining stakers (the exact loss-socialization invariant FNA-05 protects). `computeImmediateWithdrawPortion()` itself is deliberately left byte-identical to the already-validated version — `WithdrawalPlanLib.executeWithdrawalPlan()` derives `fairFusd` from that function's existing `totalClaims`/`completeFundValue` outputs via the already-validated `applyClaimsHaircut()` wrapper (the same expression the function evaluates internally), so no shared, previously-audited signature was widened and no haircut logic is duplicated; it bounds both sides of the value-conservation check against it instead, and reverts `WithdrawAmountTooSmall` (matching the pro-rata path) when it is zero. This also corrected `completeFundValue` being computed after the allocations loop instead of before, which had been handing `computeAccountedAssetsReduction` an already-withdrawal-reduced figure instead of the pre-withdrawal one its own docs specify.

### Position-Level Selection: optional guard deployments

The plan schema carries a `guard` and optional `positionIds` per allocation (see the design doc's "Position-Level Selection"). This changes calldata decoding only — no storage. Whole-asset plans work with the existing validated guards; the guard binding requires the plan's `guard` to equal the pool's current guard for the asset.

Selecting individual positions inside a Morpho Blue, Aave V3, Aave V4 Spoke or Uniswap V3 guard needs NEW contracts, which inherit the validated guards without editing them:

- `AaveV4SpokeSelectiveAssetGuard` (constructor: spoke manager, taker, giver — same as the base).
- `MorphoBlueLendingPoolSelectiveAssetGuard` (constructor: morpho, morpho manager, swap router, settlement asset; links `MorphoCollectLib`; compiled with the same viaIR settings override as the base guard).
- `AaveV3LendingPoolSelectiveAssetGuard` (constructor: data provider, lending pool, settlement asset, swap router; compiled with the same viaIR settings override as the base; owner-set configuration is replayed and ownership handed over; only usable while the pool has no Aave V3 debt; deployed size is close to the EIP-170 limit, 50 bytes of headroom).
- `UniswapV3SelectiveAssetGuard` (no constructor arguments; admin-set configuration `withdrawalSlippageBps`, `withdrawalTwapWindow` and the per-pool `minimumPoolLiquidity` must be replayed, and the admin role handed to the old guard's admin; compiled with default settings like its base).

Rollout, only when position-level selection is wanted for that asset type:

1. Deploy the subclass guard.
2. Morpho, Aave V3 and Uniswap V3 only: re-seed the owner/admin-set configuration to match the guard being replaced (Morpho: `uniV3Fee` pairs, `defaultSlippageBps`, `flashAmountBufferBps`, `repayDebtBufferBps`, `requiresApproveReset`; Aave V3: `defaultSlippageBps`, `flashAmountBufferBps`, `uniV3Fee`, `uniV3PathExactIn`/`Out`, `requiresApproveReset` including the USDT default; Uniswap V3: `withdrawalSlippageBps`, `withdrawalTwapWindow`, `minimumPoolLiquidity` per pool) — the new instance starts with defaults and the whole-asset path depends on these.
3. Governance `setAssetGuard` for the asset type. This is global per asset type and affects every pool using it, and any plan signed against the previous guard address reverts `GuardMismatch` from that moment (intended).
4. Attester tooling must sign the new guard address.
5. Morpho and Aave V3 (owner) and Uniswap V3 (admin): the deployer holds the role at first; the script hands it to the holder on the guard being replaced after verifying the replayed configuration.
6. `scripts/deploy_selective_guards.ts` does steps 1, 2 and 5 and WRITES (never sends) the `Governance.setAssetGuard` transactions for step 3. Constructor arguments are read from the old guard's public immutables, and the Morpho and Uniswap configuration is discovered from the old guard's events and read back from live state; nothing is handed over unless every value matches. It needs `OLD_MORPHO_GUARD`, `MORPHO_COLLECT_LIB` (the existing, unchanged library), `MORPHO_ASSET_TYPE`, `GOVERNANCE`, and optionally `OLD_MORPHO_FROM_BLOCK` (the old guard's deployment block, so a public RPC's log-range limit is not hit); the Spoke equivalents are `OLD_SPOKE_GUARD` and `SPOKE_ASSET_TYPE`, the Aave V3 ones `OLD_AAVE_V3_GUARD`, `AAVE_V3_ASSET_TYPE` and optionally `OLD_AAVE_V3_FROM_BLOCK`, and the Uniswap V3 ones `OLD_UNISWAP_GUARD`, `UNISWAP_ASSET_TYPE` and optionally `OLD_UNISWAP_FROM_BLOCK`. Without `SEND=1` it is a dry run that only prints the configuration it would replay. The helpers are exercised against mock guards in `test/SelectiveGuardDeploy.test.ts`; the script itself has not been run against a live network.

Selection is refused while there is debt: an Aave V3 account with any debt, or a selected Morpho market with an open borrow, reverts `SubsetDebtUnsupported` (their unwinds are designed for leverage and stay on the whole-asset path). A guard without the capability (ERC20, the vault guards, where selection is at the asset level anyway) fails closed with `SubsetNotSupported`. A selected Morpho market with an open borrow reverts `SubsetDebtUnsupported` (v1).

### Post-upgrade step inherited from the validated baseline: WithdrawalEscrow (FNA-03)

Not part of this feature, but required by the same upgrade and previously undocumented in the scripts. `PoolLogic.withdrawalEscrow` (slot 20) is zero on the live proxy, and `finalizeCashWithdraw()` reverts `EscrowNotSet()` while it is zero. Effect if skipped: queued cash-withdraw requests cannot be finalized (fail-closed: nothing is lost, requests stay pending); instant withdrawals, staking and unstaking are unaffected. Fix: deploy `WithdrawalEscrow(<pool proxy>)` (it is immutable-bound to the proxy address, so it can be deployed before the upgrade) and have the owner call `initializeWithdrawalEscrow(escrow)` after the upgrade. `scripts/upgrade_core_contracts.ts` now deploys the escrow and includes that call in the DAO Safe batch after `initializeAutoCompounding()`; requests finalized before the escrow existed keep using the legacy `reservedAssetBalance` bookkeeping. The script has not been run against a live network.

### Runbook preconditions and completeness (upgrade-safety review)

These came out of an independent review of the upgrade path; each is enforced or reported by the scripts where it can be checked read-only.

- **No Pending queued withdrawals at upgrade time (High if violated).** `pendingCashWithdrawCount` (FNA-60, slot 22) is zero on the live proxy for requests that are already Pending, and `finalizeCashWithdraw()` decrements it with checked arithmetic, so finalizing such a request after the upgrade reverts (Panic 0x11) and, with no cancel path, locks the requester's fUSD. Finalized or Claimed requests are unaffected. Both upgrade scripts scan `lastRequestId` on the live proxy and abort if any request is Pending (`ALLOW_PENDING_WITHDRAWALS=1` overrides at the operator's own risk). Drain the queue on the current implementation first. Requests can only be created while `isImmediateWithdrawEnabled` is false, so the live check is a single read of that flag plus the scan.
- **Which script does what.** `scripts/upgrade_core_contracts.ts` is the full-stack upgrade (PoolLogic, TokenLogic, AssetHandler, PoolManagerLogic). Its Safe batch is: PoolLogic `upgradeAndCall` with empty data, `initializeAutoCompounding()`, `initializeWithdrawalEscrow(escrow)`, optionally `initializeAttestedWithdrawal(...)` when `ATTESTER_ADDRESS` is set, then TokenLogic `upgradeToAndCall` with its deposit cap; its EOA list is the AssetHandler upgrade, `clearEurUsdAggregator()`, the PoolManagerLogic upgrade and `setSequencerUptimeFeed`. `scripts/upgrade_attested_withdrawal.ts` upgrades PoolLogic only (and now deploys and wires the escrow when it is unset). Use ONE of them for a given upgrade: running the core script and then the attested script would upgrade PoolLogic twice, and if both batches are generated before either executes the second batch's `initializeAutoCompounding()` reverts `InvalidInitialization` and fails whole (recoverable by regenerating).
- **FNA-40 lock.** `AssetHandler.eurUsdModeLocked` is a new slot, false on the live proxy. Until `clearEurUsdAggregator()` runs once, the AssetHandler owner could still call `setEurUsdAggregator()` and re-base the whole pool's accounting to EUR. It is new in the upgraded implementation, so it is ordered after the AssetHandler upgrade in the core script's list.
- **Zero-on-live-but-required-nonzero inventory.** `compoundedRewardIndex` and `autoCompoundStartRewardPerShare` (auto-compounding initializer), `withdrawalEscrow` (escrow wiring), TokenLogic `maxDepositFusdSupply` and `protocolFusdOutstanding` (deposit-cap initializer), AssetHandler `sequencerUptimeFeed` (setter) and `eurUsdModeLocked` (clear call), `pendingCashWithdrawCount` for legacy Pending requests (precondition above), and the attested parameters (initializer; the feature starts disabled).
- **Initializer order is now enforced on-chain.** `initializeAttestedWithdrawal` reverts `AutoCompoundingNotInitialized` while `compoundedRewardIndex` is zero, so running it before `initializeAutoCompounding()` can no longer consume version 3 and permanently disable stake/unstake/harvest. The runbook order is still the order to use.
- **A guard swap installs every post-audit change, not just selection.** `Governance.setAssetGuard` replaces the guard of every asset of that type, and each subclass guard is the FULL validated guard plus one function. Against the live `audit`-era stack this can break NAV: the validated Morpho guard and its subclass call `morphoManager.getTrackedPoolMarkets` (absent from the `audit` manager) and use the changed `MorphoCollectLib`; the Uniswap guard has the FNA-16/58 fair-price valuation; the Aave V3 guard calls `getReserveAToken`. `scripts/deploy_selective_guards.ts` therefore verifies the asset type currently resolves to the guard being replaced, probes the Morpho manager, checks the library against this repo's build and requires explicit from-blocks; the swap must still be rehearsed on a Base fork, after the rest of the validated stack is upgraded.
- **The plugin's storage check is vacuous.** `upgrades.forceImport(proxy, NewFactory)` then `validateUpgrade(proxy, NewFactory)` (used in `upgrade_core_contracts.ts`) imports the proxy as the NEW layout and validates it against itself, so it passes whatever changed. The evidence for storage safety is the compiler-layout diff and `test/UpgradeFromAudit.test.ts`; to make the plugin check meaningful, import with a factory built from the `audit` branch.
- **Custody.** Older notes in `upgrade_core_contracts.ts` recorded the AssetHandler and PoolManagerLogic `ProxyAdmin`s and `factoryOwner` as the `GOVERNANCE_SAFE` single-key EOA; the team has since confirmed the deployed contracts are controlled by the multisig. Both upgrade scripts read every owner on-chain at run time and refuse to proceed if one is not a recorded address; the core script also reports whether each owner is a contract and, when the AssetHandler and PoolManagerLogic roles are held by the DAO Safe, puts their transactions (the AssetHandler upgrade, the FNA-40 lock, the PoolManagerLogic upgrade, the sequencer feed) into the SAME atomic Safe batch as the PoolLogic and TokenLogic steps (otherwise it writes them as a separate list for their holder). The independence of the `factoryOwner`'s latched stop, `setMaxSurchargeBps` and the rotation-delay floor rests on that multisig.
- **Fresh deployments.** `scripts/deploy_core_contracts.ts` now deploys the `WithdrawalEscrow` bound to the pool proxy and prints the required owner call `initializeWithdrawalEscrow(escrow)` (the pool's owner is `GOVERNANCE_SAFE`, not the deployer).
- **Default (non-`SEND`) mode still deploys.** Both upgrade scripts broadcast their Phase-1 deployments (libraries, implementations, escrow) from the local signer even without `SEND=1`; only the owner-gated calls are withheld.

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
npx hardhat test test/AttestedWithdrawal.test.ts test/SelectiveGuards.test.ts test/SelectiveGuardDeploy.test.ts: 157 passing
npm run test: 1293 passing (1 opt-in test pending)
npm run check:contract-size: PoolLogic at 150 bytes of EIP-170 headroom
```

Upgrade rehearsal from the real live implementation (`test/UpgradeFromAudit.test.ts`, opt-in via `AUDIT_ARTIFACTS`, instructions in the file): builds the `audit` branch, deploys ITS `PoolLogic` (with its own libraries) behind a transparent proxy, generates real staker state through it (stake, yield accrual, a pending reward), then upgrades to this branch's implementation with empty data and checks that (1) storage slots 0-22 are byte-identical, (2) every getter agrees with the pre-upgrade reading, (3) unstake is blocked until `initializeAutoCompounding()` (the documented hazard, reproduced), (4) after the owner-sent `initializeAutoCompounding()` then `initializeAttestedWithdrawal()` the staker's pending reward is preserved (the test scenario has 450 fUSD pending; the assertion allows 1e12 wei) and harvests in full, and the feature is left disabled. This covers layout and the reward migration for one staker; it does not replace a rehearsal against real mainnet state.

STRONGLY RECOMMENDED, not yet done: dry-run the upgrade + `initializeAttestedWithdrawal()` migration against a forked copy of the actual live mainnet state before executing for real, mirroring the same recommendation already made (and not yet completed, per its own notes) for the `initializeAutoCompounding()` migration in `scripts/upgrade_core_contracts.ts`.

### Audit Focus Points

Auditors should specifically review:

- Whether `attesterRotationDelay`/`isAttestedWithdrawEnabled`/`withdrawalAttester` can be manipulated into an unsafe state via any path other than `initializeAttestedWithdrawal()` or the dedicated, floor-enforced setters — see the `proposeWithdrawalAttester()` fix above.
- Whether the two-sided value-conservation bound in `WithdrawalPlanLib.executeWithdrawalPlan()` correctly rejects both over- and under-delivery for every allocation mode (portion and fixed-amount).
- Whether the decaying volume accumulator can be pushed above `type(uint128).max` via any combination of governance settings and withdrawal sizes (see the explicit overflow guard in `WithdrawalPlanLib._checkAndRecordVolume`).
- Whether `withdrawalAttester`'s address supplied at migration time is a real, currently-operational signer before the migration is executed — this codebase has no way to validate that on-chain.
