# Attested Selective Withdrawal — Design Doc

## Status

Implemented, on `feature/07-attested-selective-withdrawal`. `PoolLogic.withdrawCashImmediateWithPlan()` and its supporting governance functions are live in the contracts; `WithdrawalPlanLib.sol` holds the extracted orchestration logic (see [Bytecode Size Budget](#implementation-note-bytecode-size-budget)). Not yet upgraded onto the live mainnet pool — see `scripts/upgrade_attested_withdrawal.ts` and `docs/upgradeable-contracts-notes.md`'s "Attested Selective Withdrawal Upgrade" checklist for that remaining step.

This document was iterated on twice: once before implementation (see [Design Refinements](#design-refinements)) and again afterward, across several rounds of review against the actual code (see [Post-Implementation Findings](#post-implementation-findings)). A handful of mechanisms below — signature verification, the EIP-712 domain, the value-conservation bound's parameterization, exact check ordering — ended up implemented differently than this document originally specified; every such case is called out explicitly in place, not silently reconciled, so the history of _why_ stays visible.

**How this document is organized:**

- **[Part 1 — Overview](#part-1--overview)**: what this feature is, the gap it closes, and its scope.
- **[Part 2 — Design](#part-2--design)**: the trust model, the end-to-end flow, the on-chain data structures, the function itself, and the invariants that keep it safe.
- **[Part 3 — Implementation](#part-3--implementation)**: how the design maps onto the actual contracts — the bytecode constraint that shaped the architecture, the upgrade path, and test coverage.
- **[Part 4 — Review History](#part-4--review-history)**: every finding raised against this feature, before and after it was coded, and how each was resolved.
- **[Open Questions](#open-questions)**: what's deliberately deferred past this version.

## Part 1 — Overview

### Summary

A new `PoolLogic` entry point, `withdrawCashImmediateWithPlan()`, lets a user redeem fUSD for a **specific, non-uniform mix of vault assets** instead of the strict pro-rata slice across _every_ supported asset that `withdrawCashImmediate()` enforces today. The asset/amount composition is not chosen by the withdrawing user — it is computed off-chain and signed by a new protocol role, the **withdrawal attester**, based on real-time knowledge of which guards can currently service a withdrawal safely. The user submits the attester's signed plan together with their own transaction; the contract verifies the signature, executes the plan through the _existing_ per-asset guard interface unchanged, and — critically — independently re-verifies that the total USD value released matches the user's redemption entitlement, regardless of which assets it came from.

This directly addresses a gap in the current design: today, if any single guard cannot service its pro-rata slice right now (an Aave V4 Spoke reserve without enough external liquidity to safely unwind, a Morpho Vault V2 position mid `forceDeallocate` cooldown, a Uniswap V3 position whose TWAP/spot deviation currently exceeds the withdrawal slippage bound), `withdrawCashImmediate()` either reverts outright for _every_ user, or the manager must flip `isImmediateWithdrawEnabled = false` for the _entire pool_, forcing everyone onto the three-step queued-withdrawal flow until the one problem asset recovers. This feature gives a per-request escape valve: route around the specific asset that's currently constrained, without touching global withdrawal availability.

### Problem Statement

`PoolLogic._withdrawCashImmediateToSafe()` computes a single `portion = netFusd * 1e18 / totalFundValue()` and applies that _same_ portion to every asset in `getSupportedAssets()` via `_withdrawProcessing(asset, to, portion, complexData)`. This is correct and fair when every asset is equally liquid, but it has one structural weakness: **it is all-or-nothing across the whole asset list.** If withdrawing a `portion` of any one asset would currently fail — most realistically a complex/flashloan-unwound position (Aave V3/V4, Morpho Blue, Morpho Vault V2) where the unwind can't clear its own slippage tolerance because on-chain liquidity for the settlement swap is temporarily thin — the _entire_ `withdrawCashImmediate()` call reverts, even though the other N-1 assets are perfectly capable of paying the user out.

The only existing mitigation is `PoolLogic.setImmediateWithdrawEnabled(false)` (manager-only), which is a blunt, pool-wide switch: it blocks _every_ user's immediate withdrawal, not just the ones that would touch the impaired asset, and routes everyone through `requestCashWithdraw → finalizeCashWithdraw → claimCashWithdraw`, which requires manual manager action per request. `docs/security.md`'s known-risk table already flags the underlying tension ("a single illiquid asset can still block fund-wide immediate withdrawals, mitigated by the queued withdrawal mode") — this design is the more surgical alternative to that mitigation.

### Goals

- Let a user redeem fUSD immediately, sourcing value from a _subset_ of supported assets, when one or more guards are temporarily unable to service a uniform pro-rata slice.
- Preserve the existing value-conservation guarantee: a withdrawal can never release more USD value than the fUSD burned entitles the user to, **regardless of which off-chain party composed the asset mix**.
- Reuse the existing `IAssetGuard`/`IComplexAssetGuard`/`ISlippageCheckingGuard` interfaces as-is — no guard contract should need to change to support this feature. (The internal orchestration around them, `_withdrawProcessing()`, is relocated rather than left untouched — see [Bytecode Size Budget](#implementation-note-bytecode-size-budget) — but its behavior toward guards is unchanged.)
- Keep the blast radius of a compromised attester key bounded to "temporarily unfair asset selection," never to fund loss.

### Non-Goals

- This is **not** a general user-chosen-allocation withdrawal. The user does not pick which assets they receive; an accountable off-chain role does. See [Trust Model](#trust-model--why-the-attester-not-the-user-signs) for why.
- Not a replacement for `withdrawCashImmediate()` or the queued withdrawal flow — a third, complementary path.
- Not intended to support partial-fill / plan-splitting across multiple transactions in v1 (see [Open Questions](#open-questions)).

## Part 2 — Design

### Trust Model — why the attester, not the user, signs

The obvious naive design — let the withdrawing user pick their own asset/amount mix and self-sign it (mirroring `TokenLogic.depositWithAuthorization`'s EIP-712 pattern) — reintroduces a well-known DeFi vault failure mode: **adverse selection / cherry-picking**. If users freely choose their own redemption composition, every rational user withdraws the healthiest, most liquid, most likely-to-appreciate assets first and leaves the impaired or illiquid ones behind. In a shared pool, this transfers loss from whoever exits first onto whoever is left holding shares — the same dynamic behind real-world stablecoin/vault de-pegging incidents where "first out" strictly dominates "last out."

This design instead has a dedicated **withdrawal attester** role sign the plan. The attester is the party with visibility into which guards are _actually_ constrained right now (Aave V4 Spoke reserve utilization, Morpho Vault V2 `forceDeallocate` penalty state, Uniswap V3 spot/TWAP deviation) — confirmed as **an automated backend service operated by the protocol**, not the manager's own key or a human-in-the-loop signer. Because the attester (not the user) decides the mix, a user cannot unilaterally dump the "bad" asset onto remaining stakers; the same operational surface that already computes off-chain risk data is the one deciding fair allocation here too.

**This changes the key-management threat model relative to every other signer/role in this codebase.** `manager`, `factoryOwner`, and the Timelock proposers are all expected to be cold, rarely-used, likely-multisig keys. The withdrawal attester, by contrast, is a **hot key held by an automated backend process**, signing continuously in response to user requests — a materially larger attack surface (server compromise, leaked key material, supply-chain compromise of the signing service) than any existing role in the protocol. The rest of this document treats that as the primary threat to design against, not an afterthought: see [Bounding a Compromised Attester Key](#bounding-a-compromised-attester-key) below.

**Critically, the attester's power is bounded on-chain.** The signature only determines _which_ assets a withdrawal draws from and in what proportion — the contract independently measures total USD value released before vs. after execution (reusing the exact invariant already in `_withdrawCashImmediateToSafe()`) and reverts if it doesn't match the user's fUSD entitlement within a small tolerance, in **either** direction (see [Value Conservation](#value-conservation-the-core-safety-invariant)). A fully compromised attester key can misallocate _which_ assets a user gets — reintroducing the cherry-picking problem for the duration of the compromise — but cannot cause the fund to pay out more value than any single withdrawal legitimately burns. Key compromise degrades this feature to "as unsafe as the naive user-signed design," not to "fund drain."

### High-Level Flow

```
Off-chain (attester service)                  On-chain
──────────────────────────────                ────────────────────────────────
1. User requests a quote for
   redeeming `fusdAmount`.
2. Attester inspects current guard
   state (Aave V4 Spoke utilization,
   Morpho Vault forceDeallocate caps,
   UniV3 TWAP deviation, etc.) and
   picks a subset of supported assets
   + amounts/portions that sum to
   ~fusdAmount of value, favoring
   currently-liquid guards. Chooses
   minValueOutBps for this plan based
   on current volatility.
3. Attester signs a WithdrawalPlan
   (EIP-712) and returns it to the
   user, with a short deadline.
                                        4. User calls
                                           withdrawCashImmediateWithPlan(plan, sig)
                                                │
                                                ▼
                                        5. msg.sender == plan.user;
                                           isAttestedWithdrawEnabled;
                                           checkpoint fees/rewards for
                                           plan.user (same as every other
                                           entry point that mutates a
                                           user's position). Everything
                                           past this point runs inside
                                           WithdrawalPlanLib — see
                                           Implementation Note below on
                                           why so much logic, not just
                                           the per-asset loop, lives there.
                                                │
                                                ▼
                                        6. Verify signature against
                                           withdrawalAttester (EOA-or-
                                           ERC-1271, hand-rolled — see
                                           EIP-712 Typed Data); deadline
                                           not expired; nonce not already
                                           consumed; minValueOutBps <=
                                           MAX_MIN_VALUE_OUT_BPS;
                                           fusdAmount != 0.
                                                │
                                                ▼
                                        7. Compute netFusd (cooldown +
                                           exit fee, same as
                                           withdrawCashImmediate) and
                                           check the decaying circuit-
                                           breaker cap against it — fail
                                           fast here before burning
                                           anything.
                                                │
                                                ▼
                                        8. Burn netFusd fUSD; measure
                                           fund value before; compute
                                           fairFusd (solvency-haircut-
                                           adjusted entitlement — see
                                           Value Conservation); revert if
                                           fairFusd is 0 or exceeds the
                                           pre-withdrawal fund value.
                                                │
                                                ▼
                                        9. For each entry in allocations
                                           (validated for support/
                                           duplicates/portion-bound as
                                           each one is processed, not in
                                           a separate upfront pass),
                                           resolve guard + portion (fixed-
                                           amount or direct) and execute
                                           the withdrawal via the shared
                                           library-based per-asset
                                           processor (same guard dispatch,
                                           slippage checks, and
                                           reservedAssetBalance handling
                                           as today's pro-rata path).
                                                │
                                                ▼
                                        10. Measure total fund value
                                            delta; revert unless it's
                                            within [fairFusd * (1 -
                                            minValueOutBps), fairFusd +
                                            DUST_TOLERANCE].
                                                │
                                                ▼
                                        11. Back in PoolLogic: mark the
                                            nonce consumed, write the new
                                            circuit-breaker accumulator,
                                            update accountedAssets, emit
                                            events, done.
```

Note on step 11: the nonce is written back to storage only after `WithdrawalPlanLib.executeWithdrawalPlan()` returns successfully — not immediately upon verification, as an earlier draft of this document specified. `WithdrawalPlanLib` cannot perform this write itself (it is storage-free by design, see [Bytecode Size Budget](#implementation-note-bytecode-size-budget)), and moving the write earlier would mean `PoolLogic` writing it before knowing whether the plan will actually execute. In practice this loses no safety: `nonReentrant` already fully guards the outer function for the duration of one plan's execution, and the whole transaction — including every state change — unwinds atomically on any revert. The earlier draft's framing ("two independent reasons the same plan can never execute twice") is no longer accurate as implemented; there is one enforcement mechanism (`nonReentrant`), not two, and it is sufficient.

### Data Structures

```solidity
/// @notice One asset's contribution to a selective withdrawal.
struct AssetAllocation {
    address asset;          // must currently be in PoolManagerLogic.getSupportedAssets()
    bool useFixedAmount;     // false = `portion` is a fraction of this asset's own guard-reported
                             //         balance (1e18 = 100%, same convention as IAssetGuard.withdrawProcessing)
                             // true  = `portion` is ignored; withdraw exactly `fixedAmount` raw units
                             //         of this asset (converted internally to an equivalent portion,
                             //         clamped to 1e18 — see below). Only meaningful for divisible,
                             //         balance-reporting assets; an indivisible or NFT-backed position
                             //         (e.g. a Uniswap V3 LP position, whose guard.getBalance()
                             //         typically reports a USD value, not a raw redeemable unit count)
                             //         should use direct `portion` instead.
    uint256 portion;         // 1e18-scale, meaningful iff !useFixedAmount. Enforced on-chain to be
                             // <= 1e18 — a direct portion above 100% is rejected outright
                             // (InvalidPortion) rather than left to guard-specific behavior to fail
                             // safely (an implementation-round finding: nothing guaranteed every
                             // guard would revert cleanly on an over-100% portion).
    uint256 fixedAmount;      // raw asset units, meaningful iff useFixedAmount
}

/// @notice Attester-signed withdrawal composition for one specific redemption.
struct WithdrawalPlan {
    address user;                       // withdrawing user this plan is valid for
    uint256 fusdAmount;                  // gross fUSD being redeemed (pre-exit-fee), must match caller's burn
    uint256 minValueOutBps;              // attester-chosen ACCEPTABLE under-delivery tolerance, in bps of
                                          // netFusd — e.g. 20 = attester will accept realized value as low as
                                          // 99.80% of netFusd for this specific plan. This is an ENFORCED
                                          // on-chain bound (the lower half of the two-sided value-conservation
                                          // check below), not merely advisory — see Value Conservation.
                                          // Hard-capped on-chain by MAX_MIN_VALUE_OUT_BPS regardless of what
                                          // the attester signs, so a compromised attester cannot widen it
                                          // enough to let meaningful value leak through.
    AssetAllocation[] allocations;        // sparse — omit any asset the attester wants excluded entirely
    uint256 nonce;                        // per-user monotonically-unique, single-use
    uint256 deadline;                     // signature expiry, unix seconds
}

/// @dev Protocol-level ceiling on how loose `minValueOutBps` may be, independent of attester input.
uint256 public constant MAX_MIN_VALUE_OUT_BPS = 100; // 1% — proposed default, tune with the team
```

`allocations` is **sparse**: assets the attester wants to exclude (the currently-impaired ones) simply do not appear, rather than appearing with `portion = 0`. This keeps the signed payload small, keeps gas cost proportional to the number of assets actually touched (unlike today's pro-rata loop, which calls every supported asset's guard even when its resulting withdrawal amount is negligible), and means excluded assets never incur a guard call at all.

`ComplexAsset[] complexAssetsData` (the existing struct from `IPoolLogic`, used today by `withdrawCashImmediateSafe`) remains a plain, **unsigned** call-time parameter, matched to `allocations` entries by asset address rather than by array index. The attester's signature commits to _which assets and how much_; the user retains today's existing control over their own swap-slippage tolerance for any complex/flashloan-unwound asset in the plan, exactly as they do today via `withdrawCashImmediateSafe`.

#### EIP-712 Typed Data

```solidity
bytes32 private constant ASSET_ALLOCATION_TYPEHASH = keccak256(
    "AssetAllocation(address asset,bool useFixedAmount,uint256 portion,uint256 fixedAmount)"
);

bytes32 private constant WITHDRAWAL_PLAN_TYPEHASH = keccak256(
    "WithdrawalPlan(address user,uint256 fusdAmount,uint256 minValueOutBps,AssetAllocation[] allocations,uint256 nonce,uint256 deadline)AssetAllocation(address asset,bool useFixedAmount,uint256 portion,uint256 fixedAmount)"
);
```

Array-of-structs hashing follows the standard EIP-712 rule: hash each `AssetAllocation` individually against `ASSET_ALLOCATION_TYPEHASH`, then hash the concatenation of those hashes to produce the `allocations` field's contribution to the outer struct hash.

**As implemented, `PoolLogic` does not inherit `EIP712Upgradeable`, and does not call `__EIP712_init` anywhere — this is a deliberate deviation from this document's original plan, made for bytecode reasons.** The domain separator (`EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)`, with `name = "Frgmnt PoolLogic"` and `version = "1"`, matching what `__EIP712_init` would have produced) is instead computed inline inside `WithdrawalPlanLib._hashPlan()`, on every call, from hardcoded name/version hashes plus `block.chainid` and `address(this)`. Because the hashing function runs via `delegatecall`, `address(this)` inside the library still correctly resolves to the calling `PoolLogic` proxy's own address — the resulting digest is identical to what `EIP712Upgradeable._domainSeparatorV4()` would have produced had `PoolLogic` inherited it directly, but with zero bytecode landing in `PoolLogic` itself (no inherited init code, no cached domain separator storage, no dispatch logic) — see [Bytecode Size Budget](#implementation-note-bytecode-size-budget) for why every byte mattered here. Because the domain separator still binds `chainId` and `verifyingContract` this way, no additional pool-identifying field is needed inside `WithdrawalPlan` itself to prevent cross-contract or cross-chain replay — that property is preserved even without inheriting the OpenZeppelin base contract.

**Signature verification should not assume a raw EOA key.** The initial draft of this design called `ECDSA.recover(digest, attesterSignature) == withdrawalAttester` directly, implicitly requiring `withdrawalAttester` to be a single private key. Given the attester is a hot, automated backend signer (the highest-risk key in this whole feature — see [Trust Model](#trust-model--why-the-attester-not-the-user-signs)), this is worth not locking in prematurely, so both EOA and ERC-1271 (contract) signers must be supported.

**As implemented, this is not OpenZeppelin's `SignatureChecker.isValidSignatureNow` — it is a hand-rolled equivalent, `WithdrawalPlanLib._isValidSignatureNow()`.** `SignatureChecker` (as of the OpenZeppelin Contracts version pinned in this repo, 5.4.0) transitively imports `Bytes.sol`, which uses the `mcopy` opcode (EIP-5656). This repo's `solc` target defaults to the Paris EVM version (`hardhat.config.ts` has no `evmVersion` override), which predates Cancun and does not support `mcopy` — linking `SignatureChecker` as originally specified fails to compile. The hand-rolled replacement reproduces the identical acceptance behavior using only `ECDSA.tryRecover` (already used elsewhere in this codebase, by `TokenLogic.depositWithAuthorization`, and confirmed Cancun-independent) plus a manual ERC-1271 `staticcall`: try ECDSA recovery first, and if that doesn't match `withdrawalAttester`, fall back to `isValidSignature` only if `withdrawalAttester` has code. This preserves the exact design intent — transparent EOA-or-contract support, with the door left open to later point `withdrawalAttester` at a co-signing contract without further `PoolLogic` changes — just without the specific OpenZeppelin entry point originally named.

### Function Signature

```solidity
function withdrawCashImmediateWithPlan(
    WithdrawalPlan calldata plan,
    bytes calldata attesterSignature,
    ComplexAsset[] calldata complexAssetsData
) external nonReentrant returns (address[] memory outAssets, uint256[] memory outAmounts);
```

#### Step-by-step behavior

As implemented, the bulk of this logic (everything from signature verification through the value-conservation check) lives in `WithdrawalPlanLib.executeWithdrawalPlan()`, not in `PoolLogic` itself — see [Bytecode Size Budget](#implementation-note-bytecode-size-budget) for why. `PoolLogic`'s own function body is now short: identity/enabled checks, a fee/reward checkpoint, one call into the library, then the three storage writes the library's result feeds.

1. **Identity binding & entry checks, in `PoolLogic`.** `require(msg.sender == plan.user)` (`NotPlanUser` otherwise) — deliberately **plain `msg.sender`, not `_actionSender()`**, see [Security Considerations](#security-considerations). Then `require(isAttestedWithdrawEnabled)` (`ImmediateWithdrawalDisabled` otherwise), and `_updateFeesAndRewardsFor(plan.user)` — the same fee/reward checkpoint every other position-mutating entry point performs, not called out in the original draft of this document.
2. **Signature verification, in the library.** Recompute the EIP-712 digest from `plan`; verify via the hand-rolled EOA-or-ERC-1271 check (see [above](#eip-712-typed-data) on why this is not `SignatureChecker`).
3. **Freshness & replay checks.** `require(block.timestamp <= plan.deadline)` (`PlanDeadlineExpired`); `require(!consumedPlanNonce[plan.user][plan.nonce])` (`PlanNonceAlreadyUsed`) — the nonce's current value is read by `PoolLogic` and passed into the library as a bool; the actual `consumedPlanNonce[...] = true` write happens back in `PoolLogic`, **after** the library call returns successfully, not immediately on this check — see the note under [High-Level Flow](#high-level-flow) on why that's safe despite differing from this document's original intent.
4. **Plan-level bound checks.** `require(plan.minValueOutBps <= MAX_MIN_VALUE_OUT_BPS)` (`MinValueOutBpsTooHigh`); `require(plan.fusdAmount != 0)` (`ZeroAmount`) — this second check was added during a later review pass specifically to close a gap in the manager fee-bypass branch below, where a zero `fusdAmount` could otherwise skip the burn entirely while the allocations loop still released real value within `DUST_TOLERANCE`.
5. **Fee & cooldown.** Identical to `withdrawCashImmediate()` today: cooldown check via `getExitRemainingCooldown`, exit fee applied, fee transferred to the manager, `netFusd` computed. (The manager themself is exempt from both cooldown and fee, mirroring the existing pro-rata path.)
6. **Circuit-breaker check, recorded against `netFusd`.** Check-and-record against the rolling decayed attested-withdraw volume cap (see [Bounding a Compromised Attester Key](#bounding-a-compromised-attester-key)) **before** burning or touching any guard — same fail-fast reasoning as originally specified.
7. **Burn.** `burnFrom(plan.user, netFusd)`.
8. **Measure fund value before, compute `fairFusd`.** `valueBefore = computeWithdrawableFundValue(...)`, then `(, totalClaims, completeFundValue, fairFusd) = computeImmediateWithdrawPortion(pool, netFusd, valueBefore)` — computed here, before the allocations loop, so `completeFundValue` reflects pre-withdrawal state for the accounting step later (an ordering bug in an earlier implementation pass computed this after the loop instead; fixed in a later review pass). Two checks follow, both reverting `WithdrawAmountTooSmall`: `fairFusd == 0` (extreme insolvency or an empty pool, mirroring the pro-rata path's own zero-portion check) and — added in a subsequent, stricter review pass — `fairFusd > valueBefore` (the "temporary liquidity gap" case: the pool is solvent overall but not everything is liquid right now; without this check the function would still almost certainly revert later via the value-conservation check below, just less specifically and after wasting the gas of a doomed loop).
9. **Per-asset withdrawal.** For each entry in `allocations`, validated as it's processed rather than in a separate upfront pass: asset-membership (`isSupportedAsset`) and duplicate checks, then if `useFixedAmount`, first `require(guard.getBalance(pool, asset) > 0)` (`ZeroAssetBalance`) then compute `portion = min(fixedAmount * 1e18 / balance, 1e18)`; otherwise use `allocations[i].portion` directly, rejecting outright (`InvalidPortion`) if it exceeds `1e18` (a bound added during review — see the [Data Structures](#data-structures) section). Look up the matching `ComplexAsset` from `complexAssetsData` by address, and process the withdrawal for that asset via the same per-asset guard-dispatch logic the pro-rata path now also calls (`WithdrawalPlanLib.withdrawProcessing`).
10. **Value-conservation check.** Compare fund value before step 7 and after step 9 completes, against `fairFusd` — **not** the raw `netFusd`; see the correction below:
    - `valueBefore - valueAfter <= fairFusd + DUST_TOLERANCE` (fixed, protocol-level upper bound; **not** attester-adjustable)
    - `valueBefore - valueAfter >= fairFusd - (fairFusd * plan.minValueOutBps / 10_000)` (attester-adjustable lower bound, capped by `MAX_MIN_VALUE_OUT_BPS` — see [Value Conservation](#value-conservation-the-core-safety-invariant))
11. **Accounting & events, back in `PoolLogic`.** Mark the nonce consumed; write the new circuit-breaker accumulator; decrement `accountedAssets` by the realized value delta (via the same `computeAccountedAssetsReduction` the pro-rata path uses); emit `AttestedWithdrawPlanExecuted(user, nonce)` alongside the existing `CashWithdrawImmediateProRata` event. `CashWithdrawImmediateProRata` is deliberately reused rather than defining a second, near-identical dynamic-array-encoding event purely to save bytecode — an attested selective withdrawal is **not** a genuine uniform pro-rata one, so off-chain consumers must treat any `CashWithdrawImmediateProRata` emitted alongside `AttestedWithdrawPlanExecuted` in the same transaction as attester-composed, and key off the paired event (present only on this path) to tell the two apart.

### Value Conservation: the core safety invariant

`_withdrawCashImmediateToSafe()` today only bounds withdrawal value from _above_ (`valueBefore - valueAfter > netFusd + 1e15` reverts), because in the uniform pro-rata path under-delivery isn't a realistic failure mode — every asset is always included at the same portion, so the sum reliably tracks `netFusd` up to rounding. That assumption **does not hold** for an attester-composed selective plan: it is entirely possible for a plan to under-deliver (e.g., the attester's picked assets don't actually have enough available balance at execution time, due to price drift or a race with another withdrawal). Silently allowing under-delivery would mean a user burns `netFusd` worth of fUSD but receives less USD value than that — a direct, silent loss to the user that the existing check would not catch.

This design therefore **tightens** the check to a two-sided bound for this function specifically: both an upper bound (no fund drain beyond entitlement, protects the fund) and a lower bound (no under-payment, protects the user). If either bound is violated, the whole transaction reverts — the user's fUSD is not burned, and they can retry with a corrected plan from the attester. This is the one place this design deliberately departs from reusing the existing invariant verbatim, and it should be called out explicitly during implementation: **the upper bound is inherited from existing, tested code; the lower bound is new and is the primary thing to scrutinize for off-by-one/rounding errors.**

**Correction (post-implementation review, round four): the bound must be parameterized by `fairFusd`, not the raw `netFusd`.** `_withdrawCashImmediateToSafe`'s own pro-rata path already sizes its per-asset `portion` against a solvency-haircut-adjusted fair share (`FundCalculationLibrary._applyClaimsHaircut`) whenever the pool is underwater (outstanding claims exceed fund value) — a deliberate, load-bearing loss-socialization mechanism (see `docs/upgradeable-contracts-notes.md`'s FNA-05 notes). The first implementation of this function bounded the two-sided check against the raw `netFusd` instead, because this section's original text did too. In a solvent pool this is a no-op (the haircut-adjusted `fairFusd` equals `netFusd` exactly whenever fund value covers outstanding claims), but in an underwater pool it would have let an attested withdrawal pay out at par while every other withdrawal was haircut proportionally — extracting more than a fair share from remaining stakers, silently reopening exactly the fund-drain-by-early-exit problem FNA-05 closed for the pro-rata path. Fixed by deriving `fairFusd` in `WithdrawalPlanLib` from `computeImmediateWithdrawPortion`'s existing `totalClaims` and `completeFundValue` outputs through the already-validated `FundCalculationLibrary.applyClaimsHaircut()` wrapper — exactly the expression that function evaluates internally — and binding both sides of this check, and the zero-entitlement revert, to it instead of `netFusd`. `computeImmediateWithdrawPortion` itself is left untouched: an earlier draft widened its return signature to expose `fairFusd`, but that changed a shared function the pro-rata path (and its validated review) depends on for no benefit, since the value is derivable from what it already returns.

The two sides of the bound are deliberately asymmetric in how they're parameterized:

- **Upper bound** (`fairFusd + DUST_TOLERANCE`): fixed, protocol-level, not attester-adjustable. Allowing the attester any influence over how much the fund can _overpay_ would reopen the fund-drain question this whole invariant exists to close — so this stays a hardcoded constant exactly like today's `1e15` in `_withdrawCashImmediateToSafe`.
- **Lower bound** (`fairFusd - (fairFusd * minValueOutBps / 10_000)`): attester-adjustable **within a hardcoded ceiling** (`MAX_MIN_VALUE_OUT_BPS`). The attester is the party who knows current market conditions when composing a plan — during calm conditions they can sign a tight `minValueOutBps` (close to 0, meaning "this must deliver almost exactly `fairFusd` or revert"); during fast-moving conditions where balances/prices may drift meaningfully between signing and execution, they can widen it slightly to reduce spurious reverts. `MAX_MIN_VALUE_OUT_BPS` bounds how far that can go regardless of what any (possibly compromised) attester signs, so this flexibility can never be abused to let more than a small, protocol-chosen fraction of value leak away from a user.

Note that an **empty `allocations` array is automatically rejected** by this same lower bound with no special-case code: zero assets withdrawn means a realized value delta of `0`, which fails `0 >= fairFusd - tolerance` for any `fairFusd > 0`.

**Correction (post-implementation review, round five): a stricter fail-fast check for the "temporary liquidity gap" case.** `computeImmediateWithdrawPortion` has a branch where the pool is solvent overall but not everything is liquid right now; in that branch it returns a real `completeFundValue` and `totalClaims` — so the derived `fairFusd` is **uncapped** by the currently-withdrawable fund value — alongside `portion == 0` (the same branch where the pro-rata path causing that path to revert `WithdrawAmountTooSmall` via its own zero-portion check rather than attempt a doomed partial payout). The fourth-round fix above added the `fairFusd == 0` check but not an equivalent for this case — without it, the attested path would proceed into the full allocations loop and almost certainly still revert (`ValueConservationViolated`, since real deliverable value is capped below the inflated `fairFusd`), just less specifically and after spending the gas of a doomed loop. `require(fairFusd <= valueBefore)` (reverting `WithdrawAmountTooSmall`, checked right after `fairFusd` is computed, before the allocations loop runs) closes this — not a fund-safety gap either way, but it matches the pro-rata path's exact short-circuit and fails with the correct error.

### Bounding a Compromised Attester Key

The value-conservation invariant above bounds what a _single_ attested withdrawal can do: no plan, however maliciously composed, can release more USD value than that one withdrawal's own `netFusd` entitles. It does **not** bound how many times a compromised key can be used before someone notices. Because the attester is an always-on backend service rather than a rarely-touched multisig, the realistic worst case is not "one bad plan" but "many small, individually-legitimate-looking plans, signed continuously over hours or days, that collectively route a disproportionate share of the pool's healthy assets to whoever the attacker controls, systematically leaving the impaired/illiquid assets concentrated for remaining stakers." Two additional, independent controls target that scenario specifically:

**1. Rotation asymmetry (above):** instant revoke, delayed appoint. This shrinks the window between "key compromise begins" and "key compromise stops mattering" down to however fast the team can call `setAttestedWithdrawEnabled(false)` once alerted — no coordination or multisig round needed for the emergency stop itself.

**2. On-chain decaying volume cap (circuit breaker):** track cumulative USD value released via `withdrawCashImmediateWithPlan()`, independent of `withdrawCashImmediate()`'s ordinary volume. If a plan's execution would push the tracked total above `maxAttestedWithdrawVolumePerWindow`, the transaction reverts — the user falls back to ordinary `withdrawCashImmediate()` or the queued flow for that redemption instead. This does not require detecting the compromise at all; it simply caps the blood loss from an _undetected_ one, the same way an exchange's per-address or per-day withdrawal limit does.

**A naive fixed-window implementation (reset the counter to zero every N hours) has a known flaw:** an attester can release up to the full cap just _before_ a window boundary, then release another full cap's worth just _after_ it — up to ~2× the intended cap in a short span straddling the reset, with no code-level malfunction, just a property of hard periodic resets. Rather than accept that gap, this design reuses the **exact decay-based accumulator already implemented and reasoned about in `SlippageAccumulator.sol`** (`accumulatedSlippage` linearly decaying to zero over `decayTime`, `lastTradeTimestamp` tracking the last update) — the same mathematical shape, applied to withdrawal volume instead of slippage impact:

```solidity
// PoolLogic.sol storage:
struct AttestedWithdrawVolume {
    uint64 lastWithdrawTimestamp;
    uint128 accumulatedValueUsd;
}
AttestedWithdrawVolume public attestedWithdrawVolume;
uint256 public attestedWithdrawDecayWindow; // floor: MIN_ATTESTED_WITHDRAW_DECAY_WINDOW = 1 hours
uint256 public maxAttestedWithdrawVolumePerWindow; // 0 fails closed; no floor needed

// WithdrawalPlanLib.sol (pure — PoolLogic performs the actual SSTORE with the returned struct):
function _checkAndRecordVolume(
    VolumeState memory current,
    uint256 decayWindow,
    uint256 maxVolumePerWindow,
    uint256 valueUsd
) private view returns (VolumeState memory) {
    // Second-round finding: setAttestedWithdrawDecayWindow() enforces the floor, but nothing
    // stopped a manager from enabling the feature and setting a real volume cap while simply
    // never calling that setter, leaving the window at its unsafe storage-default of 0 — with
    // decayWindow == 0, `elapsed < decayWindow` is never true, so the accumulator silently never
    // retains cross-transaction memory. Defended here, at the actual point of use.
    if (decayWindow == 0) revert AttestedWithdrawVolumeCapExceeded();

    uint256 decayed;
    if (current.accumulatedValueUsd != 0) {
        uint256 elapsed = block.timestamp - current.lastWithdrawTimestamp;
        if (elapsed < decayWindow) {
            decayed = (uint256(current.accumulatedValueUsd) * (decayWindow - elapsed)) / decayWindow;
        }
    }

    uint256 newTotal = decayed + valueUsd;
    // Second-round finding: accumulatedValueUsd is a storage uint128, but
    // maxAttestedWithdrawVolumePerWindow has no enforced ceiling and could be set above
    // type(uint128).max — newTotal passing the cap check would then silently truncate on the
    // uint128() cast below instead of failing safely. Bounded explicitly, regardless of how the
    // cap is configured.
    if (newTotal > maxVolumePerWindow || newTotal > type(uint128).max) {
        revert AttestedWithdrawVolumeCapExceeded();
    }

    return VolumeState({ lastWithdrawTimestamp: uint64(block.timestamp), accumulatedValueUsd: uint128(newTotal) });
}
```

There is no reset boundary to straddle — the effective cap is always "at most `maxAttestedWithdrawVolumePerWindow` of value, decaying continuously," never briefly double-able. `SlippageAccumulator.sol` and this feature still carry two independent copies of the same decay formula rather than one shared library — noted as a follow-up refactor opportunity, not addressed in this implementation.

Sizing the cap and decay window is a manager-configurable operational parameter (start conservative — e.g., a small multiple of typical daily attested-withdrawal volume — and loosen as usage patterns are established), and it should itself be monitored: a cap that's repeatedly hit under normal conditions is a signal to raise it deliberately, not evidence it's unnecessary.

Together, these two controls mean a compromised backend key can, at worst, misallocate composition (never magnitude) for a capped, monitorable, rapidly-revocable volume of withdrawals — a materially smaller blast radius than "attacker has a valid signing key with no other constraints."

### New Roles & Storage

| Item                                                                 | Location                | Access control                                                                                                                                                                      |
| -------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `withdrawalAttester` (address)                                       | `PoolLogic` (new state) | Active signer; only changed via the propose/activate delay below                                                                                                                    |
| `pendingWithdrawalAttester`, `pendingAttesterActivationTime`         | `PoolLogic` (new state) | Set by `proposeWithdrawalAttester()`, `onlyManager`                                                                                                                                 |
| `attesterRotationDelay`                                              | `PoolLogic` (new state) | Settable by `onlyFactoryOwner` only, with a hardcoded on-chain minimum — **not** manager-settable; see rotation section below                                                       |
| `consumedPlanNonce` (`mapping(address => mapping(uint256 => bool))`) | `PoolLogic` (new state) | Written only internally by the new function                                                                                                                                         |
| `isAttestedWithdrawEnabled` (bool)                                   | `PoolLogic` (new state) | Instantly togglable via `setAttestedWithdrawEnabled(bool)`, `onlyManager`; **independent** of `isImmediateWithdrawEnabled`                                                          |
| `attestedWithdrawVolume` (`AttestedWithdrawVolume` struct)           | `PoolLogic` (new state) | Written only internally; see [circuit breaker](#bounding-a-compromised-attester-key)                                                                                                |
| `maxAttestedWithdrawVolumePerWindow`                                 | `PoolLogic` (new state) | Settable via `setMaxAttestedWithdrawVolumePerWindow(uint256)`, `onlyManager` (fail-closed if misconfigured — safe)                                                                  |
| `attestedWithdrawDecayWindow`                                        | `PoolLogic` (new state) | Settable via `setAttestedWithdrawDecayWindow(uint256)`, `onlyManager`, with a hardcoded on-chain minimum — see rotation section below for why a floor is required here specifically |
| `maxSurchargeBps`                                                    | `PoolLogic` (new state) | Settable via `setMaxSurchargeBps(uint256)`, `onlyFactoryOwner`, **not** manager-settable — see [Surcharge](#surcharge-pricing-the-composition-skew-externality) below               |

`isAttestedWithdrawEnabled` is deliberately a **separate** flag from `isImmediateWithdrawEnabled`, and this function should remain callable even when `isImmediateWithdrawEnabled == false`. The entire point of this feature is to provide relief precisely in the scenario the manager would otherwise handle by disabling immediate withdrawals pool-wide; coupling the two flags would defeat that purpose. The manager retains a genuine emergency stop (disable both) but is no longer forced to choose between "everyone blocked" and "no selective relief."

Attester **rotation** is intentionally asymmetric, mirroring the existing decrease-is-immediate / increase-is-delayed philosophy already used for fees (`setFeeNumerator` allows an immediate decrease; `announceFeeIncrease` → `commitFeeIncrease` requires a delay for an increase):

- `setAttestedWithdrawEnabled(false)` — **instant**, `onlyManager`. This is a pure capability _removal_; there is never a reason to delay it, and it must be available immediately if the backend key is suspected compromised. This is the incident-response kill switch.
- `proposeWithdrawalAttester(address candidate)` — `onlyManager`, records `pendingWithdrawalAttester` and `pendingAttesterActivationTime = block.timestamp + attesterRotationDelay`. (`uint256 public constant MIN_ATTESTER_ROTATION_DELAY = 24 hours;` — the floor referenced below.) **As implemented, this function additionally reverts (`AttestedWithdrawalNotInitialized`) if `attesterRotationDelay == 0`** — a finding from a later review pass: before `initializeAttestedWithdrawal()` or `setAttesterRotationDelay()` has ever run, the delay defaults to storage-zero, so without this guard a manager could propose and then instantly activate an attester in the same or next block, completely bypassing `MIN_ATTESTER_ROTATION_DELAY`. Every legitimate way the delay becomes nonzero already enforces the floor, so requiring it be nonzero here is sufficient.
- `activateWithdrawalAttester()` — callable by anyone once `block.timestamp >= pendingAttesterActivationTime`; commits `withdrawalAttester = pendingWithdrawalAttester`.

**`attesterRotationDelay` itself must not be manager-settable.** The whole point of the delay is to create a detection window against a _manager_ who is compromised, careless, or actively colluding — proposing a malicious attester and then also shortening (or zeroing) the delay would let that same actor route around the protection entirely, one `onlyManager` call away. This mirrors an existing, already-correct precedent in this codebase: `PoolManagerLogic._performanceFeeNumeratorChangeDelay` (the fee-increase delay) is set via `setFactoryConfig()`, which is `onlyFactoryOwner`, specifically _not_ something the manager can shorten on their own fee changes. `attesterRotationDelay` should follow the identical split: `factoryOwner`-settable (via the existing factory-config surface, or a dedicated setter with the same access control), with a hardcoded protocol-level minimum (e.g. 24h) enforced on-chain regardless of what `factoryOwner` sets it to, exactly paralleling `MAX_MIN_VALUE_OUT_BPS`'s role for `minValueOutBps`.

The same reasoning extends to the circuit breaker's own parameters: `attestedWithdrawDecayWindow` must have an enforced **minimum** (e.g. `require(newWindow >= MIN_ATTESTED_WITHDRAW_DECAY_WINDOW)`, proposed floor: 1 hour) in its setter. Without this floor, setting the decay window to `0` doesn't cause a division error (the accumulator's early-return branch, `elapsed >= window`, is always true when `window == 0`, since elapsed is never negative) — it silently makes `_currentDecayedAttestedVolume()` always return `0`, which fully disables the circuit breaker's memory across transactions with a single, non-obviously-dangerous-looking parameter value. `maxAttestedWithdrawVolumePerWindow` doesn't need a similar floor — setting it to `0` only fails closed (blocks all attested withdrawals, same effect as disabling the feature), which is safe, just a usability footgun rather than a security one.

This means _replacing trust in a new key_ is slow, observable, and outside the sole control of the actor being protected against (giving monitoring time to flag an unexpected rotation before it takes effect), while _withdrawing trust from a suspected-compromised key_ is instant and requires no coordination. Emitting `WithdrawalAttesterProposed` / `WithdrawalAttesterActivated` / `AttestedWithdrawEnabledSet` is required for off-chain monitoring — an unexpected proposal event is the highest-value thing to alert on, since it's the one action that (after its delay elapses) can reintroduce cherry-picking risk without any further code change.

### Surcharge: Pricing the Composition-Skew Externality

**This section addresses a different problem than Value Conservation does.** Value Conservation guarantees a withdrawal never extracts more (or delivers less) value than the withdrawing user's fUSD entitles them to — it protects against fund drain and against silent under-payment to the user. It does **not** address a separate, real cost this feature can impose on everyone who _doesn't_ withdraw: because an attested plan can deliberately skip whichever assets are currently impaired, favoring the healthy ones, every such withdrawal shifts the fund's remaining composition further toward the assets nobody wanted to touch. The pro-rata path doesn't have this problem — it touches every asset at the same proportion, so the fund's shape is preserved regardless of who withdraws or when. The attested path exists precisely because pro-rata sometimes can't be serviced; the price of that flexibility is a composition-skew cost that Value Conservation, by design, doesn't measure or charge for.

**"The manager can rebalance afterward" doesn't make this free — it only moves the cost.** A manager who notices a skewed pool can trade back toward target composition, but that trade itself costs real money (fees, price impact) — often against the exact assets that were thin enough to cause the original skew in the first place, so the rebalancing trade may not be materially cheaper than the withdrawal that necessitated it. Either the skew persists (a real, ongoing concentration risk for remaining stakers) or the manager pays to fix it (a real, immediate cost that still ultimately lands on the fund, and therefore on remaining stakers, via the trade's slippage). There is no version of this where the externality simply disappears. This is the same problem traditional funds solve with swing pricing or a dilution levy: redemptions that would force the fund away from its target allocation are charged an amount that approximates the cost of restoring it, and that charge is kept inside the fund rather than paid out, so the people who caused the cost bear a share of it instead of the people who stayed.

**The mechanism.** Computed inside `WithdrawalPlanLib.executeWithdrawalPlan()`, immediately after `valueBefore` and the circuit breaker's updated volume state are known — deliberately before the per-asset allocations loop runs (see below for why):

```solidity
pressure = min(decayedAccumulatedVolume(including this withdrawal) * 1e18 / valueBefore, 1e18)
effectiveMaxSurchargeBps = min(maxSurchargeBps, MAX_SURCHARGE_BPS_CEILING)
surchargeBpsX18 = pressure * effectiveMaxSurchargeBps            // bps scaled by 1e18, not truncated
if (ceil(surchargeBpsX18 / 1e18) > plan.maxAcceptableSurchargeBps) revert SurchargeTooHigh();

// ... after fairFusd is known:
surchargeAmount = fairFusd * surchargeBpsX18 / (1e18 * 10_000)
target = fairFusd - surchargeAmount
```

`pressure` is the same continuously-decaying volume accumulator the circuit breaker already tracks (see [Bounding a Compromised Attester Key](#bounding-a-compromised-attester-key)), expressed as a fraction of the fund's own current value rather than compared against a manually-chosen cap. This was a deliberate choice over the alternative of tracking each plan's actual asset-composition deviation directly: a composition-aware measure would price the externality more precisely, but computing it requires comparing the plan's allocations against the fund's live per-asset weights — real additional logic and storage reads this feature's bytecode budget could not absorb on top of everything else already in this function (see [Bytecode Size Budget](#implementation-note-bytecode-size-budget)). Scaling recent withdrawal volume against fund size is a cheaper proxy for the same thing: it needs no new state (the accumulator already exists), and it naturally captures both a single very large withdrawal and a burst of smaller ones, since either one moves the same underlying number. It does not distinguish a withdrawal that drained one already-thin asset from an equally-sized one spread evenly across many healthy assets — a known, accepted imprecision, not an oversight.

**Both sides of the value-conservation bound reference `target`, not `fairFusd`, once the surcharge is known.** This is not optional: the existing lower bound already only tolerates up to `minValueOutBps` (capped at 1%) below `fairFusd`, and nothing about `minValueOutBps` accounts for a surcharge the attester didn't know about when choosing it. Reducing what gets delivered without also moving the bound that delivery is checked against would make a correctly-behaving surcharged withdrawal revert against the very invariant meant to allow it. `target` is computed once, after `fairFusd` is known and validated, and both the upper bound (`valueDelta <= target + DUST_TOLERANCE`) and the lower bound (`valueDelta >= target - target * minValueOutBps / 10_000`) are checked against it.

**Why the attester signs its own ceiling.** `pressure` — and therefore `surchargeBps` — depends on live, execution-time state the attester cannot know precisely when composing a plan off-chain: another attested withdrawal can land first and move the shared accumulator between signing and execution. `plan.maxAcceptableSurchargeBps` lets the attester bound their own exposure to that drift explicitly, the same trust pattern already proven for `minValueOutBps` — the attester proposes their own tolerance, the protocol enforces a separate hardcoded ceiling regardless of what's signed. Checking it immediately, before `_processAllocations()`'s per-asset guard-dispatch loop runs, means a plan that would exceed it fails with a specific, cheap revert (`SurchargeTooHigh`) rather than paying for a full withdrawal attempt that would only fail later, less specifically, on the value-conservation bound instead.

**The withheld value stays in the fund through the ordinary accounting — no special adjustment is needed or applied.** The user burns their full entitlement of fUSD but receives only `target`, so the real outflow (`valueDelta`, measured from the fund's value before and after) is smaller than a surcharge-free withdrawal's by exactly the surcharge. `PoolLogic` reduces `accountedAssets` by that real outflow (plus the existing FNA-42 loss share), the same as for any withdrawal, which keeps `accountedAssets` equal to NAV: there is no overhang (which would swallow the next genuine yield) and no gap (which the next accrual would read as yield and charge the manager's performance fee on). The retained slice therefore shows up as extra backing per remaining claim, never as a yield event. An earlier version of this design subtracted `surchargeAmount` from the reduction as well; that double-counted the retention and left `accountedAssets` above NAV by the surcharge, and was removed after an independent review caught it. `surchargeAmount` is now informational only (it is emitted in `AttestedWithdrawPlanExecuted`).

**Governance is deliberately asymmetric and, on both directions, kept away from whoever might benefit from moving it.** `maxSurchargeBps` is `factoryOwner`-only, mirroring `attesterRotationDelay`'s existing precedent — but unlike that parameter, the manager doesn't collect this money, so the risk isn't the manager raising it to extract more; it's the manager (or, in principle, `factoryOwner`) being able to quietly zero it out to make the feature look consequence-free, or set it unreasonably high with no real bound. Both directions are closed the same way `minValueOutBps` already is: `WithdrawalPlanLib.MAX_SURCHARGE_BPS_CEILING`, a hardcoded constant, clamps the real applied surcharge regardless of what `maxSurchargeBps` is ever set to, so `setMaxSurchargeBps()` itself needs no bound-check logic of its own — a deliberate, bytecode-motivated choice, not an oversight (see [Bytecode Size Budget](#implementation-note-bytecode-size-budget)). No floor is enforced on `maxSurchargeBps`, matching `maxAttestedWithdrawVolumePerWindow`'s own precedent: a value of `0` disables the surcharge cleanly and safely, it doesn't silently corrupt anything else the way an unfloored decay window would.

**No threshold, no cliff.** `surchargeBps` ramps continuously with `pressure` — there is no fixed line a withdrawal crosses that suddenly activates a fee. This was a deliberate design constraint, not an accident: mechanisms that snap on at a threshold create an incentive for anyone watching the relevant state to race ahead of that threshold, which would work against the exact users this feature exists to help.

### Interaction with Existing Systems

- **Guards are untouched.** Every `IAssetGuard` / `IComplexAssetGuard` / `ISlippageCheckingGuard` implementation works as-is; this feature only relocates and reuses the _orchestration_ around them (see [Bytecode Size Budget](#implementation-note-bytecode-size-budget) for exactly how `_withdrawProcessing`'s equivalent logic moves into a shared library used by both the existing pro-rata path and this new one).
- **`reservedAssetBalance` (queued-withdrawal reservations)** is respected automatically, for the same reason: the per-asset withdrawal logic already subtracts reserved balance before computing a withdrawable amount regardless of which entrypoint calls it, and this function doesn't bypass that path.
- **Cooldown** (`TokenLogic.getExitRemainingCooldown`) is enforced identically to `withdrawCashImmediate()`. This feature changes _which assets_ a withdrawal draws from, not _whether_ a withdrawal is allowed to happen at all.
- **`accountedAssets`** bookkeeping is unchanged in mechanism — same before/after fund-value delta subtraction — just gated by the new two-sided bound instead of the one-sided bound.

### Security Considerations

- **Do not wire this function through `_actionSender()` / `IUserActionSender.actionUser()`.** The current `feature/06-aave-v4` branch introduced `_actionSender()`, which trusts any address on `PoolManagerLogic.allowedCallbackSenders` (manager-controlled, `onlyManager`, no validation of what's added) to declare an arbitrary "acting user" for `stake`/`unstake`/`withdrawCashImmediate`/`deposit` — a manager-whitelisted helper contract can currently force those actions against any address with a standing token allowance, without that user's consent for the specific transaction (flagged previously on this branch). Routing this new function through the same mechanism would let a manager similarly force an attested withdrawal against a victim's balance. Until that identity-resolution issue is remediated with a real consent-binding mechanism, `withdrawCashImmediateWithPlan()` should key off plain `msg.sender` only.
- **Attester key compromise** degrades this feature to the cherry-picking risk profile of a naive user-self-signed design (attacker can now pick any asset mix for any user's withdrawal) but — because of the two-sided value-conservation check — **cannot** extract more value than the specific withdrawal's own `netFusd` entitles, for any single plan. It also cannot mint new plans for users who never call the function; it can only shape the composition of a withdrawal the user themselves initiates. The rolling-window volume cap and instant-revoke switch (see [Bounding a Compromised Attester Key](#bounding-a-compromised-attester-key)) additionally cap cumulative damage from a compromise that goes undetected for a period of time, which is the realistic failure mode for an automated backend signer rather than a one-shot leak.
- **Stale/replayed plans** are prevented by the deadline + single-use nonce; a short attester-chosen deadline (minutes, not hours) additionally limits staleness against balance/price drift between signing and execution.
- **Asset-list drift between signing and execution** (an asset in the plan gets removed from `supportedAssets` after signing but before the transaction lands) is caught by the on-chain `isSupportedAsset` re-check at execution time — the plan is not blindly trusted to reflect current pool configuration.
- **Duplicate allocation entries** for the same asset must be rejected explicitly; otherwise a plan could double-invoke `_withdrawProcessing()` against the same balance in one transaction (each call reduces the on-chain balance so a second call wouldn't double-withdraw in practice, but it wastes gas and complicates the value-conservation accounting for no legitimate use case — reject rather than silently tolerate).
- **Front-running / MEV on plan submission** is not a meaningful new concern: the plan already commits to specific amounts/portions and a value-conservation bound: seeing a pending plan in the mempool gives an observer no exploitable edge, since the transaction either executes within its committed bounds or reverts.
- **Gas griefing via a maximal `allocations` array** is bounded the same way `withdrawCashImmediateSafe`'s `complexAssetsData` already is today — by the size of `getSupportedAssets()`, which is itself capped by `PoolManagerLogic._maximumSupportedAssetCount` (default 50).
- **Dust-tolerance farming is not economically viable.** The fixed upper-bound `DUST_TOLERANCE` permits at most a tiny, fixed USD overpayment per call. Extracting anything meaningful this way would require an enormous number of separate transactions, each paying real gas — the gas cost dominates the extractable dust by orders of magnitude at any realistic gas price, so this isn't a practical griefing/extraction vector and doesn't need a mitigation beyond keeping the tolerance small (matching the existing `1e15` precedent).
- **The circuit breaker is pool-wide, not per-user, by design.** A per-user cap would not address the actual threat it targets: a single compromised backend key signing plans for _many different users'_ own, individually-legitimate withdrawals, each one within that user's own entitlement, but collectively still systematically cherry-picking the healthy assets out of the pool. Only a pool-wide aggregate cap bounds that. The trade-off is accepted explicitly: a single large legitimate withdrawal (or a burst of them) can temporarily exhaust the window for everyone else, who then fall back to `withdrawCashImmediate()` or the queued flow rather than being blocked outright — and the manager can raise `maxAttestedWithdrawVolumePerWindow` if legitimate demand routinely collides with it.

## Part 3 — Implementation

### Implementation Note: Bytecode Size Budget

`PoolLogic`'s deployed bytecode was **24,485 of 24,576 bytes** (the EIP-170 contract-size limit) — **91 bytes of headroom** — at the time this section was first drafted, measured with the per-file `optimizer.runs: 1` override already present in `hardhat.config.ts:111-116` (i.e., the standard gas-for-size trade-off is _already_ spent; there is no compiler-flag lever left to pull). (That 91-byte figure was itself slightly stale by the time implementation planning started — a re-measurement on the feature branch found 129 bytes — but the conclusion was identical either way.) Every function this design adds (a new external entrypoint, a new struct, EIP-712 hashing, the circuit breaker, the rotation logic) needed to fit in that headroom — which it obviously wouldn't. This needed a genuine architectural fix, not a config tweak, before implementation could start. See the measured outcome below.

**The fix: extract to an externally-linked library, following an already-proven pattern in this codebase.** `PoolTxExecutor.sol` and `FundCalculationLibrary.fusdToAssetAmount` are both Solidity libraries with `external` (not `internal`) functions. The compiler deploys these as their own separate contracts and has `PoolLogic` reach them via `delegatecall` at the linked address — their bytecode does **not** count against `PoolLogic`'s own 24KB limit; `PoolLogic` only pays for a small dispatch stub per call. Put essentially all of the new logic (EIP-712 verification via `SignatureChecker`, allocation validation, fixed-amount/portion conversion, the two-sided value-conservation math, the decaying circuit-breaker math) into a new library, `WithdrawalPlanLib.sol`, following this exact precedent.

**Important constraint on how this is wired up:** it's tempting to describe the new per-asset loop as simply calling the existing `_withdrawProcessing()` unchanged, but that's not achievable — `_withdrawProcessing` is `internal` to `PoolLogic`, and internal functions are not part of a contract's ABI; they compile to plain jump instructions inside `PoolLogic`'s _own_ bytecode. A `delegatecall` from `PoolLogic` into a separately-deployed library runs the _library's_ bytecode (with `PoolLogic`'s storage/`msg.sender`/`address(this)` context) — it cannot jump into a function that only exists in `PoolLogic`'s own, separately-compiled bytecode. So `WithdrawalPlanLib` cannot literally call `_withdrawProcessing`; it needs its own implementation of the equivalent guard-dispatch logic (guard lookup via `IPoolManagerLogic.getAssetGuard`, balance query, `reservedAssetBalance` subtraction via the existing public `IPoolLogic.reservedAssetBalance` getter, complex-vs-regular dispatch, low-level execution of the guard-returned `MultiTransaction[]`, per-operation slippage check) — reachable only via the same public/external interfaces any other external contract would use, exactly how `PoolTxExecutor` already operates today without reaching into `PoolLogic` internals.

Given that, the better move is not to duplicate `_withdrawProcessing`'s logic into the new library, but to **extract `_withdrawProcessing` itself out of `PoolLogic` and into the (shared) library**, and have _both_ the existing pro-rata loop in `_withdrawCashImmediateToSafe()` and the new selective-plan loop call the one library implementation. This does double duty: it recovers existing bytecode (not just enough headroom for the new feature, but more, since `_withdrawProcessing` is a non-trivial chunk of today's 24,485 bytes) and avoids the alternative of shipping two near-identical implementations of the same per-asset withdrawal logic that could silently drift apart under future maintenance.

**As implemented, this extraction went further than the plan above.** `WithdrawalPlanLib` doesn't only hold `withdrawProcessing()` (the per-asset guard-dispatch loop) — it also holds `executeProRataWithdrawal()` and `executeWithdrawalPlan()`, which absorb the fee/cooldown computation, the fee transfer, the fUSD burn, and the value-conservation math for _both_ withdrawal paths, not just the per-asset loop. `PoolLogic` itself now performs only the storage writes those functions' results feed directly (`accountedAssets`, `consumedPlanNonce`, `attestedWithdrawVolume`) plus emitting events — none of which touch the library, since none of it is storage the library is allowed to hold. This was necessary because the new feature's logic (signature verification, plan validation, the circuit breaker, the two-sided value bound) did not fit in the headroom `_withdrawProcessing`'s extraction alone recovered; moving the fee/burn/loop orchestration for both paths out as well closed the remaining gap. `_chargeWithdrawFee()` is consequently a genuine, intentional duplicate of `PoolLogic`'s pre-existing internal fee logic (kept, not removed, for `FundCalculationLibrary`'s other call sites) — the two must be kept in sync manually if the exit-fee formula ever changes; there is no automated check for this.

**Measured outcome:** `PoolLogic` is currently deployed at 24,225 of 24,576 bytes — **351 bytes of headroom**, up from the pre-implementation figure of 129 bytes this document's implementation-planning stage measured (itself already a correction of an earlier, stale 91-byte figure). The extraction recovered enough margin to add the full feature and still leave room for future work, without needing any of the fallback levers below (`viaIR`, `require`-string conversion, `metadata.bytecodeHash`) — none were used.

**The [Surcharge](#surcharge-pricing-the-composition-skew-externality) addition, shipped afterward, spent most of that margin back down.** Its own logic (the pressure/target math, the new signed field, the new event field) lives almost entirely in `WithdrawalPlanLib`, which has ample room — but the new `factoryOwner`-gated setter, the new storage variable's public getter, and the extra `initializeAttestedWithdrawal` parameter all had to land in `PoolLogic` itself, where headroom was already thin. The first working version of this addition left `PoolLogic` at just **6 bytes of headroom** — technically within the EIP-170 limit, but far too little margin to ship: any later change, even a single new `require` string, would have broken deployability outright. The fix was extending this section's own established pattern one step further: `CashWithdrawImmediateProRata` and `AttestedWithdrawPlanExecuted` are now `emit`ted from directly inside `WithdrawalPlanLib.executeWithdrawalPlan()`, not from `PoolLogic`, moving their (non-trivial, dynamic-array-containing) event-encoding bytecode out of the constrained contract entirely. This relies on one additional piece of EVM behavior beyond what the rest of this library already leans on: a `delegatecall` preserves the caller's address for the `LOG` opcode the same way it preserves it for `SSTORE`, so an event emitted from inside the library is indistinguishable on-chain — same topic0, same emitting address — from one `PoolLogic` emitted itself. `PoolLogic` still _declares_ both events (for ABI completeness, so an off-chain indexer reading `PoolLogic`'s own ABI can still decode them), it just no longer contains the code to emit them from this path. That single change brought headroom back up to **200 bytes** — tighter than before the surcharge, but a real, workable margin rather than a rounding error.

**Delegatecall-into-a-library carries one well-known, high-severity hazard that must be designed against explicitly: the library must never declare its own storage variables.** A library used via `delegatecall` executes with the _caller's_ storage — if the library itself declares state variables, they occupy the caller's storage slots by position, and a mismatch between what the library "thinks" is at a given slot and what `PoolLogic` actually has there causes silent, arbitrary storage corruption. This is precisely the bug class behind the 2017 Parity multisig library freeze (~$150M+ locked), which resulted from exactly this pattern: a delegatecall-based library that itself held mutable state. `WithdrawalPlanLib` (and any function newly extracted into it, including `_withdrawProcessing`) must be written so every function takes all needed values as explicit parameters and returns explicit outputs — `PoolLogic` performs every `SSTORE` itself, in its own code, after the library call returns. None of the new storage this feature needs (`withdrawalAttester`, `consumedPlanNonce`, `isAttestedWithdrawEnabled`, the circuit-breaker struct, the pending-attester rotation state) should ever be read or written from inside the library directly — only ever passed in and handed back.

**Reentrancy is unaffected by this restructuring.** `nonReentrant` guards the outer `withdrawCashImmediateWithPlan()` entrypoint in `PoolLogic`'s own storage; a `delegatecall` into the library executes within the _same_ call frame and the _same_ storage context as that outer call — it is not a new external call boundary the reentrancy guard needs to separately account for, the same way today's `PoolTxExecutor.exec()` delegatecall doesn't create a reentrancy gap around `execTransaction()`.

Beyond the library extraction (the primary, necessary fix), if headroom is still tight after moving `_withdrawProcessing` and the new logic out:

- Convert any remaining `require(cond, "string")` reverts in `PoolLogic` to custom `error` types where not already done — each unique revert string costs bytecode for the literal plus its ABI-encoding path, and `PoolLogic` already uses custom errors extensively elsewhere, so finishing that conversion is low-risk, mechanical, and consistent with existing style.
- Experiment with `viaIR: true` alongside the existing `runs: 1` override for `PoolLogic` specifically — IR-based codegen sometimes produces smaller output due to better inlining/dead-code decisions, at the cost of longer compile times; measure before/after, since it isn't guaranteed to help and can occasionally regress.
- Confirm `metadata.bytecodeHash` isn't unnecessarily inflating the deployed size (a small, ~53-byte fixed cost, but free to check).

### Upgrade & Storage Migration

Following the pattern already established for `initializeAutoCompounding()` (`reinitializer(2)`):

As implemented (custom errors, not `require(string)`, matching `PoolLogic`'s existing style; no `__EIP712_init` call — see [EIP-712 Typed Data](#eip-712-typed-data) on why the domain separator is hand-rolled in `WithdrawalPlanLib` instead of inherited here; a fifth parameter, `maxSurchargeBps_`, was added once the [Surcharge](#surcharge-pricing-the-composition-skew-externality) mechanism landed — see that section for why it's bundled into this same initializer rather than a later, separate migration):

```solidity
/// @custom:oz-upgrades-validate-as-initializer
function initializeAttestedWithdrawal(
    address attester_,
    uint256 attesterRotationDelay_,
    uint256 attestedWithdrawDecayWindow_,
    uint256 maxAttestedWithdrawVolumePerWindow_,
    uint256 maxSurchargeBps_
) external onlyOwner reinitializer(3) {
    if (withdrawalAttester != address(0)) revert AttestedWithdrawalAlreadyInitialized();
    if (attester_ == address(0)) revert ZeroAddress();
    if (attesterRotationDelay_ < MIN_ATTESTER_ROTATION_DELAY) revert RotationDelayTooShort();
    if (attestedWithdrawDecayWindow_ < MIN_ATTESTED_WITHDRAW_DECAY_WINDOW) {
        revert DecayWindowTooShort();
    }

    withdrawalAttester = attester_;
    attesterRotationDelay = attesterRotationDelay_;
    attestedWithdrawDecayWindow = attestedWithdrawDecayWindow_;
    maxAttestedWithdrawVolumePerWindow = maxAttestedWithdrawVolumePerWindow_;
    maxSurchargeBps = maxSurchargeBps_;
}
```

Both minimums (`MIN_ATTESTER_ROTATION_DELAY`, `MIN_ATTESTED_WITHDRAW_DECAY_WINDOW`) are enforced here too, not just in the standalone setters, so the feature can never launch in an already-defeated state. `withdrawalAttester != address(0)` additionally guards against this initializer running twice for the same reinitializer version through some future upgrade-tooling misuse — `reinitializer(3)` already prevents that under normal operation, but the check costs little and matches this contract's general fail-closed posture. `maxSurchargeBps_` deliberately has no floor check here, matching `maxAttestedWithdrawVolumePerWindow_`'s own "0 is safe" precedent — the pool can launch with the surcharge disabled and turn it on later via `setMaxSurchargeBps()`. The initializer also deliberately leaves `isAttestedWithdrawEnabled` false: the feature pays out user funds on the strength of a hot attester key, so the manager enables it explicitly, after verifying the attester service, rather than it going live as a side effect of an upgrade. It must run as a separate owner-sent transaction after an empty-data `upgradeAndCall` (the ProxyAdmin, not the owner, is `msg.sender` inside `upgradeAndCall`'s init call), and — on a pool that has not yet run `initializeAutoCompounding()` — strictly after it; see `docs/upgradeable-contracts-notes.md` for the full sequence and why the order is not optional.

`PoolLogic` does not inherit `EIP712Upgradeable` and reserves no storage `__gap`, unlike `TokenLogic`/`PoolManagerLogic`. New state (`withdrawalAttester`, `pendingWithdrawalAttester`, `pendingAttesterActivationTime`, `attesterRotationDelay`, `consumedPlanNonce`, `isAttestedWithdrawEnabled`, `attestedWithdrawVolume`, `attestedWithdrawDecayWindow`, `maxAttestedWithdrawVolumePerWindow`, `maxSurchargeBps`) is appended after all existing storage variables (immediately after `pendingCashWithdrawCount`), never inserted between them — `maxSurchargeBps` specifically had to go last, not near the conceptually-related `attestedWithdrawVolume` block, since append-only-at-the-end is the only thing protecting this contract's storage layout in the absence of a `__gap`. Extracting `_withdrawProcessing` (and, as implemented, the rest of both withdrawal paths' orchestration — see [Bytecode Size Budget](#implementation-note-bytecode-size-budget)) into the shared library is pure code motion and declares no new storage of its own — it does not affect this migration's storage-layout accounting. This migration should ship in the same governance/Timelock upgrade batch as the implementation swap, mirroring the checklist format in `docs/upgradeable-contracts-notes.md`'s "Attested Selective Withdrawal Upgrade" section.

### Testing Plan

- Happy path: plan excluding one (simulated-illiquid) asset succeeds where `withdrawCashImmediate()` would have reverted on that asset's guard.
- Two-sided value-conservation: a plan engineered to over-deliver reverts; a plan engineered to under-deliver (e.g., referencing an asset whose balance shrank between signing and execution) also reverts — neither silently succeeds.
- Signature/replay: wrong signer rejected; expired deadline rejected; nonce reuse rejected; asset removed from `supportedAssets` after signing rejected.
- `isAttestedWithdrawEnabled = false` blocks the function independently of `isImmediateWithdrawEnabled`'s state (test all four combinations of the two flags).
- Duplicate asset entries in `allocations` rejected.
- Interaction with `reservedAssetBalance`: a plan cannot draw down assets reserved for pending queued-withdrawal claims.
- Fixed-amount vs. portion mode both produce the correct realized withdrawal for the same underlying balance.
- Rotation asymmetry: `setAttestedWithdrawEnabled(false)` takes effect immediately; `activateWithdrawalAttester()` reverts before `pendingAttesterActivationTime` and succeeds after; `proposeWithdrawalAttester()` does not itself change `withdrawalAttester`.
- Circuit breaker: a plan that would push the decayed accumulator over `maxAttestedWithdrawVolumePerWindow` reverts; the accumulator decays continuously rather than resetting at a fixed boundary (explicitly test that two large withdrawals timed just before/after where a naive fixed-window reset would have landed still correctly sum against the cap); volume from `withdrawCashImmediate()` does not count toward this cap (and vice versa).
- Signature scheme: a plan signed by the correct EOA attester verifies via `SignatureChecker`; repoint `withdrawalAttester` at a minimal ERC-1271 mock contract and confirm a contract-signed plan verifies identically.
- `minValueOutBps` bound: a plan with `minValueOutBps > MAX_MIN_VALUE_OUT_BPS` is rejected outright, regardless of the actual realized delivery; a plan within the cap that under-delivers by more than its own `minValueOutBps` still reverts.
- Fixed-amount mode against a zero-balance asset reverts with a clear reason rather than an implicit division-by-zero panic.
- Governance split: `setAttestedWithdrawEnabled`/`proposeWithdrawalAttester`/`setMaxAttestedWithdrawVolumePerWindow`/`setAttestedWithdrawDecayWindow` all revert for a non-manager caller; `attesterRotationDelay`'s setter reverts for a non-factoryOwner caller (including the manager); a manager cannot set `attestedWithdrawDecayWindow` below `MIN_ATTESTED_WITHDRAW_DECAY_WINDOW`, and confirm a window set to that minimum still meaningfully bounds volume rather than degenerating to per-transaction-only.
- `initializeAttestedWithdrawal` reverts if either minimum-delay/window argument is below its respective floor, even on a fresh migration.

**As implemented:** `test/AttestedWithdrawal.test.ts` carries 37 dedicated tests covering every item above, plus several added during post-implementation review that weren't anticipated in the original plan: a haircut-parity test mirroring the existing FNA-05 underwater-pool fixture exactly (confirming an attested plan now gets haircut the same as the pro-rata path instead of paying out at par); a dedicated "temporary liquidity gap" test (using a guard's own withdrawable-balance cap, independent of the underwater-pool case) for the `fairFusd > valueBefore` fail-fast check; and two tests added specifically because `complexAssetsData` had zero direct coverage through this entry point — one confirming `slippageTolerance` is actually enforced on regular guard dispatch, one confirming full `IComplexAssetGuard` processing (non-empty `withdrawData`) dispatches and propagates guard reverts correctly. The full repository test suite passes with this feature included.

A further 11 tests cover the [Surcharge](#surcharge-pricing-the-composition-skew-externality) mechanism specifically: the core `pressure`/`target`/`surchargeAmount` arithmetic against an independently hand-computed expected value; the `SurchargeTooHigh` boundary at exact equality; the hardcoded `MAX_SURCHARGE_BPS_CEILING` clamp holding even when the governed `maxSurchargeBps` is set far above it; the surcharge being a complete no-op at its `0` storage default regardless of pressure; `plan.maxAcceptableSurchargeBps` being bound into the signed EIP-712 digest (tampering with it post-signature invalidates the signature); `setMaxSurchargeBps`'s `factoryOwner`-only gating; pressure genuinely accumulating across sequential withdrawals rather than resetting per call; a single large withdrawal triggering the check on its own, with no prior accumulated volume needed; the surcharge computing correctly against the haircut-adjusted `fairFusd` (not the raw claim) in an underwater pool; and — empirically, not just by static reasoning — that both events emitted from inside the delegatecalled `WithdrawalPlanLib` are correctly attributed to the pool's own address on-chain.

## Part 4 — Review History

### Design Refinements

This design was reviewed before implementation planning, specifically because it introduces the hottest, most-automated signing key of any role in the protocol and a new delegatecall-based architecture needed just to fit within `PoolLogic`'s remaining bytecode budget — both are exactly the kind of change that deserves more scrutiny than a first pass gets. Points are listed most-severe first; every one is resolved in the sections above, not just noted here.

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Severity                                                                 | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A delegatecall-based library that declares its own storage variables corrupts the caller's storage at whatever slot positions those variables occupy — the exact bug class behind the 2017 Parity multisig library freeze. The first draft didn't call this out explicitly for `WithdrawalPlanLib`.                                                                                                                                                                                                          | High                                                                     | Explicit mandate added: the library must never declare storage; every function takes state as parameters and returns it, `PoolLogic` performs every `SSTORE` itself. See [Bytecode Size Budget](#implementation-note-bytecode-size-budget).                                                                                                                                                                                                                      |
| 2   | The first draft said the new selective-withdrawal loop would "call the existing, unmodified `_withdrawProcessing()`" from the new library. This isn't achievable: `_withdrawProcessing` is `internal`, and internal functions compile to jumps inside `PoolLogic`'s own bytecode, unreachable via `delegatecall` into a separately-deployed library. Left uncorrected, this would have blocked implementation or led to an ad hoc, undocumented duplication of the withdrawal logic.                         | High (feasibility/correctness)                                           | Corrected the plan: extract `_withdrawProcessing` itself into the shared library, used by both the existing pro-rata path and the new selective path — recovers more bytecode than the minimum needed and avoids duplicated logic drifting apart over time.                                                                                                                                                                                                      |
| 3   | Signature verification assumed a single raw EOA key (`ECDSA.recover(...) == withdrawalAttester`) for the highest-risk, most-automated signer in the system, with no path to strengthen it later without a further contract change.                                                                                                                                                                                                                                                                           | Medium                                                                   | Switched to `SignatureChecker.isValidSignatureNow`, supporting both EOA and ERC-1271 (contract) signers transparently — leaves room to later point `withdrawalAttester` at a co-signing contract without touching `PoolLogic` again. (During implementation this was further replaced with a hand-rolled equivalent, for an unrelated reason — see [EIP-712 Typed Data](#eip-712-typed-data) and [Post-Implementation Findings](#post-implementation-findings).) |
| 4   | The circuit breaker's original fixed-window design (hard reset to zero every N hours) allows up to ~2× the intended cap to be released in a short span straddling the reset boundary — a known property of periodic-reset rate limiters, not a coding bug, but still a real gap against the stated threat.                                                                                                                                                                                                   | Medium                                                                   | Replaced with a continuously-decaying accumulator, reusing the exact math already implemented and reasoned about in `SlippageAccumulator.sol`. No reset boundary exists to straddle.                                                                                                                                                                                                                                                                             |
| 5   | The attester rotation delay and the circuit breaker's decay window were both originally bare `onlyManager` parameters with no floor. A compromised, careless, or actively colluding manager could shorten the rotation delay to near-zero (defeating the detection window before swapping in a malicious attester) or zero the decay window (silently disabling the circuit breaker's cross-transaction memory) — undermining protections whose entire purpose is to contain a _separately_-compromised key. | Medium–High (governance bypass)                                          | Rotation delay moved to `factoryOwner`-only control (mirroring the existing `_performanceFeeNumeratorChangeDelay` pattern) with a hardcoded minimum (`MIN_ATTESTER_ROTATION_DELAY`, proposed 24h); decay window keeps `onlyManager` control but gains a hardcoded minimum (`MIN_ATTESTED_WITHDRAW_DECAY_WINDOW`, proposed 1h) enforced both in its setter and in the migration initializer.                                                                      |
| 6   | `minValueOutBps` existed in the signed struct but was never wired into an actual on-chain check in the first draft — decorative, costing signature/calldata size for no enforcement benefit.                                                                                                                                                                                                                                                                                                                 | Low–Medium                                                               | Wired in as the actual, protocol-capped lower bound of the two-sided value-conservation check (`MAX_MIN_VALUE_OUT_BPS` ceiling prevents a compromised attester from widening it enough to leak meaningful value).                                                                                                                                                                                                                                                |
| 7   | Fixed-amount mode's portion conversion (`fixedAmount * 1e18 / balance`) would hit an implicit division-by-zero panic if the target asset's guard-reported balance is currently zero, rather than a clear, intentional revert reason.                                                                                                                                                                                                                                                                         | Low                                                                      | Explicit `require(balance > 0)` added before the division, with a clear revert reason.                                                                                                                                                                                                                                                                                                                                                                           |
| 8   | The circuit-breaker check was originally positioned after the withdrawal loop executed, wasting gas on a doomed transaction whenever the cap would be exceeded, and recording an ambiguous "realized" value rather than a value known upfront.                                                                                                                                                                                                                                                               | Low (gas/clarity, not correctness — an atomic revert unwinds either way) | Moved earlier, checked and recorded against the deterministic `netFusd` right after fee/cooldown computation, before burning or touching any guard — fails fast, and is intentionally conservative relative to the eventual realized delta.                                                                                                                                                                                                                      |

**Considered and confirmed not to need a fix** (worth recording so they aren't re-litigated later):

- A `delegatecall` into the library executes in the same call frame and storage context as the `nonReentrant`-guarded outer call — it introduces no new reentrancy boundary, the same way `PoolTxExecutor.exec()`'s existing delegatecall doesn't around `execTransaction()`.
- `EIP712Upgradeable`'s domain separator already binds `chainId` and `verifyingContract`; no extra pool-identifying field is needed inside `WithdrawalPlan` to prevent cross-contract/cross-chain replay.
- An empty `allocations` array is rejected automatically by the lower value-conservation bound (a zero delta fails against any `netFusd > 0`) — no special-case code needed.
- The fixed dust-level upper-bound tolerance is not economically farmable across many transactions; gas cost dominates the extractable amount by orders of magnitude.
- The circuit breaker being pool-wide rather than per-user is an intentional trade-off, not an oversight — a per-user cap wouldn't address the actual threat (one compromised key acting across many different users' own, individually-legitimate withdrawals).

### Post-Implementation Findings

The table above records what changed between this document's first draft and its implementation-ready form. This table records what changed **after** code existed, across several rounds of review against the actual implementation — the kind of scrutiny that surfaces different classes of issues than a pre-implementation design read can. Every finding below was fixed; each is also explained in full, in place, in the section its fix touches — this table exists as a single index, not a duplicate explanation.

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Severity                                  | Where it's explained                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------- |
| 1   | The two-sided value-conservation bound was implemented against the raw, nominal `netFusd` rather than the solvency-haircut-adjusted `fairFusd` the pro-rata path already uses — in an underwater pool, an attested withdrawal could pay out at par while every other withdrawal was haircut proportionally, extracting more than a fair share from remaining stakers (reopening the exact loss-socialization problem FNA-05 closed for the pro-rata path). | High (fund-safety, underwater pools only) | [Value Conservation](#value-conservation-the-core-safety-invariant)         |
| 2   | `proposeWithdrawalAttester()` had no check that `attesterRotationDelay` had ever been meaningfully set — before `initializeAttestedWithdrawal()` runs it defaults to 0, so a manager could propose and instantly activate an attester with zero real delay, completely bypassing `MIN_ATTESTER_ROTATION_DELAY`.                                                                                                                                            | High (governance bypass)                  | [New Roles & Storage](#new-roles--storage)                                  |
| 3   | `OpenZeppelin`'s `SignatureChecker`, as specified in the pre-implementation draft, does not compile under this repo's targeted EVM version (transitively requires the Cancun-only `mcopy` opcode; this repo targets Paris) — discovered only once the code was actually written and compiled, not by reading the design.                                                                                                                                   | Medium (feasibility)                      | [EIP-712 Typed Data](#eip-712-typed-data)                                   |
| 4   | A direct (non-fixed-amount) allocation `portion` had no on-chain upper bound; a value above `1e18` depended on guard-specific behavior to fail safely rather than being rejected outright.                                                                                                                                                                                                                                                                 | Medium                                    | [Data Structures](#data-structures)                                         |
| 5   | `attestedWithdrawVolume.accumulatedValueUsd` is a storage `uint128`, but neither `maxAttestedWithdrawVolumePerWindow` nor a single `netFusd` had an enforced ceiling — a value above `type(uint128).max` would silently truncate on cast rather than revert.                                                                                                                                                                                               | Medium                                    | [Bounding a Compromised Attester Key](#bounding-a-compromised-attester-key) |
| 6   | The manager fee-bypass branch could execute a zero-`fusdAmount` plan without burning anything, while the allocations loop (not itself derived from `fusdAmount`) could still release real value within `DUST_TOLERANCE` — asymmetric with `_withdrawCashImmediateToSafe`'s unconditional zero-amount check.                                                                                                                                                | Medium                                    | [Function Signature](#function-signature)                                   |
| 7   | `attestedWithdrawDecayWindow` defaults to 0 until explicitly configured; nothing required it be set before the feature could otherwise be enabled via the individual setters, silently degrading the circuit breaker to a stateless per-transaction check with zero cross-transaction memory.                                                                                                                                                              | Medium                                    | [Bounding a Compromised Attester Key](#bounding-a-compromised-attester-key) |
| 8   | `computeImmediateWithdrawPortion`'s "temporary liquidity gap" branch (pool solvent overall, not everything liquid right now) returns `fairFusd` uncapped by the currently-withdrawable fund value — a stricter re-review of finding 1's own fix found the equivalent of the pro-rata path's zero-portion short-circuit was missing here, so this path would fall through into a doomed loop instead of failing fast with a specific error.                 | Low (gas/clarity, not fund-safety)        | [Value Conservation](#value-conservation-the-core-safety-invariant)         |
| 9   | `complexAssetsData` — and specifically the address-based `_matchComplexAsset` lookup this path needs (unlike the pro-rata path's dense, index-matched loop) — had zero direct test coverage from this entry point; every existing test passed an empty array.                                                                                                                                                                                              | Low (test coverage, not a code defect)    | Testing Plan's "As implemented" note, above                                 |

## Open Questions

1. **Partial fills.** Should a single signed plan be spendable across multiple transactions (e.g., attester signs "up to X", user draws down incrementally)? v1 assumes single-use, exact-match `fusdAmount` for simplicity; revisit if attester-service latency/cost makes per-request signing too expensive at scale.
2. **Circuit-breaker window sizing.** `attestedWithdrawDecayWindow` and `maxAttestedWithdrawVolumePerWindow` (above their respective floors) need real usage data to calibrate — too tight and the feature becomes unusable during genuine high-demand periods; too loose and it stops meaningfully bounding a compromise. Propose launching conservative and adjusting via telemetry rather than guessing a permanent value upfront.
3. **Multiple attesters / threshold signing.** Out of scope for v1 (single attester address), but the two-sided value bound plus the circuit breaker mean the security cost of a single-key model is already fairly contained; a multi-sig or threshold-signed attester would primarily improve availability and reduce single-server compromise risk further, not fix a fund-safety gap that would otherwise exist.
