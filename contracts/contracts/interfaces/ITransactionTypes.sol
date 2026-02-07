// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Frgmnt — ITransactionTypes
/// @notice Transaction types used in pool execTransaction() contract guards.
interface ITransactionTypes {
	enum TransactionType {
		NotUsed, // 0
		Approve, // 1
        Exchange,// 2
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
		MorphoRewardClaim // 24
	}
}
