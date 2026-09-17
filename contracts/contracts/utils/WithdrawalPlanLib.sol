// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { IPoolLogic } from "../interfaces/IPoolLogic.sol";
import { IPoolManagerLogic } from "../interfaces/IPoolManagerLogic.sol";
import { IAssetGuard } from "../interfaces/guards/IAssetGuard.sol";
import { IComplexAssetGuard } from "../interfaces/guards/IComplexAssetGuard.sol";
import { FundCalculationLibrary } from "./FundCalculationLibrary.sol";

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
    error InvalidGuard();
    error ComplexWithdrawFailed(address asset, address guard);
    error TxFailed();
    error InvalidCallData();

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
    function withdrawProcessing(
        address poolManagerLogic,
        address asset,
        address to,
        uint256 portion,
        uint256 reserved,
        IPoolLogic.ComplexAsset memory complexData
    ) external returns (address withdrawAsset, uint256 withdrawAmount, bool externalProcessed) {
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
