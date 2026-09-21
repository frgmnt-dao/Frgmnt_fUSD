// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IPoolLogic } from "../interfaces/IPoolLogic.sol";
import { IPoolManagerLogic } from "../interfaces/IPoolManagerLogic.sol";
import { IManaged } from "../interfaces/IManaged.sol";
import { IHasSupportedAsset } from "../interfaces/IHasSupportedAsset.sol";
import { IAssetGuard } from "../interfaces/guards/IAssetGuard.sol";
import { IComplexAssetGuard } from "../interfaces/guards/IComplexAssetGuard.sol";
import { ISubPositionGuard } from "../interfaces/guards/ISubPositionGuard.sol";
import { FundCalculationLibrary } from "./FundCalculationLibrary.sol";

/// @dev Minimal, library-local mirror of PoolLogic.sol's file-scope ITokenLogic interface —
///      duplicated (not imported) to avoid a circular import (PoolLogic.sol already imports this
///      library). Only the two functions this library actually calls.
interface ITokenLogicMinimal {
    function burnFrom(address account, uint256 amount) external;
    function getExitRemainingCooldown(address user) external view returns (uint256);
}

/// @title Frgmnt — WithdrawalPlanLib
/// @notice Externally-linked library (delegatecall-only, same pattern as PoolTxExecutor.sol and
///         FundCalculationLibrary.sol) holding PoolLogic's per-asset withdrawal-processing logic.
/// @dev Extracted out of PoolLogic solely to recover EIP-170 bytecode headroom — PoolLogic sits
///      at ~129 bytes of remaining deployed-bytecode budget, with no room for any new feature
///      until this moves out. See docs/attested-selective-withdrawal-design.md's "Implementation
///      Note: Bytecode Size Budget" section for the full reasoning.
/// @dev CRITICAL: this library must NEVER declare its own storage variables. It runs via
///      delegatecall inside PoolLogic's storage context (address(this)/msg.sender inside a
///      function body here already correctly resolve to PoolLogic's, exactly like
///      PoolTxExecutor.exec() today) — a library-declared state variable would occupy PoolLogic's
///      storage by slot position and silently corrupt whatever PoolLogic actually has there. This
///      is the exact bug class behind the 2017 Parity multisig library freeze. Every function here
///      takes all needed state as explicit parameters and returns explicit outputs; PoolLogic
///      performs every SSTORE itself, in its own code, after a call into this library returns.
library WithdrawalPlanLib {
    using SafeERC20 for IERC20;

    /// @dev Byte-for-byte identical signatures to PoolLogic's own CashWithdrawImmediateProRata/
    ///      AttestedWithdrawPlanExecuted events — declared separately here (rather than imported)
    ///      purely to avoid a circular import, same reasoning as this library's duplicated
    ///      CooldownActive/ZeroAmount errors above. Emitted directly from executeWithdrawalPlan()
    ///      rather than returned for PoolLogic to emit: a delegatecall preserves the caller's
    ///      address for the EVM's ADDRESS opcode, so a LOG emitted here is indistinguishable
    ///      on-chain from one PoolLogic emitted itself — same topic0, same log address — and this
    ///      moves the (non-trivial, dynamic-array-containing) event-encoding bytecode out of
    ///      PoolLogic, which has essentially no remaining EIP-170 headroom. If this function
    ///      reverts anywhere after emitting, the EVM discards these logs along with every other
    ///      state change from the same transaction, exactly like any other revert — emitting
    ///      before PoolLogic's own later accountedAssets check is not a correctness concern.
    event CashWithdrawImmediateProRata(
        address indexed user,
        uint256 fusdTotal,
        uint256 fusdNet,
        uint256 fusdFee,
        address[] assets,
        uint256[] amounts
    );
    event AttestedWithdrawPlanExecuted(
        address indexed user,
        uint256 indexed nonce,
        uint256 surchargeAmount
    );
    /// @dev Same selector as PoolLogic.CooldownActive()/ZeroAmount() (identical, param-less
    ///      error signatures always hash identically regardless of declaring scope) — declared
    ///      separately here purely so this library doesn't need to import PoolLogic.sol's own
    ///      contract-scoped errors (which would require a circular import).
    error CooldownActive();
    error ZeroAmount();

    /// @dev Fixed, protocol-level upper-bound tolerance on over-delivery — reused verbatim from
    ///      PoolLogic._withdrawCashImmediateToSafe's existing `1e15` constant (not duplicated by
    ///      reference, since that one stays inline there; kept as the same value here so both
    ///      withdrawal paths tolerate identical dust).
    uint256 private constant DUST_TOLERANCE = 1e15;

    /// @dev Smallest net fUSD (after the exit fee) an attested plan may redeem: $0.01. The dust
    ///      tolerance above is absolute (up to DUST_TOLERANCE of extra value per transaction), and
    ///      the volume breaker meters netFusd. Without a floor a plan could burn a few wei of fUSD,
    ///      release up to DUST_TOLERANCE of real value, and register almost nothing in the breaker,
    ///      so the extraction would be effectively unmetered. With the floor every transaction
    ///      registers at least $0.01 of volume, so the total extractable through the tolerance is
    ///      bounded by (DUST_TOLERANCE / MIN_PLAN_NET_FUSD) = 10% of the metered volume, which the
    ///      cap limits. It does NOT make the trade unprofitable per transaction (at most about
    ///      $0.001 gained on a $0.01 burn); the protection is that each transaction needs an
    ///      attester signature and gas. Smaller redemptions remain possible through the pro-rata
    ///      path.
    uint256 private constant MIN_PLAN_NET_FUSD = 1e16;

    /// @dev Must stay numerically identical to PoolLogic.MAX_MIN_VALUE_OUT_BPS — duplicated here
    ///      (rather than cross-contract-referenced) because a library cannot read a constant
    ///      declared on a specific contract it doesn't inherit.
    uint256 private constant MAX_MIN_VALUE_OUT_BPS = 100; // 1%

    /// @dev Effective ceiling on attestedWithdrawDecayWindow; see _checkAndRecordVolume.
    uint256 private constant MAX_DECAY_WINDOW = 30 days;

    /// @dev Longest lifetime a signed plan may have (plan.deadline - block.timestamp).
    uint256 private constant MAX_PLAN_TTL = 7 days;

    /// @dev Protocol-level ceiling on the pool-usage surcharge (see the "Surcharge" section of
    ///      docs/attested-selective-withdrawal-design.md), independent of whatever
    ///      PoolLogic.maxSurchargeBps is currently governed to. Deliberately enforced here, at
    ///      the point of use, rather than validated in PoolLogic's setter — this keeps
    ///      PoolLogic.setMaxSurchargeBps() to the cheapest possible shape (access control + write
    ///      + event, no bound-check branch) against its already-tight EIP-170 budget, while still
    ///      guaranteeing the real applied surcharge can never exceed this constant regardless of
    ///      what's ever written to storage, including by a compromised or careless factoryOwner.
    uint256 private constant MAX_SURCHARGE_BPS_CEILING = 100; // 1%

    /// @dev Upper bound on positionIds per allocation. Each id costs a few storage reads inside the
    ///      guard (and an O(n^2) membership scan), so an unbounded array from a signed plan would
    ///      only ever be a gas hazard; real pools track far fewer positions per guard.
    uint256 private constant MAX_POSITION_IDS_PER_ALLOCATION = 32;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
    bytes32 private constant DOMAIN_NAME_HASH = keccak256(bytes("Frgmnt PoolLogic"));
    bytes32 private constant DOMAIN_VERSION_HASH = keccak256(bytes("1"));

    bytes32 private constant ASSET_ALLOCATION_TYPEHASH =
        keccak256(
            "AssetAllocation(address asset,address guard,bytes32[] positionIds,bool useFixedAmount,uint256 portion,uint256 fixedAmount)"
        );

    bytes32 private constant WITHDRAWAL_PLAN_TYPEHASH =
        keccak256(
            "WithdrawalPlan(address user,uint256 fusdAmount,uint256 minValueOutBps,AssetAllocation[] allocations,uint256 nonce,uint256 deadline,uint256 maxAcceptableSurchargeBps)AssetAllocation(address asset,address guard,bytes32[] positionIds,bool useFixedAmount,uint256 portion,uint256 fixedAmount)"
        );

    /// @dev Decayed-accumulator state for the attested-withdraw circuit breaker — field layout
    ///      matches PoolLogic.AttestedWithdrawVolume exactly so the struct can be passed through
    ///      by value with a plain field-for-field copy at the call site.
    struct VolumeState {
        uint64 lastWithdrawTimestamp;
        uint128 accumulatedValueUsd;
    }

    /// @dev Compact, flattened bundle of executeWithdrawalPlan's outputs — struct return (a
    ///      single memory pointer) rather than many separate return values, to keep the caller's
    ///      stack usage low. Deliberately almost everything PoolLogic needs to know: with
    ///      PoolLogic's own bytecode budget this tight, fee computation, the burn, and every
    ///      per-asset transfer all happen inside this library too (see executeWithdrawalPlan's
    ///      own docs) — PoolLogic performs only the three storage writes this struct feeds.
    struct PlanExecutionResult {
        address[] outAssets;
        uint256[] outAmounts;
        uint256 netFusd;
        uint256 feeFusd;
        uint256 valueDelta;
        uint256 totalClaims;
        uint256 completeFundValue;
        uint64 newVolumeTimestamp;
        uint128 newVolumeAccumulated;
        // fairFusd - target (see executeWithdrawalPlan): the deliberately-undelivered slice of
        // this withdrawal's entitlement, retained inside the fund. Deterministic from
        // target/fairFusd, not measured from the realized valueDelta. Informational only (it is
        // emitted in AttestedWithdrawPlanExecuted): accounting needs no adjustment for it, since
        // valueDelta already reflects the smaller outflow.
        uint256 surchargeAmount;
    }

    /// @dev Bundled input to executeWithdrawalPlan — avoids stack-too-deep across what would
    ///      otherwise be 9+ separate locals. Built inside this library by _loadPlanInput() from
    ///      the pool's public getters (PoolLogic no longer builds or passes it).
    struct ExecutePlanInput {
        address fusd;
        address poolManagerLogic;
        address manager;
        address withdrawalAttester;
        bool nonceAlreadyConsumed;
        uint256 attestedWithdrawDecayWindow;
        uint256 maxAttestedWithdrawVolumePerWindow;
        uint64 currentVolumeTimestamp;
        uint128 currentVolumeAccumulated;
        // Governed value from PoolLogic.maxSurchargeBps — unvalidated at the PoolLogic setter
        // (see MAX_SURCHARGE_BPS_CEILING's own docs), clamped here at the point of use instead.
        uint256 maxSurchargeBps;
    }

    struct WithdrawProcessingLocalVars {
        address guard;
        uint256 balance;
        uint256 portionBalance;
        uint256 expectedValue;
        IAssetGuard.MultiTransaction[] transactions;
        bool regularProcessing;
        uint256 actualValue;
    }

    /// @notice Processes one asset's share of a withdrawal through its registered guard.
    /// @dev Moved verbatim (behavior-for-behavior) from PoolLogic._withdrawProcessing() — see
    ///      that function's git history for the CertiK FNA-07/FNA-36 reasoning behind the
    ///      net-realizable-vs-withdrawable-balance split below, unchanged by this move.
    /// @param poolManagerLogic PoolLogic.poolManagerLogic() — passed in explicitly since a
    ///        delegatecall-invoked library cannot declare its own storage to cache it in.
    /// @param reserved PoolLogic.reservedAssetBalance(asset) — mappings cannot cross a function
    ///        boundary, so the caller reads this one value before calling in.
    /// @dev public (not external): executeWithdrawalPlan() below also calls this by bare name
    ///      from within the same library — an external function cannot be invoked internally by
    ///      name (only via `this.foo()`, which would incorrectly rebind `this` under
    ///      delegatecall), so this must be public. Matches the identical, already-established
    ///      convention in FundCalculationLibrary.guardNetRealizableBalance/guardWithdrawableBalance.
    function withdrawProcessing(
        address poolManagerLogic,
        address asset,
        address to,
        uint256 portion,
        uint256 reserved,
        IPoolLogic.ComplexAsset memory complexData
    ) public returns (address withdrawAsset, uint256 withdrawAmount, bool externalProcessed) {
        WithdrawProcessingLocalVars memory v;

        v.guard = IPoolManagerLogic(poolManagerLogic).getAssetGuard(asset);
        if (v.guard == address(0)) revert IPoolLogic.InvalidGuard();

        // FNA-36: sized against net-realizable value (see IUnwindCostAwareGuard/FNA-35), not raw
        // getBalance(), so a leveraged position whose gross equity looks positive but whose real
        // proceeds are fully consumed by unwind costs is skipped below the same way a genuinely
        // zero-equity one already is.
        v.balance = FundCalculationLibrary.guardNetRealizableBalance(address(this), asset, v.guard);
        if (reserved > 0) {
            if (v.balance < reserved) revert IPoolLogic.InvalidReservedBalance();
            v.balance -= reserved;
        }

        v.portionBalance = (v.balance * portion) / 1e18;
        // FNA-36: this asset's own share of the withdrawal NAV is already zero — calling the
        // guard's own withdrawProcessing() here would, for a leveraged position, still plan and
        // attempt a real unwind (e.g. an Aave flashloan) purely because debt exists, with nothing
        // to actually deliver; if that unwind fails, it reverts the *entire* pro-rata withdrawal,
        // including every other, healthy asset's share. Skipping here is equivalent to the guard
        // itself reporting a zero-value, zero-transaction withdrawal for this asset.
        if (v.portionBalance == 0) {
            return (address(0), 0, false);
        }
        // CertiK FNA-07 (09/03 follow-up): the slippage baseline must reflect what the guard can
        // actually deliver, not the uncapped net-realizable v.portionBalance above — a guard
        // implementing IWithdrawableBalanceGuard (e.g. Aave V4 Tokenization, Morpho Vault V2)
        // clamps its own withdrawProcessing() output to real external liquidity, so comparing the
        // clamped delivery against an unclamped expectation produced a false-positive
        // SlippageExceeded() whenever the cap actually bound.
        uint256 cappedBalance = FundCalculationLibrary.guardWithdrawableBalance(
            address(this),
            asset,
            v.guard
        );
        if (reserved > 0) {
            cappedBalance = cappedBalance > reserved ? cappedBalance - reserved : 0;
        }
        v.expectedValue = IPoolManagerLogic(poolManagerLogic).assetValue(
            asset,
            (cappedBalance * portion) / 1e18
        );
        v.regularProcessing = true;

        if (complexData.withdrawData.length > 0) {
            if (asset != complexData.supportedAsset) revert IPoolLogic.InvalidAssetData();
            try
                IComplexAssetGuard(v.guard).withdrawProcessing(
                    address(this),
                    asset,
                    portion,
                    to,
                    complexData.withdrawData
                )
            returns (address wa, uint256 wamt, IAssetGuard.MultiTransaction[] memory txs) {
                (withdrawAsset, withdrawAmount, v.transactions) = (wa, wamt, txs);
            } catch {
                revert IPoolLogic.ComplexWithdrawFailed(asset, v.guard);
            }
            v.regularProcessing = false;
        } else {
            (withdrawAsset, withdrawAmount, v.transactions) = IAssetGuard(v.guard)
                .withdrawProcessing(address(this), asset, portion, to);
        }

        bool ran;
        (withdrawAmount, ran) = _runTransactions(v.transactions, withdrawAsset, withdrawAmount);
        externalProcessed = ran;

        if (
            v.regularProcessing && complexData.slippageTolerance != 0 && withdrawAsset != address(0)
        ) {
            v.actualValue = IPoolManagerLogic(poolManagerLogic).assetValue(
                withdrawAsset,
                withdrawAmount
            );

            if (
                v.actualValue <
                (v.expectedValue * (10_000 - complexData.slippageTolerance)) / 10_000
            ) revert IPoolLogic.SlippageExceeded();
        }

        return (withdrawAsset, withdrawAmount, externalProcessed);
    }

    /// @dev Executes a guard's planned transactions and returns the delivered amount: the guard's
    ///      own `withdrawAmount` plus any measured balance delta of `withdrawAsset` (when the guard
    ///      names one). Shared by the whole-asset path (withdrawProcessing) and the position-level
    ///      path (_withdrawSubset) so both run guard output through identical, single code.
    function _runTransactions(
        IAssetGuard.MultiTransaction[] memory transactions,
        address withdrawAsset,
        uint256 withdrawAmount
    ) private returns (uint256, bool externalProcessed) {
        uint256 txCount = transactions.length;
        if (txCount == 0) return (withdrawAmount, false);

        uint256 balanceBefore;
        if (withdrawAsset != address(0)) {
            balanceBefore = IERC20(withdrawAsset).balanceOf(address(this));
        }

        for (uint256 i = 0; i < txCount; ++i) {
            (bool success, bytes memory returndata) = transactions[i].to.call(
                transactions[i].txData
            );
            _checkCallResult(transactions[i].txData, success, returndata);
            externalProcessed = true;
        }

        if (withdrawAsset != address(0)) {
            uint256 balanceAfter = IERC20(withdrawAsset).balanceOf(address(this));
            if (balanceAfter > balanceBefore) {
                withdrawAmount += (balanceAfter - balanceBefore);
            }
        }
        return (withdrawAmount, externalProcessed);
    }

    /// @dev Position-level withdrawal: draws ONLY `positionIds` from a guard that fronts several
    ///      positions. No balance sizing, slippage baseline or reserved handling happens here —
    ///      the caller has already rejected fixed amounts, complex data and reserved balances for
    ///      this allocation, and the plan's value-conservation bounds (measured on the uncapped
    ///      NAV) are the authority on what actually left the fund, whatever the guard computed.
    function _withdrawSubset(
        address guard,
        address asset,
        address to,
        uint256 portion,
        bytes32[] calldata positionIds
    ) private returns (address withdrawAsset, uint256 withdrawAmount, bool externalProcessed) {
        if (positionIds.length > MAX_POSITION_IDS_PER_ALLOCATION) {
            revert IPoolLogic.TooManyPositionIds();
        }
        for (uint256 i = 1; i < positionIds.length; ++i) {
            if (positionIds[i] <= positionIds[i - 1]) revert IPoolLogic.PositionIdsNotAscending();
        }
        try ISubPositionGuard(guard).isSubPositionGuard() returns (bool supported) {
            if (!supported) revert IPoolLogic.SubsetNotSupported();
        } catch {
            revert IPoolLogic.SubsetNotSupported();
        }
        IAssetGuard.MultiTransaction[] memory transactions;
        (withdrawAsset, withdrawAmount, transactions) = ISubPositionGuard(guard)
            .withdrawProcessingSubset(address(this), asset, portion, to, positionIds);
        (withdrawAmount, externalProcessed) = _runTransactions(
            transactions,
            withdrawAsset,
            withdrawAmount
        );
    }

    /// @notice Verifies + executes an attester-signed WithdrawalPlan end-to-end: signature,
    ///         freshness, nonce, min-bps ceiling, and circuit-breaker cap checks; asset
    ///         membership + duplicate validation; the per-asset withdrawal loop (reusing
    ///         withdrawProcessing() above, identical guard dispatch to the existing pro-rata
    ///         path); and the two-sided value-conservation check. See
    ///         docs/attested-selective-withdrawal-design.md for the full step-by-step spec.
    /// @dev PoolLogic's own bytecode budget is too tight to hold this function's logic inline
    ///      (see this library's top-level docs), so — beyond the guard-dispatch loop already
    ///      extracted above — this single entry point also absorbs the fee/cooldown computation,
    ///      the fee transfer, and the fUSD burn, none of which touch PoolLogic's OWN storage
    ///      (they're all external calls or memory-only math); PoolLogic itself performs only the
    ///      three genuine SSTOREs this struct's outputs feed (consumedPlanNonce,
    ///      attestedWithdrawVolume, accountedAssets) plus the accountedAssets reduction call,
    ///      which must stay caller-side since it reads/writes accountedAssets directly.
    /// @dev computeImmediateWithdrawPortion (called below for totalClaims/completeFundValue)
    ///      reconstructs the pre-burn claims baseline by adding netFusd back onto the
    ///      already-burn-reduced totalSupply — burning before that call, exactly mirroring
    ///      _withdrawCashImmediateToSafe's existing burn-then-measure ordering, is required for
    ///      that math to be correct.
    /// @dev Every check below reverts the whole external call; PoolLogic performs no storage
    ///      writes from this function's outputs until it returns successfully, so a revert here
    ///      leaves consumedPlanNonce/attestedWithdrawVolume/accountedAssets untouched.
    function executeWithdrawalPlan(
        IPoolLogic.WithdrawalPlan calldata plan,
        bytes calldata attesterSignature,
        IPoolLogic.ComplexAsset[] calldata complexAssetsData
    ) external returns (PlanExecutionResult memory result) {
        ExecutePlanInput memory input = _loadPlanInput(plan.user, plan.nonce);
        bytes32 digest = _hashPlan(plan);
        if (!_isValidSignatureNow(input.withdrawalAttester, digest, attesterSignature)) {
            revert IPoolLogic.InvalidAttesterSignature();
        }
        if (block.timestamp > plan.deadline) revert IPoolLogic.PlanDeadlineExpired();
        // Bound the signature's lifetime: an unbounded deadline gives the holder a free option on
        // when to execute and lets an old signature survive an off/on toggle of the feature.
        if (plan.deadline > block.timestamp + MAX_PLAN_TTL) revert IPoolLogic.PlanDeadlineTooFar();
        if (input.nonceAlreadyConsumed) revert IPoolLogic.PlanNonceAlreadyUsed();
        if (plan.minValueOutBps > MAX_MIN_VALUE_OUT_BPS) revert IPoolLogic.MinValueOutBpsTooHigh();
        // Audit finding: _withdrawCashImmediateToSafe checks amount == 0 unconditionally, before
        // its own manager-bypass branch. _chargeWithdrawFee's manager-bypass branch below returns
        // (amount, 0) directly with no such check, so a manager-signed plan with fusdAmount == 0
        // could skip the burn entirely and still (within DUST_TOLERANCE) release real value via
        // the allocations loop — allocations aren't derived from fusdAmount, so a zero fusdAmount
        // doesn't itself zero out what gets withdrawn. Closing this here restores parity with the
        // existing pro-rata path's unconditional check, for every caller including the manager.
        if (plan.fusdAmount == 0) revert ZeroAmount();

        (result.netFusd, result.feeFusd) = _chargeWithdrawFee(
            input.fusd,
            input.poolManagerLogic,
            input.manager,
            plan.user,
            plan.fusdAmount
        );

        VolumeState memory newVolume = _checkAndRecordVolume(
            VolumeState(input.currentVolumeTimestamp, input.currentVolumeAccumulated),
            input.attestedWithdrawDecayWindow,
            input.maxAttestedWithdrawVolumePerWindow,
            result.netFusd
        );
        result.newVolumeTimestamp = newVolume.lastWithdrawTimestamp;
        result.newVolumeAccumulated = newVolume.accumulatedValueUsd;

        ITokenLogicMinimal(input.fusd).burnFrom(plan.user, result.netFusd);
        // fUSD supply is fixed from here until the allocations finish (checked below).
        uint256 supplyAfterBurn = IERC20(input.fusd).totalSupply();

        // VALUE MEASUREMENT. The value that leaves the fund is measured on the UNCAPPED,
        // net-realizable, deficit-adjusted, reserved-excluding NAV (`completeFundValue`), before and
        // after — not on the liquidity-capped NAV the pro-rata path sizes its portion against.
        // The capped NAV is the wrong yardstick for a plan whose allocations are chosen freely:
        // a guard whose ceiling is a MINIMUM across several positions (Morpho Blue, Aave V3)
        // reports a capped balance that does not move linearly when only some positions are
        // withdrawn, so the measured outflow can be far below the real one. That would make the
        // lower bound revert legitimate plans and, worse, weaken the UPPER bound by the inverse of
        // the binding liquidity ratio (a plan could extract many times `target` while the capped
        // reading still looked like `target`). The uncapped figure is the real, oracle-priced
        // position change, so the bounds below hold no matter which positions are drawn, and it is
        // also the correct basis for computeAccountedAssetsReduction (it already receives
        // completeFundValue as its "valueBefore"). It is read from the already-validated
        // computeImmediateWithdrawPortion(): passing 1 for its capped-NAV argument avoids its
        // zero early-return, and only its `completeFundValue` output is used.
        (, uint256 totalClaims_, uint256 completeBefore) = FundCalculationLibrary
            .computeImmediateWithdrawPortion(address(this), result.netFusd, 1);
        // fairFusd is derived from that function's own outputs via the already-validated
        // applyClaimsHaircut() wrapper (the exact expression it evaluates internally), so the
        // shared library stays byte-identical to the validated version and nothing is duplicated.
        uint256 fairFusd = FundCalculationLibrary.applyClaimsHaircut(
            result.netFusd,
            completeBefore,
            totalClaims_
        );
        result.totalClaims = totalClaims_;
        result.completeFundValue = completeBefore;
        // A zero fair entitlement (extreme insolvency or an empty pool) would satisfy the lower
        // bound below trivially and let a real burn through for $0 — revert, as the pro-rata path
        // does for the same condition. completeBefore == 0 implies fairFusd == 0, so this also
        // guarantees the surcharge denominator below is nonzero.
        if (fairFusd == 0 || result.netFusd < MIN_PLAN_NET_FUSD) {
            revert IPoolLogic.WithdrawAmountTooSmall();
        }

        // Surcharge: a small, usage-scaled slice of this withdrawal's entitlement is deliberately
        // withheld and stays in the fund as extra collateral (not paid out, not credited as yield)
        // to cushion remaining holders against the composition skew an attested withdrawal can
        // impose. See the design doc's "Surcharge" section. Computed
        // and checked here, before the allocations loop, so a plan that exceeds the attester's
        // signed tolerance fails cheaply instead of after paying for a full withdrawal.
        uint256 pressure = _averagePressure(
            uint256(newVolume.accumulatedValueUsd) - result.netFusd,
            uint256(newVolume.accumulatedValueUsd),
            completeBefore
        );
        uint256 effectiveMaxSurchargeBps = input.maxSurchargeBps > MAX_SURCHARGE_BPS_CEILING
            ? MAX_SURCHARGE_BPS_CEILING
            : input.maxSurchargeBps;
        // Kept in bps scaled by 1e18 (not truncated to whole bps) so the ramp is continuous; the
        // attester's signed ceiling is compared against it rounded UP, so it is never understated.
        uint256 surchargeBpsX18 = pressure * effectiveMaxSurchargeBps;
        if ((surchargeBpsX18 + 1e18 - 1) / 1e18 > plan.maxAcceptableSurchargeBps) {
            revert IPoolLogic.SurchargeTooHigh();
        }
        // target is what is enforced as deliverable after withholding the surcharge; BOTH sides of
        // the value bound below reference it (bounding one side against fairFusd and the other
        // against target would be internally inconsistent).
        result.surchargeAmount = (fairFusd * surchargeBpsX18) / (1e18 * 10_000);
        uint256 target = fairFusd - result.surchargeAmount;

        bool hasDirectLeg;
        (result.outAssets, result.outAmounts, hasDirectLeg) = _processAllocations(
            input.poolManagerLogic,
            plan.user,
            plan,
            complexAssetsData
        );

        // A deposit made from a token or guard callback while the loop runs would be netted out of
        // the value bound below (the refunded deposit offsets the withdrawal) yet still mint fUSD.
        // Any mint changes total supply, so require it unchanged. This lives here, not in
        // PoolLogic's validated deposit hooks, so those stay byte-identical to the baseline.
        if (IERC20(input.fusd).totalSupply() != supplyAfterBurn)
            revert IPoolLogic.FusdSupplyChanged();

        // Same call, same basis, after the loop. Also reverts IncompleteNAV if a position became
        // unvaluable mid-withdrawal, which is the safe direction.
        (, , uint256 completeAfter) = FundCalculationLibrary.computeImmediateWithdrawPortion(
            address(this),
            result.netFusd,
            1
        );
        if (completeBefore < completeAfter) revert IPoolLogic.InvalidFundValue();
        result.valueDelta = completeBefore - completeAfter;
        if (result.valueDelta > target + DUST_TOLERANCE) {
            revert IPoolLogic.ValueConservationViolated();
        }
        uint256 minAllowed = target - (target * plan.minValueOutBps) / 10_000;
        if (result.valueDelta < minAllowed) revert IPoolLogic.ValueConservationViolated();

        // RECEIPT-SIDE CHECK. The two bounds above measure value leaving the NAV. That is not the
        // same as what the user received: (a) completeFundValue floors at zero, so when the pool
        // carries a deficit the last claimant can draw more real assets than the floored drop
        // records; (b) value destroyed inside a guard's own transactions (swap slippage, flash-loan
        // premium on a leveraged unwind) leaves the NAV but never reaches the user. So also value
        // what was actually delivered as a token (legs that report a withdrawAsset): it may not
        // exceed the entitlement, and, when no leg is delivered directly by the guard's own
        // transactions (whose value cannot be measured here), it may not fall short of it either.
        {
            uint256 delivered;
            for (uint256 i = 0; i < result.outAssets.length; ++i) {
                delivered += IPoolManagerLogic(input.poolManagerLogic).assetValue(
                    result.outAssets[i],
                    result.outAmounts[i]
                );
            }
            if (delivered > target + DUST_TOLERANCE) revert IPoolLogic.ValueConservationViolated();
            if (!hasDirectLeg && delivered + DUST_TOLERANCE < minAllowed) {
                revert IPoolLogic.ValueConservationViolated();
            }
        }

        // See this event's own docs above for why it's emitted here rather than by PoolLogic.
        // Audit note: reuses CashWithdrawImmediateProRata's (asset[],amount[]) shape purely to
        // avoid compiling a second dynamic-array-encoding event on top of an already bytecode-
        // constrained contract — this is NOT a genuine uniform pro-rata withdrawal. Off-chain
        // consumers must treat any CashWithdrawImmediateProRata emitted alongside
        // AttestedWithdrawPlanExecuted in the same transaction as attester-composed, and key off
        // the paired event (present only on this path) to tell the two apart.
        emit CashWithdrawImmediateProRata(
            plan.user,
            plan.fusdAmount,
            result.netFusd,
            result.feeFusd,
            result.outAssets,
            result.outAmounts
        );
        emit AttestedWithdrawPlanExecuted(plan.user, plan.nonce, result.surchargeAmount);
    }

    /// @dev Reads every value the plan path needs from the pool through its public getters
    ///      (self-calls: under delegatecall address(this) is the pool). PoolLogic used to build and
    ///      pass this struct itself, which cost it a run of storage reads and struct encoding in a
    ///      contract with almost no EIP-170 headroom left; all of these values already have public
    ///      getters, and they are read here at the very start of the call, before any external
    ///      interaction, so the values are identical to what PoolLogic would have passed.
    function _loadPlanInput(
        address user,
        uint256 nonce
    ) private view returns (ExecutePlanInput memory input) {
        IPoolLogic pool = IPoolLogic(address(this));
        input.poolManagerLogic = pool.poolManagerLogic();
        input.fusd = pool.fusd();
        input.manager = IManaged(input.poolManagerLogic).manager();
        input.withdrawalAttester = pool.withdrawalAttester();
        input.nonceAlreadyConsumed = pool.consumedPlanNonce(user, nonce);
        input.attestedWithdrawDecayWindow = pool.attestedWithdrawDecayWindow();
        input.maxAttestedWithdrawVolumePerWindow = pool.maxAttestedWithdrawVolumePerWindow();
        (input.currentVolumeTimestamp, input.currentVolumeAccumulated) = pool
            .attestedWithdrawVolume();
        input.maxSurchargeBps = pool.maxSurchargeBps();
    }

    /// @dev Duplicates PoolLogic._applyWithdrawFeeFusd's exit-fee formula plus the manager-bypass
    ///      and cooldown checks previously inlined in _withdrawCashImmediateToSafe — a deliberate
    ///      duplication (rather than PoolLogic calling its own existing internal helpers and
    ///      passing results in) purely to keep this logic out of PoolLogic's own bytecode; shared
    ///      by both executeWithdrawalPlan and executeProRataWithdrawal below. Both copies (this
    ///      one and PoolLogic._applyWithdrawFeeFusd, kept for FundCalculationLibrary's other
    ///      unrelated call sites) must stay in sync if the fee formula ever changes.
    function _chargeWithdrawFee(
        address fusd,
        address poolManagerLogic,
        address manager,
        address user,
        uint256 amount
    ) private returns (uint256 netFusd, uint256 feeFusd) {
        if (user == manager) {
            return (amount, 0);
        }

        if (ITokenLogicMinimal(fusd).getExitRemainingCooldown(user) != 0) revert CooldownActive();

        (, , , uint256 exitFeeNumerator, uint256 feeDenominator) = IPoolManagerLogic(
            poolManagerLogic
        ).getFee();

        if (exitFeeNumerator == 0 || amount == 0) {
            netFusd = amount;
        } else {
            feeFusd = (amount * exitFeeNumerator) / feeDenominator;
            if (feeFusd > amount) feeFusd = amount;
            netFusd = amount - feeFusd;
        }
        if (netFusd == 0) revert ZeroAmount();

        if (feeFusd > 0) {
            IERC20(fusd).safeTransferFrom(user, manager, feeFusd);
        }
    }

    /// @dev Bundled input to executeProRataWithdrawal — mirrors ExecutePlanInput's rationale.
    struct ProRataInput {
        address fusd;
        address poolManagerLogic;
        address manager;
    }

    /// @dev Same field shape as PlanExecutionResult minus the circuit-breaker volume outputs,
    ///      which the pro-rata path doesn't use.
    struct ProRataResult {
        address[] outAssets;
        uint256[] outAmounts;
        uint256 netFusd;
        uint256 feeFusd;
        uint256 valueDelta;
        uint256 totalClaims;
        uint256 completeFundValue;
    }

    /// @notice Extracted out of PoolLogic._withdrawCashImmediateToSafe/_withdrawProRata/
    ///         _withdrawProRataInternal/_withdrawOne (pure code motion, same behavior) — this
    ///         library's PoolLogic-bytecode-budget pressure (see top-level docs) applies equally
    ///         to the pre-existing uniform pro-rata path, not just the new attested-plan one, so
    ///         both were moved out together rather than leaving this one only partially
    ///         extracted (already-shared withdrawProcessing()/_chargeWithdrawFee() reused as-is).
    /// @dev Single-sided value-conservation bound only (valueDelta must not exceed
    ///      netFusd + DUST_TOLERANCE) — unlike executeWithdrawalPlan's two-sided bound, under-
    ///      delivery isn't a realistic failure mode here since every supported asset is always
    ///      included at the same portion, so the sum reliably tracks netFusd up to rounding. See
    ///      docs/attested-selective-withdrawal-design.md's "Value Conservation" section.
    function executeProRataWithdrawal(
        ProRataInput memory input,
        address user,
        address recipient,
        uint256 amount,
        IPoolLogic.ComplexAsset[] memory complexAssetsData
    ) external returns (ProRataResult memory result) {
        (result.netFusd, result.feeFusd) = _chargeWithdrawFee(
            input.fusd,
            input.poolManagerLogic,
            input.manager,
            user,
            amount
        );

        ITokenLogicMinimal(input.fusd).burnFrom(user, result.netFusd);

        uint256 fundValue = FundCalculationLibrary.computeWithdrawableFundValue(
            address(this),
            input.poolManagerLogic
        );
        if (fundValue == 0) revert IPoolLogic.EmptyFund();

        uint256 portion;
        (portion, result.totalClaims, result.completeFundValue) = FundCalculationLibrary
            .computeImmediateWithdrawPortion(address(this), result.netFusd, fundValue);
        if (portion == 0) revert IPoolLogic.WithdrawAmountTooSmall();

        IHasSupportedAsset.Asset[] memory supportedAssets = IHasSupportedAsset(
            input.poolManagerLogic
        ).getSupportedAssets();
        if (complexAssetsData.length != supportedAssets.length)
            revert IPoolLogic.InvalidAssetData();

        uint256 n = supportedAssets.length;
        address[] memory outAssets = new address[](n);
        uint256[] memory outAmounts = new uint256[](n);
        uint256 count;

        for (uint256 i = 0; i < n; ++i) {
            address a = supportedAssets[i].asset;
            IPoolLogic.ComplexAsset memory cd = complexAssetsData[i];
            if (cd.withdrawData.length > 0 && a != cd.supportedAsset)
                revert IPoolLogic.InvalidAssetData();

            (address withdrawAsset, uint256 withdrawAmount, ) = withdrawProcessing(
                input.poolManagerLogic,
                a,
                recipient,
                portion,
                IPoolLogic(address(this)).reservedAssetBalance(a),
                cd
            );

            if (withdrawAsset != address(0) && withdrawAmount > 0) {
                IERC20(withdrawAsset).safeTransfer(recipient, withdrawAmount);
                outAssets[count] = withdrawAsset;
                outAmounts[count] = withdrawAmount;
                ++count;
            }
        }

        assembly {
            mstore(outAssets, count)
            mstore(outAmounts, count)
        }
        result.outAssets = outAssets;
        result.outAmounts = outAmounts;

        uint256 valueAfter = FundCalculationLibrary.computeWithdrawableFundValue(
            address(this),
            input.poolManagerLogic
        );
        if (fundValue < valueAfter) revert IPoolLogic.InvalidFundValue();
        result.valueDelta = fundValue - valueAfter;
        if (result.valueDelta > result.netFusd + DUST_TOLERANCE)
            revert IPoolLogic.InvalidFundValue();
    }

    function _processAllocations(
        address poolManagerLogic,
        address to,
        IPoolLogic.WithdrawalPlan calldata plan,
        IPoolLogic.ComplexAsset[] calldata complexAssetsData
    ) private returns (address[] memory outAssets, uint256[] memory outAmounts, bool hasDirectLeg) {
        uint256 n = plan.allocations.length;
        outAssets = new address[](n);
        outAmounts = new uint256[](n);
        uint256 count;

        for (uint256 i = 0; i < n; ++i) {
            IPoolLogic.AssetAllocation calldata alloc = plan.allocations[i];
            address asset = alloc.asset;

            if (!IHasSupportedAsset(poolManagerLogic).isSupportedAsset(asset)) {
                revert IPoolLogic.AssetNotSupported();
            }
            for (uint256 j = 0; j < i; ++j) {
                if (plan.allocations[j].asset == asset) revert IPoolLogic.DuplicateAllocation();
            }

            // Guard binding (always): the attester signed the guard it validated for this asset.
            address guard = IPoolManagerLogic(poolManagerLogic).getAssetGuard(asset);
            if (guard == address(0)) revert IPoolLogic.InvalidGuard();
            if (guard != alloc.guard) revert IPoolLogic.GuardMismatch();

            // A plan must not draw an asset that queued requests are waiting on: plans are the
            // only immediate exit in queue mode, and nothing else earmarks liquidity for them.
            if (IPoolLogic(address(this)).pendingCashWithdrawCount(asset) != 0) {
                revert IPoolLogic.AssetHasPendingWithdrawRequests();
            }

            uint256 portion;
            address withdrawAsset;
            uint256 withdrawAmount;
            bool external_;
            if (alloc.positionIds.length > 0) {
                // Position-level selection: only the listed positions, at a direct portion.
                if (
                    alloc.useFixedAmount ||
                    IPoolLogic(address(this)).reservedAssetBalance(asset) > 0 ||
                    _matchComplexAsset(complexAssetsData, asset).supportedAsset != address(0)
                ) revert IPoolLogic.InvalidSubsetAllocation();
                portion = alloc.portion;
                if (portion > 1e18) revert IPoolLogic.InvalidPortion();
                (withdrawAsset, withdrawAmount, external_) = _withdrawSubset(
                    guard,
                    asset,
                    to,
                    portion,
                    alloc.positionIds
                );
            } else {
                if (alloc.useFixedAmount) {
                    uint256 balance = IAssetGuard(guard).getBalance(address(this), asset);
                    if (balance == 0) revert IPoolLogic.ZeroAssetBalance();
                    portion = (alloc.fixedAmount * 1e18) / balance;
                    if (portion > 1e18) portion = 1e18;
                } else {
                    // Audit finding: a direct attester-supplied portion had no on-chain upper
                    // bound (unlike the fixed-amount branch, explicitly clamped, and the pro-rata
                    // path, structurally <= 1e18). A portion above 1e18 is guard-implementation-
                    // dependent, and the value-conservation check after the loop is not a
                    // substitute for bounding the input itself. Reject outright instead.
                    portion = alloc.portion;
                    if (portion > 1e18) revert IPoolLogic.InvalidPortion();
                }

                (withdrawAsset, withdrawAmount, external_) = withdrawProcessing(
                    poolManagerLogic,
                    asset,
                    to,
                    portion,
                    IPoolLogic(address(this)).reservedAssetBalance(asset),
                    _matchComplexAsset(complexAssetsData, asset)
                );
            }

            // Value the guard delivered directly through its own transactions (no withdrawAsset)
            // is not measurable here; remember that one exists.
            if (withdrawAsset == address(0) && external_) hasDirectLeg = true;

            if (withdrawAsset != address(0) && withdrawAmount > 0) {
                IERC20(withdrawAsset).safeTransfer(to, withdrawAmount);
                outAssets[count] = withdrawAsset;
                outAmounts[count] = withdrawAmount;
                ++count;
            }
        }

        assembly {
            mstore(outAssets, count)
            mstore(outAmounts, count)
        }
    }

    /// @dev complexAssetsData is unsigned, call-time-only data (see design doc's Data
    ///      Structures section) matched to `allocations` by asset address rather than array
    ///      index, since `allocations` is sparse while withdrawCashImmediate's supportedAssets
    ///      loop is dense. Bounded by getSupportedAssets().length (capped at
    ///      _maximumSupportedAssetCount, default 50) exactly like the existing pro-rata path.
    function _matchComplexAsset(
        IPoolLogic.ComplexAsset[] calldata complexAssetsData,
        address asset
    ) private pure returns (IPoolLogic.ComplexAsset memory) {
        for (uint256 i = 0; i < complexAssetsData.length; ++i) {
            if (complexAssetsData[i].supportedAsset == asset) {
                return complexAssetsData[i];
            }
        }
        return
            IPoolLogic.ComplexAsset({
                supportedAsset: address(0),
                withdrawData: "",
                slippageTolerance: 0
            });
    }

    /// @notice Verifies `signature` against `signer` for `digest`, supporting both a plain EOA
    ///         (ECDSA) and an ERC-1271 contract signer (e.g. a future co-signing multisig for
    ///         the withdrawal attester) — see design doc's "EIP-712 Typed Data" section on why
    ///         this must not assume a raw EOA key.
    /// @dev Hand-rolled instead of OpenZeppelin's SignatureChecker.sol: that library (as of
    ///      5.4.0) transitively imports Bytes.sol, which uses the `mcopy` opcode (EIP-5656,
    ///      Cancun-only) — this repo's solc 0.8.24 default target is Paris (see hardhat.config.ts,
    ///      no evmVersion override), so linking it fails to compile. This reimplementation uses
    ///      only ECDSA.sol (already used by TokenLogic.sol's depositWithAuthorization, itself
    ///      Cancun-independent) plus a manual ERC-1271 staticcall, producing the identical
    ///      EOA-or-contract acceptance behavior.
    function _isValidSignatureNow(
        address signer,
        bytes32 digest,
        bytes calldata signature
    ) private view returns (bool) {
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == signer) {
            return true;
        }

        if (signer.code.length == 0) return false;
        (bool success, bytes memory returndata) = signer.staticcall(
            abi.encodeCall(IERC1271.isValidSignature, (digest, signature))
        );
        return
            success &&
            returndata.length == 32 &&
            abi.decode(returndata, (bytes4)) == IERC1271.isValidSignature.selector;
    }

    /// @dev EIP-712 digest, hand-rolled rather than inheriting EIP712Upgradeable in PoolLogic
    ///      itself, purely to avoid that inherited init/dispatch bytecode landing in PoolLogic's
    ///      already bytecode-constrained contract — see WithdrawalPlanLib's own top-level docs.
    ///      Computed under delegatecall, so address(this) here still correctly resolves to
    ///      PoolLogic's own proxy address, matching what EIP712Upgradeable._domainSeparatorV4()
    ///      would have produced had PoolLogic inherited it directly.
    function _hashPlan(IPoolLogic.WithdrawalPlan calldata plan) private view returns (bytes32) {
        uint256 n = plan.allocations.length;
        bytes32[] memory allocationHashes = new bytes32[](n);
        for (uint256 i = 0; i < n; ++i) {
            IPoolLogic.AssetAllocation calldata alloc = plan.allocations[i];
            allocationHashes[i] = keccak256(
                abi.encode(
                    ASSET_ALLOCATION_TYPEHASH,
                    alloc.asset,
                    alloc.guard,
                    keccak256(abi.encodePacked(alloc.positionIds)),
                    alloc.useFixedAmount,
                    alloc.portion,
                    alloc.fixedAmount
                )
            );
        }

        bytes32 structHash = keccak256(
            abi.encode(
                WITHDRAWAL_PLAN_TYPEHASH,
                plan.user,
                plan.fusdAmount,
                plan.minValueOutBps,
                keccak256(abi.encodePacked(allocationHashes)),
                plan.nonce,
                plan.deadline,
                plan.maxAcceptableSurchargeBps
            )
        );

        bytes32 domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                DOMAIN_NAME_HASH,
                DOMAIN_VERSION_HASH,
                block.chainid,
                address(this)
            )
        );

        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    /// @dev Average surcharge pressure over THIS withdrawal, i.e. the pressure integrated between
    ///      the recent volume before it (`volumeBefore`, already decayed) and after it
    ///      (`volumeAfter`, which includes it). The reference size is the fund as it stood before
    ///      the recent withdrawals, `completeBefore + volumeBefore`, NOT the current (already
    ///      shrunk) fund. With that constant base the charge is the area under a linear price
    ///      curve, so splitting one withdrawal into several plans costs the same in total (up to
    ///      decay, deposits and rounding); measuring against the shrinking current fund, or
    ///      charging every unit at the end-of-withdrawal pressure, made the total depend on how the
    ///      withdrawal was cut. Each side is capped at 100% so the rate never exceeds the governed
    ///      maximum. `completeBefore` is nonzero (the caller reverts on a zero fair entitlement),
    ///      so the base is nonzero.
    function _averagePressure(
        uint256 volumeBefore,
        uint256 volumeAfter,
        uint256 completeBefore
    ) private pure returns (uint256) {
        uint256 base = completeBefore + volumeBefore;
        uint256 pressureBefore = Math.min((volumeBefore * 1e18) / base, 1e18);
        uint256 pressureAfter = Math.min((volumeAfter * 1e18) / base, 1e18);
        return (pressureBefore + pressureAfter) / 2;
    }

    /// @dev Continuously-decaying volume accumulator — identical math to
    ///      SlippageAccumulator.sol's accumulatedSlippage decay, applied to attested-withdraw USD
    ///      volume instead. No fixed-window reset boundary exists to straddle (see design doc's
    ///      "Bounding a Compromised Attester Key" section for why a naive fixed-window reset was
    ///      rejected). Pure: PoolLogic performs the actual attestedWithdrawVolume SSTORE itself
    ///      using the returned VolumeState.
    function _checkAndRecordVolume(
        VolumeState memory current,
        uint256 decayWindow,
        uint256 maxVolumePerWindow,
        uint256 valueUsd
    ) private view returns (VolumeState memory) {
        // Audit finding (4th round): attestedWithdrawDecayWindow's own setter
        // (setAttestedWithdrawDecayWindow) enforces MIN_ATTESTED_WITHDRAW_DECAY_WINDOW, but
        // setAttestedWithdrawEnabled(true) and setMaxAttestedWithdrawVolumePerWindow have no
        // check that the decay window was ever actually set — a manager could enable the
        // feature and configure a real volume cap while simply never calling
        // setAttestedWithdrawDecayWindow, leaving it at its unsafe storage-default 0. With
        // decayWindow == 0, `elapsed < decayWindow` below is never true, so `decayed` is
        // always 0 — silently degrading the circuit breaker to a stateless per-transaction
        // check with zero cross-transaction memory, exactly the failure mode the floor exists
        // to prevent (see MIN_ATTESTED_WITHDRAW_DECAY_WINDOW's own docs), just reached via a
        // configuration-omission path that setter's floor alone doesn't cover. Defended here,
        // at the actual point of use, rather than trying to gate every possible entry point
        // that could leave the feature "enabled" without every parameter configured.
        if (decayWindow == 0) revert IPoolLogic.AttestedWithdrawVolumeCapExceeded();

        // The window is manager-settable with a floor but no ceiling. A value near 2**256 would
        // make `accumulated * (decayWindow - elapsed)` below overflow and revert every plan
        // withdrawal by panic, so an unreasonably large window is treated as MAX_DECAY_WINDOW
        // (a stored value above it simply behaves as 30 days) instead of being able to disable
        // the feature.
        if (decayWindow > MAX_DECAY_WINDOW) decayWindow = MAX_DECAY_WINDOW;

        uint256 decayed;
        if (current.accumulatedValueUsd != 0) {
            uint256 elapsed = block.timestamp - current.lastWithdrawTimestamp;
            if (elapsed < decayWindow) {
                decayed =
                    (uint256(current.accumulatedValueUsd) * (decayWindow - elapsed)) /
                    decayWindow;
            }
        }

        uint256 newTotal = decayed + valueUsd;
        // Audit finding: accumulatedValueUsd is a storage uint128, but maxAttestedWithdrawVolumePerWindow
        // (manager-settable, no enforced ceiling — see its own docs) could be set above
        // type(uint128).max, in which case newTotal passing the cap check below would still
        // silently truncate on the uint128() cast further down, corrupting the accumulator
        // rather than failing safely. Bounding here catches that regardless of how the cap is
        // configured, and also covers the (practically unreachable, but not otherwise enforced)
        // case of a single valueUsd already exceeding type(uint128).max.
        if (newTotal > maxVolumePerWindow || newTotal > type(uint128).max) {
            revert IPoolLogic.AttestedWithdrawVolumeCapExceeded();
        }

        return
            VolumeState({
                lastWithdrawTimestamp: uint64(block.timestamp),
                accumulatedValueUsd: uint128(newTotal)
            });
    }

    function _checkCallResult(
        bytes memory data,
        bool success,
        bytes memory returndata
    ) private pure {
        if (!success) revert IPoolLogic.TxFailed();

        // Only verify return value for ERC20 transfer/approve
        if (data.length < 4) revert IPoolLogic.InvalidCallData();
        bytes4 sig;
        assembly {
            sig := mload(add(data, 32))
        }

        bool isERC20 = (sig == IERC20.transfer.selector || sig == IERC20.approve.selector);

        if (isERC20 && returndata.length > 0) {
            // SafeERC20-style: decode as bool
            bool ok = abi.decode(returndata, (bool));
            if (!ok) revert IPoolLogic.TxFailed();
        }
        // For other calls (e.g., Aave withdraw/repay uint256), ignore returndata
    }
}
