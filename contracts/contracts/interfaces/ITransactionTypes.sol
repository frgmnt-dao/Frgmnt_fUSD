// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Frgmnt — ITransactionTypes
/// @notice Transaction types used in pool execTransaction() contract guards.
interface ITransactionTypes {
    enum TransactionType {
        NotUsed, // 0
        Approve, // 1
        Exchange, // 2
        UniswapV3Mint, // 3
        UniswapV3IncreaseLiquidity, // 4
        UniswapV3DecreaseLiquidity, // 5
        UniswapV3Burn, // 6
        UniswapV3Collect, // 7
        UniswapV3Multicall, // 8
        AaveDeposit, // 9
        AaveWithdraw, // 10
        AaveSetUserUseReserveAsCollateral, // 11
        AaveBorrow, // 12
        AaveRepay, // 13
        AaveSwapBorrowRateMode, // 14
        AaveRebalanceStableBorrowRate, // 15
        MorphoSupply, // 16
        MorphoWithdraw, // 17
        MorphoBorrow, // 18
        MorphoRepay, // 19
        MorphoSupplyCollateral, // 20
        MorphoWithdrawCollateral, // 21
        MorphoLiquidate, // 22
        MorphoFlashLoan, // 23
        MerklRewardClaim, // 24 — FNA-19: renamed from MorphoRewardClaim; numeric value unchanged. Covers any Merkl-sourced reward claim (Morpho Blue, Aave V4 Spoke, etc.), not just Morpho's.
        MorphoVaultV2Deposit, // 25
        MorphoVaultV2Mint, // 26
        MorphoVaultV2Withdraw, // 27
        MorphoVaultV2Redeem, // 28
        MorphoVaultV2ForceDeallocate, // 29
        AaveV4SpokeSupply, // 30
        AaveV4SpokeApproveWithdraw, // 31
        AaveV4SpokeWithdraw, // 32
        AaveV4TokenizationDeposit, // 33
        AaveV4TokenizationMint, // 34
        AaveV4TokenizationWithdraw, // 35
        AaveV4TokenizationRedeem, // 36
        AaveV4SpokeSetPositionManager // 37
    }
}
