# Attested Selective Withdrawal — Change Summary for CertiK

**Baseline:** commit `4922f72` (tip of `feature/06-aave-v4`, the code CertiK validated).
**This change:** branch `feature/07-attested-selective-withdrawal`, cut from that commit.
**Full design and rationale:** [attested-selective-withdrawal-design.md](attested-selective-withdrawal-design.md) (its Reviewer Guide explains why each change was needed).

This page is the short list: what differs from the validated code, the evidence, where to look first, and what is not covered.

## 1. What changed, in one table

| Area                                                                                                                                             | Status against the baseline                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Every existing asset guard, contract guard and manager                                                                                           | **Unchanged** (source and runtime bytecode identical, or differing only in the metadata hash)                                             |
| `FundCalculationLibrary`, `MorphoCollectLib`, `MorphoMathLib`, `PoolTxExecutor`, `TokenLogic`, `PoolManagerLogic`, `AssetHandler`, `Governance`  | **Unchanged**                                                                                                                             |
| `PoolLogic.sol`                                                                                                                                  | **Modified**: the only validated contract whose code changed (+348 / −320 lines, mostly relocation)                                       |
| `interfaces/IPoolLogic.sol`, `interfaces/IPoolManagerLogic.sol`                                                                                  | Additions only (+129 / +6 lines, none removed)                                                                                            |
| `utils/WithdrawalPlanLib.sol`                                                                                                                    | **New**: the relocated withdrawal code plus the new plan logic                                                                            |
| `AaveV3LendingPool…`, `AaveV4Spoke…`, `MorphoBlueLendingPool…`, `UniswapV3SelectiveAssetGuard.sol` and `interfaces/guards/ISubPositionGuard.sol` | **New**: four small subclasses of validated guards that only add a capability marker and one function each                                |
| Mocks, tests, scripts, `hardhat.config.ts`                                                                                                       | Test and tooling only; the four existing test files gained library-linking lines and nothing else (7, 12, 7 and 7 lines added, 0 deleted) |

## 2. Evidence you can reproduce

Build both checkouts (`npx hardhat compile`), then run:

```bash
node scripts/compare-with-baseline.js <baseline-checkout> <branch-checkout>
git diff 4922f72 HEAD --name-status -- contracts/contracts ':!contracts/contracts/mocks'
git diff 4922f72 HEAD --numstat -- test/PoolLogic.test.ts test/PoolLogicAutoCompounding.test.ts test/TokenLogic.test.ts test/FrgmntUserActions.test.ts
npm run check:contract-size
npm run test
```

What these show on this branch:

- **Bytecode.** Of the 126 contracts present in both builds, 78 have identical runtime bytecode and 43 differ only in the trailing compiler metadata hash (they import the two interfaces that gained lines). Five differ in code: `PoolLogic` and four test mocks (`MockAaveV3Pool`, `MockERC20Custom`, `MockMorphoBlue`, `TestPoolManagerLogic`). Five non-mock contracts exist only on the branch: `WithdrawalPlanLib` and the four subclass guards.
- **Storage.** `PoolLogic` has 23 variables at the baseline; all 23 are unchanged in label, slot, offset and type. Eleven variables were appended in slots 23 to 33, none inserted. (Only the USD product is live, so this matters for the proxy upgrade.)
- **ABI.** `PoolLogic` goes from 129 to 187 ABI entries: none removed or changed, 58 added (27 errors, 8 events, 23 functions).
- **Size.** `PoolLogic` is 24,426 bytes against the 24,576 limit (150 bytes of headroom; 129 at the baseline). The baseline had no room for the feature, which is why code was moved out of it.
- **Tests.** 1,258 pass, 1 opt-in upgrade rehearsal is skipped unless its inputs are supplied. Instrumented coverage of the new library was 99.4% of statements and 92.1% of branches (measured on a scratch build); the uncovered code is defensive and listed in the design doc.

## 3. Where to look, in order

1. **`PoolLogic.sol` diff: is the relocation behaviour-preserving?** These moved into `WithdrawalPlanLib` with the same checks in the same order and the same error selectors: `_withdrawProcessing` (now `withdrawProcessing`), `_withdrawOne`, `_withdrawProRataInternal` and `_withdrawProRata` (now `executeProRataWithdrawal`), and `_checkCallResult`. The public entry points `withdrawCashImmediate`, `withdrawCashImmediateTo`, `withdrawCashImmediateSafe` and `withdrawCashImmediateToSafe` keep signatures, modifiers and access rules. The intentional differences: `reservedAssetBalance(asset)` is read through a self-call (a mapping cannot cross a library boundary), and the per-allocation work is split into small private functions.
2. **`WithdrawalPlanLib.executeWithdrawalPlan`.** The new value-conservation bounds (measured on the uncapped NAV before and after, plus a receipt-side check), the surcharge, the circuit breaker, guard binding, signature verification (hand-rolled ECDSA plus ERC-1271) and the fUSD-supply-unchanged check.
3. **The new `PoolLogic` functions.** `withdrawCashImmediateWithPlan`, attester rotation with a delay, the manager kill switch, the `factoryOwner`'s latched emergency stop and the `reinitializer(3)` migration initializer.
4. **The four subclass guards against the guards they inherit.** They override none of the validated guards' functions; the only `override`s implement `ISubPositionGuard`'s `isSubPositionGuard()` and `withdrawProcessingSubset()`.

## 4. Where new code depends on validated code

A regression in any of these would surface in the new path, so they are worth confirming against the validated behaviour:

- `FundCalculationLibrary.computeImmediateWithdrawPortion(pool, netFusd, 1)`: called with `1` as the capped-NAV argument only to avoid its zero early-return; only its `completeFundValue` and `totalClaims` outputs are used.
- `FundCalculationLibrary.applyClaimsHaircut(...)`: used to derive the fair entitlement, so the plan path is haircut in an underwater pool exactly like the pro-rata path.
- Guards' `getBalance`, `withdrawProcessing` and the optional `IWithdrawableBalanceGuard` and `IDeficitReportingGuard` markers, all unmodified.
- `TokenLogic.burnFrom`, called by the pool, and `getExitRemainingCooldown`.
- The Spoke and Morpho subclasses call the validated guards' internal helpers; the Uniswap V3 and Aave V3 subclasses filter the validated guards' output.

## 5. What is not covered

- **No external audit** of the new code has taken place; it has had internal review only.
- **No fork rehearsal.** Nothing has run against the live pool state or the real Aave, Morpho and Uniswap contracts; the mocks model interfaces, not behaviour. The upgrade and deployment scripts have never been run against a live network.
- **Residual risks the design accepts and documents:** queued withdrawals that are pending at upgrade time are guarded only by a script preflight (the failure is inside validated code); the circuit breaker does not bound a compromised manager; a plan is only as safe as the guards' own valuation; the surcharge prices usage, not composition. See the design doc's Security Considerations and Open Questions.
- **The feature ships disabled.** The initializer leaves `isAttestedWithdrawEnabled` false; the manager enables it deliberately, and `maxSurchargeBps` defaults to 0.
