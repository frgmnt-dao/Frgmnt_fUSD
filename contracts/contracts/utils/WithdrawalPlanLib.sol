// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";

import { IPoolLogic } from "../interfaces/IPoolLogic.sol";
import { IPoolManagerLogic } from "../interfaces/IPoolManagerLogic.sol";
import { IHasSupportedAsset } from "../interfaces/IHasSupportedAsset.sol";
import { IAssetGuard } from "../interfaces/guards/IAssetGuard.sol";
import { IComplexAssetGuard } from "../interfaces/guards/IComplexAssetGuard.sol";
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

    error InvalidGuard();
    error ComplexWithdrawFailed(address asset, address guard);
    error TxFailed();
    error InvalidCallData();
    error InvalidAttesterSignature();
    error PlanDeadlineExpired();
    error PlanNonceAlreadyUsed();
    error DuplicateAllocation();
    error ZeroAssetBalance();
    error MinValueOutBpsTooHigh();
    error AttestedWithdrawVolumeCapExceeded();
    error ValueConservationViolated();
    /// @dev Same selector as PoolLogic.CooldownActive()/ZeroAmount() (identical, param-less
    ///      error signatures always hash identically regardless of declaring scope) — declared
    ///      separately here purely so this library doesn't need to import PoolLogic.sol's own
    ///      contract-scoped errors (which would require a circular import).
    error CooldownActive();
    error ZeroAmount();
    error EmptyFund();
    error WithdrawAmountTooSmall();

    /// @dev Fixed, protocol-level upper-bound tolerance on over-delivery — reused verbatim from
    ///      PoolLogic._withdrawCashImmediateToSafe's existing `1e15` constant (not duplicated by
    ///      reference, since that one stays inline there; kept as the same value here so both
    ///      withdrawal paths tolerate identical dust).
    uint256 private constant DUST_TOLERANCE = 1e15;

    /// @dev Must stay numerically identical to PoolLogic.MAX_MIN_VALUE_OUT_BPS — duplicated here
    ///      (rather than cross-contract-referenced) because a library cannot read a constant
    ///      declared on a specific contract it doesn't inherit.
    uint256 private constant MAX_MIN_VALUE_OUT_BPS = 100; // 1%

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant DOMAIN_NAME_HASH = keccak256(bytes("Frgmnt PoolLogic"));
    bytes32 private constant DOMAIN_VERSION_HASH = keccak256(bytes("1"));

    bytes32 private constant ASSET_ALLOCATION_TYPEHASH =
        keccak256("AssetAllocation(address asset,bool useFixedAmount,uint256 portion,uint256 fixedAmount)");

    bytes32 private constant WITHDRAWAL_PLAN_TYPEHASH =
        keccak256(
            "WithdrawalPlan(address user,uint256 fusdAmount,uint256 minValueOutBps,AssetAllocation[] allocations,uint256 nonce,uint256 deadline)AssetAllocation(address asset,bool useFixedAmount,uint256 portion,uint256 fixedAmount)"
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
    }

    /// @dev Bundled input to executeWithdrawalPlan — avoids stack-too-deep across what would
    ///      otherwise be 9+ separate parameters. Flattened (no nested structs) to keep this
    ///      struct's own ABI-encoding footprint at the PoolLogic call site as small as possible.
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
    }

    struct WithdrawProcessingLocalVars {
        address guard;
        uint256 balance;
        uint256 portionBalance;
        uint256 expectedValue;
        IAssetGuard.MultiTransaction[] transactions;
        bool regularProcessing;
        uint256 txCount;
        uint256 assetBalanceBefore;
        uint256 assetBalanceAfter;
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
        if (v.guard == address(0)) revert InvalidGuard();

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
                revert ComplexWithdrawFailed(asset, v.guard);
            }
            v.regularProcessing = false;
        } else {
            (withdrawAsset, withdrawAmount, v.transactions) = IAssetGuard(v.guard)
                .withdrawProcessing(address(this), asset, portion, to);
        }

        v.txCount = v.transactions.length;
        if (v.txCount > 0) {
            if (withdrawAsset != address(0)) {
                v.assetBalanceBefore = IERC20(withdrawAsset).balanceOf(address(this));
            }

            for (uint256 i = 0; i < v.txCount; ++i) {
                (bool success, bytes memory returndata) = v.transactions[i].to.call(
                    v.transactions[i].txData
                );
                _checkCallResult(v.transactions[i].txData, success, returndata);
                externalProcessed = true;
            }

            if (withdrawAsset != address(0)) {
                v.assetBalanceAfter = IERC20(withdrawAsset).balanceOf(address(this));
                if (v.assetBalanceAfter > v.assetBalanceBefore) {
                    withdrawAmount += (v.assetBalanceAfter - v.assetBalanceBefore);
                }
            }
        }

        if (
            v.regularProcessing && complexData.slippageTolerance != 0 && withdrawAsset != address(0)
        ) {
            v.actualValue = IPoolManagerLogic(poolManagerLogic).assetValue(
                withdrawAsset,
                withdrawAmount
            );

            if (
                v.actualValue < (v.expectedValue * (10_000 - complexData.slippageTolerance)) / 10_000
            ) revert IPoolLogic.SlippageExceeded();
        }

        return (withdrawAsset, withdrawAmount, externalProcessed);
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
        ExecutePlanInput memory input,
        IPoolLogic.WithdrawalPlan calldata plan,
        bytes calldata attesterSignature,
        IPoolLogic.ComplexAsset[] calldata complexAssetsData
    ) external returns (PlanExecutionResult memory result) {
        bytes32 digest = _hashPlan(plan);
        if (!_isValidSignatureNow(input.withdrawalAttester, digest, attesterSignature)) {
            revert InvalidAttesterSignature();
        }
        if (block.timestamp > plan.deadline) revert PlanDeadlineExpired();
        if (input.nonceAlreadyConsumed) revert PlanNonceAlreadyUsed();
        if (plan.minValueOutBps > MAX_MIN_VALUE_OUT_BPS) revert MinValueOutBpsTooHigh();

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

        uint256 valueBefore = FundCalculationLibrary.computeWithdrawableFundValue(
            address(this),
            input.poolManagerLogic
        );

        (result.outAssets, result.outAmounts) = _processAllocations(
            input.poolManagerLogic,
            plan.user,
            plan,
            complexAssetsData
        );

        uint256 valueAfter = FundCalculationLibrary.computeWithdrawableFundValue(
            address(this),
            input.poolManagerLogic
        );
        if (valueBefore < valueAfter) revert IPoolLogic.InvalidFundValue();
        result.valueDelta = valueBefore - valueAfter;
        if (result.valueDelta > result.netFusd + DUST_TOLERANCE) revert ValueConservationViolated();
        uint256 minAllowed = result.netFusd - (result.netFusd * plan.minValueOutBps) / 10_000;
        if (result.valueDelta < minAllowed) revert ValueConservationViolated();

        (, result.totalClaims, result.completeFundValue) = FundCalculationLibrary
            .computeImmediateWithdrawPortion(address(this), result.netFusd, valueBefore);
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

        (, , , uint256 exitFeeNumerator, uint256 feeDenominator) = IPoolManagerLogic(poolManagerLogic).getFee();

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
        if (fundValue == 0) revert EmptyFund();

        uint256 portion;
        (portion, result.totalClaims, result.completeFundValue) = FundCalculationLibrary
            .computeImmediateWithdrawPortion(address(this), result.netFusd, fundValue);
        if (portion == 0) revert WithdrawAmountTooSmall();

        IHasSupportedAsset.Asset[] memory supportedAssets = IHasSupportedAsset(input.poolManagerLogic)
            .getSupportedAssets();
        if (complexAssetsData.length != supportedAssets.length) revert IPoolLogic.InvalidAssetData();

        uint256 n = supportedAssets.length;
        address[] memory outAssets = new address[](n);
        uint256[] memory outAmounts = new uint256[](n);
        uint256 count;

        for (uint256 i = 0; i < n; ++i) {
            address a = supportedAssets[i].asset;
            IPoolLogic.ComplexAsset memory cd = complexAssetsData[i];
            if (cd.withdrawData.length > 0 && a != cd.supportedAsset) revert IPoolLogic.InvalidAssetData();

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
        if (result.valueDelta > result.netFusd + DUST_TOLERANCE) revert IPoolLogic.InvalidFundValue();
    }

    function _processAllocations(
        address poolManagerLogic,
        address to,
        IPoolLogic.WithdrawalPlan calldata plan,
        IPoolLogic.ComplexAsset[] calldata complexAssetsData
    ) private returns (address[] memory outAssets, uint256[] memory outAmounts) {
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
                if (plan.allocations[j].asset == asset) revert DuplicateAllocation();
            }

            uint256 portion = alloc.portion;
            if (alloc.useFixedAmount) {
                address guard = IPoolManagerLogic(poolManagerLogic).getAssetGuard(asset);
                if (guard == address(0)) revert InvalidGuard();
                uint256 balance = IAssetGuard(guard).getBalance(address(this), asset);
                if (balance == 0) revert ZeroAssetBalance();
                portion = (alloc.fixedAmount * 1e18) / balance;
                if (portion > 1e18) portion = 1e18;
            }

            (address withdrawAsset, uint256 withdrawAmount, ) = withdrawProcessing(
                poolManagerLogic,
                asset,
                to,
                portion,
                IPoolLogic(address(this)).reservedAssetBalance(asset),
                _matchComplexAsset(complexAssetsData, asset)
            );

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
        return IPoolLogic.ComplexAsset({ supportedAsset: address(0), withdrawData: "", slippageTolerance: 0 });
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
                plan.deadline
            )
        );

        bytes32 domainSeparator = keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, DOMAIN_NAME_HASH, DOMAIN_VERSION_HASH, block.chainid, address(this))
        );

        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
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
        uint256 decayed;
        if (current.accumulatedValueUsd != 0) {
            uint256 elapsed = block.timestamp - current.lastWithdrawTimestamp;
            if (elapsed < decayWindow) {
                decayed = (uint256(current.accumulatedValueUsd) * (decayWindow - elapsed)) / decayWindow;
            }
        }

        uint256 newTotal = decayed + valueUsd;
        if (newTotal > maxVolumePerWindow) revert AttestedWithdrawVolumeCapExceeded();

        return
            VolumeState({
                lastWithdrawTimestamp: uint64(block.timestamp),
                accumulatedValueUsd: uint128(newTotal)
            });
    }

    function _checkCallResult(bytes memory data, bool success, bytes memory returndata) private pure {
        if (!success) revert TxFailed();

        // Only verify return value for ERC20 transfer/approve
        if (data.length < 4) revert InvalidCallData();
        bytes4 sig;
        assembly {
            sig := mload(add(data, 32))
        }

        bool isERC20 = (sig == IERC20.transfer.selector || sig == IERC20.approve.selector);

        if (isERC20 && returndata.length > 0) {
            // SafeERC20-style: decode as bool
            bool ok = abi.decode(returndata, (bool));
            if (!ok) revert TxFailed();
        }
        // For other calls (e.g., Aave withdraw/repay uint256), ignore returndata
    }
}
