# Attested Selective Withdrawal — Design Doc

## Status

Draft — design proposal, not yet implemented. No contract changes accompany this document. Iterated on before implementation planning (see [Design Refinements](#design-refinements)); several mechanisms below (signature verification, circuit breaker, value-conservation bounds) were changed from the first pass as a direct result.

## Summary

A new `PoolLogic` entry point, `withdrawCashImmediateWithPlan()`, lets a user redeem fUSD for a **specific, non-uniform mix of vault assets** instead of the strict pro-rata slice across *every* supported asset that `withdrawCashImmediate()` enforces today. The asset/amount composition is not chosen by the withdrawing user — it is computed off-chain and signed by a new protocol role, the **withdrawal attester**, based on real-time knowledge of which guards can currently service a withdrawal safely. The user submits the attester's signed plan together with their own transaction; the contract verifies the signature, executes the plan through the *existing* per-asset guard interface unchanged, and — critically — independently re-verifies that the total USD value released matches the user's redemption entitlement, regardless of which assets it came from.

This directly addresses a gap in the current design: today, if any single guard cannot service its pro-rata slice right now (an Aave V4 Spoke reserve without enough external liquidity to safely unwind, a Morpho Vault V2 position mid `forceDeallocate` cooldown, a Uniswap V3 position whose TWAP/spot deviation currently exceeds the withdrawal slippage bound), `withdrawCashImmediate()` either reverts outright for *every* user, or the manager must flip `isImmediateWithdrawEnabled = false` for the *entire pool*, forcing everyone onto the three-step queued-withdrawal flow until the one problem asset recovers. This feature gives a per-request escape valve: route around the specific asset that's currently constrained, without touching global withdrawal availability.

## Problem Statement

`PoolLogic._withdrawCashImmediateToSafe()` computes a single `portion = netFusd * 1e18 / totalFundValue()` and applies that *same* portion to every asset in `getSupportedAssets()` via `_withdrawProcessing(asset, to, portion, complexData)`. This is correct and fair when every asset is equally liquid, but it has one structural weakness: **it is all-or-nothing across the whole asset list.** If withdrawing a `portion` of any one asset would currently fail — most realistically a complex/flashloan-unwound position (Aave V3/V4, Morpho Blue, Morpho Vault V2) where the unwind can't clear its own slippage tolerance because on-chain liquidity for the settlement swap is temporarily thin — the *entire* `withdrawCashImmediate()` call reverts, even though the other N-1 assets are perfectly capable of paying the user out.

The only existing mitigation is `PoolLogic.setImmediateWithdrawEnabled(false)` (manager-only), which is a blunt, pool-wide switch: it blocks *every* user's immediate withdrawal, not just the ones that would touch the impaired asset, and routes everyone through `requestCashWithdraw → finalizeCashWithdraw → claimCashWithdraw`, which requires manual manager action per request. `docs/security.md`'s known-risk table already flags the underlying tension ("a single illiquid asset can still block fund-wide immediate withdrawals, mitigated by the queued withdrawal mode") — this design is the more surgical alternative to that mitigation.

## Goals

- Let a user redeem fUSD immediately, sourcing value from a *subset* of supported assets, when one or more guards are temporarily unable to service a uniform pro-rata slice.
- Preserve the existing value-conservation guarantee: a withdrawal can never release more USD value than the fUSD burned entitles the user to, **regardless of which off-chain party composed the asset mix**.
- Reuse the existing `IAssetGuard`/`IComplexAssetGuard`/`ISlippageCheckingGuard` interfaces as-is — no guard contract should need to change to support this feature. (The internal orchestration around them, `_withdrawProcessing()`, is relocated rather than left untouched — see [Bytecode Size Budget](#implementation-note-bytecode-size-budget) — but its behavior toward guards is unchanged.)
- Keep the blast radius of a compromised attester key bounded to "temporarily unfair asset selection," never to fund loss.

## Non-Goals

- This is **not** a general user-chosen-allocation withdrawal. The user does not pick which assets they receive; an accountable off-chain role does. See [Trust Model](#trust-model--why-the-attester-not-the-user-signs) for why.
- Not a replacement for `withdrawCashImmediate()` or the queued withdrawal flow — a third, complementary path.
- Not intended to support partial-fill / plan-splitting across multiple transactions in v1 (see [Open Questions](#open-questions)).

## Trust Model — why the attester, not the user, signs

The obvious naive design — let the withdrawing user pick their own asset/amount mix and self-sign it (mirroring `TokenLogic.depositWithAuthorization`'s EIP-712 pattern) — reintroduces a well-known DeFi vault failure mode: **adverse selection / cherry-picking**. If users freely choose their own redemption composition, every rational user withdraws the healthiest, most liquid, most likely-to-appreciate assets first and leaves the impaired or illiquid ones behind. In a shared pool, this transfers loss from whoever exits first onto whoever is left holding shares — the same dynamic behind real-world stablecoin/vault de-pegging incidents where "first out" strictly dominates "last out."

This design instead has a dedicated **withdrawal attester** role sign the plan. The attester is the party with visibility into which guards are *actually* constrained right now (Aave V4 Spoke reserve utilization, Morpho Vault V2 `forceDeallocate` penalty state, Uniswap V3 spot/TWAP deviation) — confirmed as **an automated backend service operated by the protocol**, not the manager's own key or a human-in-the-loop signer. Because the attester (not the user) decides the mix, a user cannot unilaterally dump the "bad" asset onto remaining stakers; the same operational surface that already computes off-chain risk data is the one deciding fair allocation here too.

**This changes the key-management threat model relative to every other signer/role in this codebase.** `manager`, `factoryOwner`, and the Timelock proposers are all expected to be cold, rarely-used, likely-multisig keys. The withdrawal attester, by contrast, is a **hot key held by an automated backend process**, signing continuously in response to user requests — a materially larger attack surface (server compromise, leaked key material, supply-chain compromise of the signing service) than any existing role in the protocol. The rest of this document treats that as the primary threat to design against, not an afterthought: see [Bounding a Compromised Attester Key](#bounding-a-compromised-attester-key) below.

**Critically, the attester's power is bounded on-chain.** The signature only determines *which* assets a withdrawal draws from and in what proportion — the contract independently measures total USD value released before vs. after execution (reusing the exact invariant already in `_withdrawCashImmediateToSafe()`) and reverts if it doesn't match the user's fUSD entitlement within a small tolerance, in **either** direction (see [Value Conservation](#value-conservation-the-core-safety-invariant)). A fully compromised attester key can misallocate *which* assets a user gets — reintroducing the cherry-picking problem for the duration of the compromise — but cannot cause the fund to pay out more value than any single withdrawal legitimately burns. Key compromise degrades this feature to "as unsafe as the naive user-signed design," not to "fund drain."

## High-Level Flow

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
                                        5. msg.sender == plan.user; verify
                                           signature via SignatureChecker
                                           against withdrawalAttester;
                                           deadline not expired; nonce
                                           unused — mark it consumed now,
                                           before anything below.
                                                │
                                                ▼
                                        6. Every allocations[i].asset is
                                           currently supported; no
                                           duplicates.
                                                │
                                                ▼
                                        7. Compute netFusd (cooldown +
                                           exit fee, same as
                                           withdrawCashImmediate). Check
                                           minValueOutBps <=
                                           MAX_MIN_VALUE_OUT_BPS and the
                                           decaying circuit-breaker cap
                                           against netFusd — fail fast
                                           here before burning anything.
                                                │
                                                ▼
                                        8. Burn netFusd fUSD.
                                                │
                                                ▼
                                        9. For each entry in allocations,
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
                                            within [netFusd * (1 -
                                            minValueOutBps), netFusd +
                                            DUST_TOLERANCE].
                                                │
                                                ▼
                                        11. Update accountedAssets, emit
                                            event, done.
```

## Data Structures

```solidity
/// @notice One asset's contribution to a selective withdrawal.
struct AssetAllocation {
    address asset;          // must currently be in PoolManagerLogic.getSupportedAssets()
    bool useFixedAmount;     // false = `portion` is a fraction of this asset's own guard-reported
                             //         balance (1e18 = 100%, same convention as IAssetGuard.withdrawProcessing)
                             // true  = `portion` is ignored; withdraw exactly `fixedAmount` raw units
                             //         of this asset (converted internally to an equivalent portion)
    uint256 portion;         // 1e18-scale, meaningful iff !useFixedAmount
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

`ComplexAsset[] complexAssetsData` (the existing struct from `IPoolLogic`, used today by `withdrawCashImmediateSafe`) remains a plain, **unsigned** call-time parameter, matched to `allocations` entries by asset address rather than by array index. The attester's signature commits to *which assets and how much*; the user retains today's existing control over their own swap-slippage tolerance for any complex/flashloan-unwound asset in the plan, exactly as they do today via `withdrawCashImmediateSafe`.

### EIP-712 Typed Data

```solidity
bytes32 private constant ASSET_ALLOCATION_TYPEHASH = keccak256(
    "AssetAllocation(address asset,bool useFixedAmount,uint256 portion,uint256 fixedAmount)"
);

bytes32 private constant WITHDRAWAL_PLAN_TYPEHASH = keccak256(
    "WithdrawalPlan(address user,uint256 fusdAmount,uint256 minValueOutBps,AssetAllocation[] allocations,uint256 nonce,uint256 deadline)AssetAllocation(address asset,bool useFixedAmount,uint256 portion,uint256 fixedAmount)"
);
```

Array-of-structs hashing follows the standard EIP-712 rule: hash each `AssetAllocation` individually against `ASSET_ALLOCATION_TYPEHASH`, then hash the concatenation of those hashes to produce the `allocations` field's contribution to the outer struct hash. `PoolLogic` needs an EIP-712 domain (it does not have one today); see [Upgrade & Storage](#upgrade--storage-migration). Because `EIP712Upgradeable`'s domain separator already binds `chainId` and `verifyingContract` (this specific `PoolLogic` proxy's address), no additional pool-identifying field is needed inside `WithdrawalPlan` itself to prevent cross-contract or cross-chain replay — this falls out of using the standard `_hashTypedDataV4` mechanism for free.

**Signature verification should not assume a raw EOA key.** The initial draft of this design called `ECDSA.recover(digest, attesterSignature) == withdrawalAttester` directly, implicitly requiring `withdrawalAttester` to be a single private key. Given the attester is a hot, automated backend signer (the highest-risk key in this whole feature — see [Trust Model](#trust-model--why-the-attester-not-the-user-signs)), this is worth not locking in prematurely. Use OpenZeppelin's `SignatureChecker.isValidSignatureNow(withdrawalAttester, digest, attesterSignature)` instead: it transparently supports both plain ECDSA signatures (if `withdrawalAttester` is an EOA) *and* ERC-1271 (`isValidSignature`) if `withdrawalAttester` is a contract. This costs nothing today (works identically to raw `ECDSA.recover` if the attester happens to be an EOA) but leaves the door open to later point `withdrawalAttester` at a small on-chain co-signing contract (e.g., requiring 2-of-2 backend replicas to agree, or a Safe) without touching `PoolLogic` again — a meaningful hardening path for exactly the key this document identifies as the weakest link.

## Function Signature

```solidity
function withdrawCashImmediateWithPlan(
    WithdrawalPlan calldata plan,
    bytes calldata attesterSignature,
    ComplexAsset[] calldata complexAssetsData
) external nonReentrant returns (address[] memory outAssets, uint256[] memory outAmounts);
```

### Step-by-step behavior

1. **Identity binding.** `require(msg.sender == plan.user)`. Deliberately **plain `msg.sender`, not `_actionSender()`** — see [Security Considerations](#security-considerations) for why this function must not route through the existing `allowedCallbackSenders` / `IUserActionSender.actionUser()` pattern as currently implemented.
2. **Signature verification.** Recompute the EIP-712 digest from `plan`; `require(SignatureChecker.isValidSignatureNow(withdrawalAttester, digest, attesterSignature))` (see [note above](#eip-712-typed-data) on why this is `SignatureChecker`, not raw `ECDSA.recover`).
3. **Freshness & replay.** `require(block.timestamp <= plan.deadline)`; `require(!consumedPlanNonce[plan.user][plan.nonce])`, then **mark it consumed immediately, before any external call or state mutation below.** Nonces are single-use per user — a plan is exactly one redemption, never partially spent across transactions (see [Open Questions](#open-questions) on partial fills). Consuming the nonce this early means a reentrant call replaying the same plan fails the nonce check on its own, independent of the `nonReentrant` modifier already on the outer function — two independent reasons the same plan can never execute twice.
4. **Asset membership & duplicate check.** For every `allocations[i].asset`, `require(IPoolManagerLogic(poolManagerLogic).isSupportedAsset(asset))` (defense-in-depth against a plan signed against an asset list that has since changed) and reject duplicate asset entries within the same plan.
5. **Fee & cooldown.** Identical to `withdrawCashImmediate()` today: cooldown check via `TokenLogic.getExitRemainingCooldown`, exit fee computed via `_applyWithdrawFeeFusd(plan.fusdAmount)`, fee transferred to the manager, `netFusd` computed.
6. **Circuit-breaker check, recorded against `netFusd`.** `require(plan.minValueOutBps <= MAX_MIN_VALUE_OUT_BPS)`, then check-and-record against the rolling attested-withdraw volume cap (see [Bounding a Compromised Attester Key](#bounding-a-compromised-attester-key)) **before** burning or touching any guard. `netFusd` is known deterministically at this point and doesn't depend on guard execution outcomes, so checking here fails fast (cheaper revert) rather than after paying the gas cost of the full withdrawal loop. This ordering has no correctness downside: if any later step in this function reverts for an unrelated reason, the entire transaction — including this check's state writes — unwinds atomically, so there's no scenario where volume gets "recorded" for a withdrawal that didn't actually happen.
7. **Burn.** `ITokenLogic(fusd).burnFrom(plan.user, netFusd)` — same ordering as today (burn before external guard calls).
8. **Per-asset withdrawal.** For each entry in `allocations`: if `useFixedAmount`, first `require(guard.getBalance(pool, asset) > 0)` (an explicit revert with a clear reason, rather than letting a zero balance fall through to an implicit division-by-zero panic) then compute `portion = min(fixedAmount * 1e18 / balance, 1e18)`; otherwise use `allocations[i].portion` directly. Look up the matching `ComplexAsset` from `complexAssetsData` by address (or treat as empty if none supplied for that asset), and process the withdrawal for that asset — see [Bytecode Size Budget](#implementation-note-bytecode-size-budget) for *where this logic actually lives*, which is more subtle than "just call the existing `_withdrawProcessing`."
9. **Value-conservation check.** Compare `_withdrawableFundValue()` before step 7 and after step 8 completes. Require both:
   - `valueBefore - valueAfter <= netFusd + DUST_TOLERANCE` (fixed, protocol-level upper bound — reused verbatim from `_withdrawCashImmediateToSafe`; **not** attester-adjustable, since over-delivery is a fund-drain risk regardless of real-time conditions)
   - `valueBefore - valueAfter >= netFusd - (netFusd * plan.minValueOutBps / 10_000)` **(attester-adjustable lower bound, itself capped by `MAX_MIN_VALUE_OUT_BPS` from step 6 — see [Value Conservation](#value-conservation-the-core-safety-invariant))**
10. **Accounting & events.** Decrement `accountedAssets` by the realized value delta (same as today), emit a plan-specific event mirroring `CashWithdrawImmediateProRata`.

## Value Conservation: the core safety invariant

`_withdrawCashImmediateToSafe()` today only bounds withdrawal value from *above* (`valueBefore - valueAfter > netFusd + 1e15` reverts), because in the uniform pro-rata path under-delivery isn't a realistic failure mode — every asset is always included at the same portion, so the sum reliably tracks `netFusd` up to rounding. That assumption **does not hold** for an attester-composed selective plan: it is entirely possible for a plan to under-deliver (e.g., the attester's picked assets don't actually have enough available balance at execution time, due to price drift or a race with another withdrawal). Silently allowing under-delivery would mean a user burns `netFusd` worth of fUSD but receives less USD value than that — a direct, silent loss to the user that the existing check would not catch.

This design therefore **tightens** the check to a two-sided bound for this function specifically: both an upper bound (no fund drain beyond entitlement, protects the fund) and a lower bound (no under-payment, protects the user). If either bound is violated, the whole transaction reverts — the user's fUSD is not burned, and they can retry with a corrected plan from the attester. This is the one place this design deliberately departs from reusing the existing invariant verbatim, and it should be called out explicitly during implementation: **the upper bound is inherited from existing, tested code; the lower bound is new and is the primary thing to scrutinize for off-by-one/rounding errors.**

The two sides of the bound are deliberately asymmetric in how they're parameterized:

- **Upper bound** (`netFusd + DUST_TOLERANCE`): fixed, protocol-level, not attester-adjustable. Allowing the attester any influence over how much the fund can *overpay* would reopen the fund-drain question this whole invariant exists to close — so this stays a hardcoded constant exactly like today's `1e15` in `_withdrawCashImmediateToSafe`.
- **Lower bound** (`netFusd - (netFusd * minValueOutBps / 10_000)`): attester-adjustable **within a hardcoded ceiling** (`MAX_MIN_VALUE_OUT_BPS`). The attester is the party who knows current market conditions when composing a plan — during calm conditions they can sign a tight `minValueOutBps` (close to 0, meaning "this must deliver almost exactly `netFusd` or revert"); during fast-moving conditions where balances/prices may drift meaningfully between signing and execution, they can widen it slightly to reduce spurious reverts. `MAX_MIN_VALUE_OUT_BPS` bounds how far that can go regardless of what any (possibly compromised) attester signs, so this flexibility can never be abused to let more than a small, protocol-chosen fraction of value leak away from a user.

Note that an **empty `allocations` array is automatically rejected** by this same lower bound with no special-case code: zero assets withdrawn means a realized value delta of `0`, which fails `0 >= netFusd - tolerance` for any `netFusd > 0`.

## Bounding a Compromised Attester Key

The value-conservation invariant above bounds what a *single* attested withdrawal can do: no plan, however maliciously composed, can release more USD value than that one withdrawal's own `netFusd` entitles. It does **not** bound how many times a compromised key can be used before someone notices. Because the attester is an always-on backend service rather than a rarely-touched multisig, the realistic worst case is not "one bad plan" but "many small, individually-legitimate-looking plans, signed continuously over hours or days, that collectively route a disproportionate share of the pool's healthy assets to whoever the attacker controls, systematically leaving the impaired/illiquid assets concentrated for remaining stakers." Two additional, independent controls target that scenario specifically:

**1. Rotation asymmetry (above):** instant revoke, delayed appoint. This shrinks the window between "key compromise begins" and "key compromise stops mattering" down to however fast the team can call `setAttestedWithdrawEnabled(false)` once alerted — no coordination or multisig round needed for the emergency stop itself.

**2. On-chain decaying volume cap (circuit breaker):** track cumulative USD value released via `withdrawCashImmediateWithPlan()`, independent of `withdrawCashImmediate()`'s ordinary volume. If a plan's execution would push the tracked total above `maxAttestedWithdrawVolumePerWindow`, the transaction reverts — the user falls back to ordinary `withdrawCashImmediate()` or the queued flow for that redemption instead. This does not require detecting the compromise at all; it simply caps the blood loss from an *undetected* one, the same way an exchange's per-address or per-day withdrawal limit does.

**A naive fixed-window implementation (reset the counter to zero every N hours) has a known flaw:** an attester can release up to the full cap just *before* a window boundary, then release another full cap's worth just *after* it — up to ~2× the intended cap in a short span straddling the reset, with no code-level malfunction, just a property of hard periodic resets. Rather than accept that gap, this design reuses the **exact decay-based accumulator already implemented and reasoned about in `SlippageAccumulator.sol`** (`accumulatedSlippage` linearly decaying to zero over `decayTime`, `lastTradeTimestamp` tracking the last update) — the same mathematical shape, applied to withdrawal volume instead of slippage impact:

```solidity
struct AttestedWithdrawVolume {
    uint64 lastWithdrawTimestamp;
    uint128 accumulatedValueUsd;
}

AttestedWithdrawVolume public attestedWithdrawVolume;
uint256 public attestedWithdrawDecayWindow; // e.g. 24h; floor enforced below
uint256 public maxAttestedWithdrawVolumePerWindow;

/// @dev Below this, the decay accumulator's memory becomes too short to meaningfully
///      aggregate across transactions — see the governance note below on why this needs
///      an enforced floor rather than being left to manager discretion.
uint256 public constant MIN_ATTESTED_WITHDRAW_DECAY_WINDOW = 1 hours;

function _currentDecayedAttestedVolume() internal view returns (uint256) {
    if (attestedWithdrawVolume.accumulatedValueUsd == 0) return 0;
    uint256 elapsed = block.timestamp - attestedWithdrawVolume.lastWithdrawTimestamp;
    uint256 window = attestedWithdrawDecayWindow;
    if (elapsed >= window) return 0;
    return (uint256(attestedWithdrawVolume.accumulatedValueUsd) * (window - elapsed)) / window;
}

function _checkAndRecordAttestedWithdrawVolume(uint256 valueUsd) internal {
    uint256 newTotal = _currentDecayedAttestedVolume() + valueUsd;
    require(
        newTotal <= maxAttestedWithdrawVolumePerWindow,
        "PoolLogic: attested withdraw volume cap exceeded"
    );
    attestedWithdrawVolume = AttestedWithdrawVolume({
        lastWithdrawTimestamp: uint64(block.timestamp),
        accumulatedValueUsd: uint128(newTotal)
    });
}
```

There is no reset boundary to straddle — the effective cap is always "at most `maxAttestedWithdrawVolumePerWindow` of value, decaying continuously," never briefly double-able. (Worth a follow-up refactor once implemented: since `SlippageAccumulator` and this feature now share the identical decay formula, consider factoring it into one shared internal library both use, rather than maintaining two copies of the same math.)

Sizing the cap and decay window is a manager-configurable operational parameter (start conservative — e.g., a small multiple of typical daily attested-withdrawal volume — and loosen as usage patterns are established), and it should itself be monitored: a cap that's repeatedly hit under normal conditions is a signal to raise it deliberately, not evidence it's unnecessary.

Together, these two controls mean a compromised backend key can, at worst, misallocate composition (never magnitude) for a capped, monitorable, rapidly-revocable volume of withdrawals — a materially smaller blast radius than "attacker has a valid signing key with no other constraints."

## New Roles & Storage

| Item | Location | Access control |
|---|---|---|
| `withdrawalAttester` (address) | `PoolLogic` (new state) | Active signer; only changed via the propose/activate delay below |
| `pendingWithdrawalAttester`, `pendingAttesterActivationTime` | `PoolLogic` (new state) | Set by `proposeWithdrawalAttester()`, `onlyManager` |
| `attesterRotationDelay` | `PoolLogic` (new state) | Settable by `onlyFactoryOwner` only, with a hardcoded on-chain minimum — **not** manager-settable; see rotation section below |
| `consumedPlanNonce` (`mapping(address => mapping(uint256 => bool))`) | `PoolLogic` (new state) | Written only internally by the new function |
| `isAttestedWithdrawEnabled` (bool) | `PoolLogic` (new state) | Instantly togglable via `setAttestedWithdrawEnabled(bool)`, `onlyManager`; **independent** of `isImmediateWithdrawEnabled` |
| `attestedWithdrawVolume` (`AttestedWithdrawVolume` struct) | `PoolLogic` (new state) | Written only internally; see [circuit breaker](#bounding-a-compromised-attester-key) |
| `maxAttestedWithdrawVolumePerWindow` | `PoolLogic` (new state) | Settable via `setMaxAttestedWithdrawVolumePerWindow(uint256)`, `onlyManager` (fail-closed if misconfigured — safe) |
| `attestedWithdrawDecayWindow` | `PoolLogic` (new state) | Settable via `setAttestedWithdrawDecayWindow(uint256)`, `onlyManager`, with a hardcoded on-chain minimum — see rotation section below for why a floor is required here specifically |

`isAttestedWithdrawEnabled` is deliberately a **separate** flag from `isImmediateWithdrawEnabled`, and this function should remain callable even when `isImmediateWithdrawEnabled == false`. The entire point of this feature is to provide relief precisely in the scenario the manager would otherwise handle by disabling immediate withdrawals pool-wide; coupling the two flags would defeat that purpose. The manager retains a genuine emergency stop (disable both) but is no longer forced to choose between "everyone blocked" and "no selective relief."

Attester **rotation** is intentionally asymmetric, mirroring the existing decrease-is-immediate / increase-is-delayed philosophy already used for fees (`setFeeNumerator` allows an immediate decrease; `announceFeeIncrease` → `commitFeeIncrease` requires a delay for an increase):

- `setAttestedWithdrawEnabled(false)` — **instant**, `onlyManager`. This is a pure capability *removal*; there is never a reason to delay it, and it must be available immediately if the backend key is suspected compromised. This is the incident-response kill switch.
- `proposeWithdrawalAttester(address candidate)` — `onlyManager`, records `pendingWithdrawalAttester` and `pendingAttesterActivationTime = block.timestamp + attesterRotationDelay`. (`uint256 public constant MIN_ATTESTER_ROTATION_DELAY = 24 hours;` — the floor referenced below.)
- `activateWithdrawalAttester()` — callable by anyone once `block.timestamp >= pendingAttesterActivationTime`; commits `withdrawalAttester = pendingWithdrawalAttester`.

**`attesterRotationDelay` itself must not be manager-settable.** The whole point of the delay is to create a detection window against a *manager* who is compromised, careless, or actively colluding — proposing a malicious attester and then also shortening (or zeroing) the delay would let that same actor route around the protection entirely, one `onlyManager` call away. This mirrors an existing, already-correct precedent in this codebase: `PoolManagerLogic._performanceFeeNumeratorChangeDelay` (the fee-increase delay) is set via `setFactoryConfig()`, which is `onlyFactoryOwner`, specifically *not* something the manager can shorten on their own fee changes. `attesterRotationDelay` should follow the identical split: `factoryOwner`-settable (via the existing factory-config surface, or a dedicated setter with the same access control), with a hardcoded protocol-level minimum (e.g. 24h) enforced on-chain regardless of what `factoryOwner` sets it to, exactly paralleling `MAX_MIN_VALUE_OUT_BPS`'s role for `minValueOutBps`.

The same reasoning extends to the circuit breaker's own parameters: `attestedWithdrawDecayWindow` must have an enforced **minimum** (e.g. `require(newWindow >= MIN_ATTESTED_WITHDRAW_DECAY_WINDOW)`, proposed floor: 1 hour) in its setter. Without this floor, setting the decay window to `0` doesn't cause a division error (the accumulator's early-return branch, `elapsed >= window`, is always true when `window == 0`, since elapsed is never negative) — it silently makes `_currentDecayedAttestedVolume()` always return `0`, which fully disables the circuit breaker's memory across transactions with a single, non-obviously-dangerous-looking parameter value. `maxAttestedWithdrawVolumePerWindow` doesn't need a similar floor — setting it to `0` only fails closed (blocks all attested withdrawals, same effect as disabling the feature), which is safe, just a usability footgun rather than a security one.

This means *replacing trust in a new key* is slow, observable, and outside the sole control of the actor being protected against (giving monitoring time to flag an unexpected rotation before it takes effect), while *withdrawing trust from a suspected-compromised key* is instant and requires no coordination. Emitting `WithdrawalAttesterProposed` / `WithdrawalAttesterActivated` / `AttestedWithdrawEnabledSet` is required for off-chain monitoring — an unexpected proposal event is the highest-value thing to alert on, since it's the one action that (after its delay elapses) can reintroduce cherry-picking risk without any further code change.

## Interaction with Existing Systems

- **Guards are untouched.** Every `IAssetGuard` / `IComplexAssetGuard` / `ISlippageCheckingGuard` implementation works as-is; this feature only relocates and reuses the *orchestration* around them (see [Bytecode Size Budget](#implementation-note-bytecode-size-budget) for exactly how `_withdrawProcessing`'s equivalent logic moves into a shared library used by both the existing pro-rata path and this new one).
- **`reservedAssetBalance` (queued-withdrawal reservations)** is respected automatically, for the same reason: the per-asset withdrawal logic already subtracts reserved balance before computing a withdrawable amount regardless of which entrypoint calls it, and this function doesn't bypass that path.
- **Cooldown** (`TokenLogic.getExitRemainingCooldown`) is enforced identically to `withdrawCashImmediate()`. This feature changes *which assets* a withdrawal draws from, not *whether* a withdrawal is allowed to happen at all.
- **`accountedAssets`** bookkeeping is unchanged in mechanism — same before/after fund-value delta subtraction — just gated by the new two-sided bound instead of the one-sided bound.

## Security Considerations

- **Do not wire this function through `_actionSender()` / `IUserActionSender.actionUser()`.** The current `feature/06-aave-v4` branch introduced `_actionSender()`, which trusts any address on `PoolManagerLogic.allowedCallbackSenders` (manager-controlled, `onlyManager`, no validation of what's added) to declare an arbitrary "acting user" for `stake`/`unstake`/`withdrawCashImmediate`/`deposit` — a manager-whitelisted helper contract can currently force those actions against any address with a standing token allowance, without that user's consent for the specific transaction (flagged previously on this branch). Routing this new function through the same mechanism would let a manager similarly force an attested withdrawal against a victim's balance. Until that identity-resolution issue is remediated with a real consent-binding mechanism, `withdrawCashImmediateWithPlan()` should key off plain `msg.sender` only.
- **Attester key compromise** degrades this feature to the cherry-picking risk profile of a naive user-self-signed design (attacker can now pick any asset mix for any user's withdrawal) but — because of the two-sided value-conservation check — **cannot** extract more value than the specific withdrawal's own `netFusd` entitles, for any single plan. It also cannot mint new plans for users who never call the function; it can only shape the composition of a withdrawal the user themselves initiates. The rolling-window volume cap and instant-revoke switch (see [Bounding a Compromised Attester Key](#bounding-a-compromised-attester-key)) additionally cap cumulative damage from a compromise that goes undetected for a period of time, which is the realistic failure mode for an automated backend signer rather than a one-shot leak.
- **Stale/replayed plans** are prevented by the deadline + single-use nonce; a short attester-chosen deadline (minutes, not hours) additionally limits staleness against balance/price drift between signing and execution.
- **Asset-list drift between signing and execution** (an asset in the plan gets removed from `supportedAssets` after signing but before the transaction lands) is caught by the on-chain `isSupportedAsset` re-check at execution time — the plan is not blindly trusted to reflect current pool configuration.
- **Duplicate allocation entries** for the same asset must be rejected explicitly; otherwise a plan could double-invoke `_withdrawProcessing()` against the same balance in one transaction (each call reduces the on-chain balance so a second call wouldn't double-withdraw in practice, but it wastes gas and complicates the value-conservation accounting for no legitimate use case — reject rather than silently tolerate).
- **Front-running / MEV on plan submission** is not a meaningful new concern: the plan already commits to specific amounts/portions and a value-conservation bound: seeing a pending plan in the mempool gives an observer no exploitable edge, since the transaction either executes within its committed bounds or reverts.
- **Gas griefing via a maximal `allocations` array** is bounded the same way `withdrawCashImmediateSafe`'s `complexAssetsData` already is today — by the size of `getSupportedAssets()`, which is itself capped by `PoolManagerLogic._maximumSupportedAssetCount` (default 50).
- **Dust-tolerance farming is not economically viable.** The fixed upper-bound `DUST_TOLERANCE` permits at most a tiny, fixed USD overpayment per call. Extracting anything meaningful this way would require an enormous number of separate transactions, each paying real gas — the gas cost dominates the extractable dust by orders of magnitude at any realistic gas price, so this isn't a practical griefing/extraction vector and doesn't need a mitigation beyond keeping the tolerance small (matching the existing `1e15` precedent).
- **The circuit breaker is pool-wide, not per-user, by design.** A per-user cap would not address the actual threat it targets: a single compromised backend key signing plans for *many different users'* own, individually-legitimate withdrawals, each one within that user's own entitlement, but collectively still systematically cherry-picking the healthy assets out of the pool. Only a pool-wide aggregate cap bounds that. The trade-off is accepted explicitly: a single large legitimate withdrawal (or a burst of them) can temporarily exhaust the window for everyone else, who then fall back to `withdrawCashImmediate()` or the queued flow rather than being blocked outright — and the manager can raise `maxAttestedWithdrawVolumePerWindow` if legitimate demand routinely collides with it.

## Implementation Note: Bytecode Size Budget

`PoolLogic`'s deployed bytecode is currently **24,485 of 24,576 bytes** (the EIP-170 contract-size limit) — **91 bytes of headroom** — measured with the per-file `optimizer.runs: 1` override already present in `hardhat.config.ts:111-116` (i.e., the standard gas-for-size trade-off is *already* spent; there is no compiler-flag lever left to pull). Every function this design adds (a new external entrypoint, a new struct, EIP-712 hashing, the circuit breaker, the rotation logic) needs to fit in that 91 bytes — which it obviously won't. This needs a genuine architectural fix, not a config tweak, before implementation starts.

**The fix: extract to an externally-linked library, following an already-proven pattern in this codebase.** `PoolTxExecutor.sol` and `FundCalculationLibrary.fusdToAssetAmount` are both Solidity libraries with `external` (not `internal`) functions. The compiler deploys these as their own separate contracts and has `PoolLogic` reach them via `delegatecall` at the linked address — their bytecode does **not** count against `PoolLogic`'s own 24KB limit; `PoolLogic` only pays for a small dispatch stub per call. Put essentially all of the new logic (EIP-712 verification via `SignatureChecker`, allocation validation, fixed-amount/portion conversion, the two-sided value-conservation math, the decaying circuit-breaker math) into a new library, `WithdrawalPlanLib.sol`, following this exact precedent.

**Important constraint on how this is wired up:** it's tempting to describe the new per-asset loop as simply calling the existing `_withdrawProcessing()` unchanged, but that's not achievable — `_withdrawProcessing` is `internal` to `PoolLogic`, and internal functions are not part of a contract's ABI; they compile to plain jump instructions inside `PoolLogic`'s *own* bytecode. A `delegatecall` from `PoolLogic` into a separately-deployed library runs the *library's* bytecode (with `PoolLogic`'s storage/`msg.sender`/`address(this)` context) — it cannot jump into a function that only exists in `PoolLogic`'s own, separately-compiled bytecode. So `WithdrawalPlanLib` cannot literally call `_withdrawProcessing`; it needs its own implementation of the equivalent guard-dispatch logic (guard lookup via `IPoolManagerLogic.getAssetGuard`, balance query, `reservedAssetBalance` subtraction via the existing public `IPoolLogic.reservedAssetBalance` getter, complex-vs-regular dispatch, low-level execution of the guard-returned `MultiTransaction[]`, per-operation slippage check) — reachable only via the same public/external interfaces any other external contract would use, exactly how `PoolTxExecutor` already operates today without reaching into `PoolLogic` internals.

Given that, the better move is not to duplicate `_withdrawProcessing`'s logic into the new library, but to **extract `_withdrawProcessing` itself out of `PoolLogic` and into the (shared) library**, and have *both* the existing pro-rata loop in `_withdrawCashImmediateToSafe()` and the new selective-plan loop call the one library implementation. This does double duty: it recovers existing bytecode (not just enough headroom for the new feature, but more, since `_withdrawProcessing` is a non-trivial chunk of today's 24,485 bytes) and avoids the alternative of shipping two near-identical implementations of the same per-asset withdrawal logic that could silently drift apart under future maintenance.

**Delegatecall-into-a-library carries one well-known, high-severity hazard that must be designed against explicitly: the library must never declare its own storage variables.** A library used via `delegatecall` executes with the *caller's* storage — if the library itself declares state variables, they occupy the caller's storage slots by position, and a mismatch between what the library "thinks" is at a given slot and what `PoolLogic` actually has there causes silent, arbitrary storage corruption. This is precisely the bug class behind the 2017 Parity multisig library freeze (~$150M+ locked), which resulted from exactly this pattern: a delegatecall-based library that itself held mutable state. `WithdrawalPlanLib` (and any function newly extracted into it, including `_withdrawProcessing`) must be written so every function takes all needed values as explicit parameters and returns explicit outputs — `PoolLogic` performs every `SSTORE` itself, in its own code, after the library call returns. None of the new storage this feature needs (`withdrawalAttester`, `consumedPlanNonce`, `isAttestedWithdrawEnabled`, the circuit-breaker struct, the pending-attester rotation state) should ever be read or written from inside the library directly — only ever passed in and handed back.

**Reentrancy is unaffected by this restructuring.** `nonReentrant` guards the outer `withdrawCashImmediateWithPlan()` entrypoint in `PoolLogic`'s own storage; a `delegatecall` into the library executes within the *same* call frame and the *same* storage context as that outer call — it is not a new external call boundary the reentrancy guard needs to separately account for, the same way today's `PoolTxExecutor.exec()` delegatecall doesn't create a reentrancy gap around `execTransaction()`.

Beyond the library extraction (the primary, necessary fix), if headroom is still tight after moving `_withdrawProcessing` and the new logic out:

- Convert any remaining `require(cond, "string")` reverts in `PoolLogic` to custom `error` types where not already done — each unique revert string costs bytecode for the literal plus its ABI-encoding path, and `PoolLogic` already uses custom errors extensively elsewhere, so finishing that conversion is low-risk, mechanical, and consistent with existing style.
- Experiment with `viaIR: true` alongside the existing `runs: 1` override for `PoolLogic` specifically — IR-based codegen sometimes produces smaller output due to better inlining/dead-code decisions, at the cost of longer compile times; measure before/after, since it isn't guaranteed to help and can occasionally regress.
- Confirm `metadata.bytecodeHash` isn't unnecessarily inflating the deployed size (a small, ~53-byte fixed cost, but free to check).

## Upgrade & Storage Migration

Following the pattern already established for `initializeAutoCompounding()` (`reinitializer(2)`):

```solidity
/// @custom:oz-upgrades-validate-as-initializer
function initializeAttestedWithdrawal(
    address attester_,
    uint256 attesterRotationDelay_,
    uint256 attestedWithdrawDecayWindow_,
    uint256 maxAttestedWithdrawVolumePerWindow_
) external onlyOwner reinitializer(3) {
    require(attester_ != address(0), "PoolLogic: attester=0");
    require(attesterRotationDelay_ >= MIN_ATTESTER_ROTATION_DELAY, "PoolLogic: rotation delay too short");
    require(attestedWithdrawDecayWindow_ >= MIN_ATTESTED_WITHDRAW_DECAY_WINDOW, "PoolLogic: decay window too short");

    withdrawalAttester = attester_;
    attesterRotationDelay = attesterRotationDelay_;
    attestedWithdrawDecayWindow = attestedWithdrawDecayWindow_;
    maxAttestedWithdrawVolumePerWindow = maxAttestedWithdrawVolumePerWindow_;
    isAttestedWithdrawEnabled = true;
    __EIP712_init("Frgmnt PoolLogic", "1");
}
```

Both minimums (`MIN_ATTESTER_ROTATION_DELAY`, `MIN_ATTESTED_WITHDRAW_DECAY_WINDOW`) are enforced here too, not just in the standalone setters, so the feature can never launch in an already-defeated state.

`PoolLogic` does not currently inherit `EIP712Upgradeable` or reserve a storage `__gap` (confirm intended append point with the team before implementation, since unlike `TokenLogic`/`PoolManagerLogic`, `PoolLogic` has no explicit gap today). New state (`withdrawalAttester`, `pendingWithdrawalAttester`, `pendingAttesterActivationTime`, `attesterRotationDelay`, `consumedPlanNonce`, `isAttestedWithdrawEnabled`, `attestedWithdrawVolume`, `maxAttestedWithdrawVolumePerWindow`, `attestedWithdrawDecayWindow`, plus whatever `EIP712Upgradeable` itself reserves) must be appended after all existing storage variables, never inserted between them. Extracting `_withdrawProcessing` into the shared library (see [Bytecode Size Budget](#implementation-note-bytecode-size-budget)) is pure code motion and declares no new storage of its own — it does not affect this migration's storage-layout accounting. This migration should ship in the same governance/Timelock upgrade batch as the implementation swap, mirroring the checklist format in `docs/upgradeable-contracts-notes.md`.

## Testing Plan

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

## Design Refinements

This design was stress-tested before implementation planning, specifically because it introduces the hottest, most-automated signing key of any role in the protocol and a new delegatecall-based architecture needed just to fit within `PoolLogic`'s remaining bytecode budget — both are exactly the kind of change that deserves more scrutiny than a first pass gets. Points are listed most-severe first; every one is resolved in the sections above, not just noted here.

| # | Finding | Severity | Resolution |
|---|---|---|---|
| 1 | A delegatecall-based library that declares its own storage variables corrupts the caller's storage at whatever slot positions those variables occupy — the exact bug class behind the 2017 Parity multisig library freeze. The first draft didn't call this out explicitly for `WithdrawalPlanLib`. | High | Explicit mandate added: the library must never declare storage; every function takes state as parameters and returns it, `PoolLogic` performs every `SSTORE` itself. See [Bytecode Size Budget](#implementation-note-bytecode-size-budget). |
| 2 | The first draft said the new selective-withdrawal loop would "call the existing, unmodified `_withdrawProcessing()`" from the new library. This isn't achievable: `_withdrawProcessing` is `internal`, and internal functions compile to jumps inside `PoolLogic`'s own bytecode, unreachable via `delegatecall` into a separately-deployed library. Left uncorrected, this would have blocked implementation or led to an ad hoc, undocumented duplication of the withdrawal logic. | High (feasibility/correctness) | Corrected the plan: extract `_withdrawProcessing` itself into the shared library, used by both the existing pro-rata path and the new selective path — recovers more bytecode than the minimum needed and avoids duplicated logic drifting apart over time. |
| 3 | Signature verification assumed a single raw EOA key (`ECDSA.recover(...) == withdrawalAttester`) for the highest-risk, most-automated signer in the system, with no path to strengthen it later without a further contract change. | Medium | Switched to `SignatureChecker.isValidSignatureNow`, supporting both EOA and ERC-1271 (contract) signers transparently — leaves room to later point `withdrawalAttester` at a co-signing contract without touching `PoolLogic` again. |
| 4 | The circuit breaker's original fixed-window design (hard reset to zero every N hours) allows up to ~2× the intended cap to be released in a short span straddling the reset boundary — a known property of periodic-reset rate limiters, not a coding bug, but still a real gap against the stated threat. | Medium | Replaced with a continuously-decaying accumulator, reusing the exact math already implemented and reasoned about in `SlippageAccumulator.sol`. No reset boundary exists to straddle. |
| 5 | The attester rotation delay and the circuit breaker's decay window were both originally bare `onlyManager` parameters with no floor. A compromised, careless, or actively colluding manager could shorten the rotation delay to near-zero (defeating the detection window before swapping in a malicious attester) or zero the decay window (silently disabling the circuit breaker's cross-transaction memory) — undermining protections whose entire purpose is to contain a *separately*-compromised key. | Medium–High (governance bypass) | Rotation delay moved to `factoryOwner`-only control (mirroring the existing `_performanceFeeNumeratorChangeDelay` pattern) with a hardcoded minimum (`MIN_ATTESTER_ROTATION_DELAY`, proposed 24h); decay window keeps `onlyManager` control but gains a hardcoded minimum (`MIN_ATTESTED_WITHDRAW_DECAY_WINDOW`, proposed 1h) enforced both in its setter and in the migration initializer. |
| 6 | `minValueOutBps` existed in the signed struct but was never wired into an actual on-chain check in the first draft — decorative, costing signature/calldata size for no enforcement benefit. | Low–Medium | Wired in as the actual, protocol-capped lower bound of the two-sided value-conservation check (`MAX_MIN_VALUE_OUT_BPS` ceiling prevents a compromised attester from widening it enough to leak meaningful value). |
| 7 | Fixed-amount mode's portion conversion (`fixedAmount * 1e18 / balance`) would hit an implicit division-by-zero panic if the target asset's guard-reported balance is currently zero, rather than a clear, intentional revert reason. | Low | Explicit `require(balance > 0)` added before the division, with a clear revert reason. |
| 8 | The circuit-breaker check was originally positioned after the withdrawal loop executed, wasting gas on a doomed transaction whenever the cap would be exceeded, and recording an ambiguous "realized" value rather than a value known upfront. | Low (gas/clarity, not correctness — an atomic revert unwinds either way) | Moved earlier, checked and recorded against the deterministic `netFusd` right after fee/cooldown computation, before burning or touching any guard — fails fast, and is intentionally conservative relative to the eventual realized delta. |

**Considered and confirmed not to need a fix** (worth recording so they aren't re-litigated later):

- A `delegatecall` into the library executes in the same call frame and storage context as the `nonReentrant`-guarded outer call — it introduces no new reentrancy boundary, the same way `PoolTxExecutor.exec()`'s existing delegatecall doesn't around `execTransaction()`.
- `EIP712Upgradeable`'s domain separator already binds `chainId` and `verifyingContract`; no extra pool-identifying field is needed inside `WithdrawalPlan` to prevent cross-contract/cross-chain replay.
- An empty `allocations` array is rejected automatically by the lower value-conservation bound (a zero delta fails against any `netFusd > 0`) — no special-case code needed.
- The fixed dust-level upper-bound tolerance is not economically farmable across many transactions; gas cost dominates the extractable amount by orders of magnitude.
- The circuit breaker being pool-wide rather than per-user is an intentional trade-off, not an oversight — a per-user cap wouldn't address the actual threat (one compromised key acting across many different users' own, individually-legitimate withdrawals).

## Open Questions

1. **Partial fills.** Should a single signed plan be spendable across multiple transactions (e.g., attester signs "up to X", user draws down incrementally)? v1 assumes single-use, exact-match `fusdAmount` for simplicity; revisit if attester-service latency/cost makes per-request signing too expensive at scale.
2. **Circuit-breaker window sizing.** `attestedWithdrawDecayWindow` and `maxAttestedWithdrawVolumePerWindow` (above their respective floors) need real usage data to calibrate — too tight and the feature becomes unusable during genuine high-demand periods; too loose and it stops meaningfully bounding a compromise. Propose launching conservative and adjusting via telemetry rather than guessing a permanent value upfront.
3. **Multiple attesters / threshold signing.** Out of scope for v1 (single attester address), but the two-sided value bound plus the circuit breaker mean the security cost of a single-key model is already fairly contained; a multi-sig or threshold-signed attester would primarily improve availability and reduce single-server compromise risk further, not fix a fund-safety gap that would otherwise exist.
