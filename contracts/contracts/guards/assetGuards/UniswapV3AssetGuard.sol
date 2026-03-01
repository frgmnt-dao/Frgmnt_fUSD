// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol";
import "@uniswap/v3-periphery/contracts/libraries/OracleLibrary.sol";
// import "@uniswap/v3-periphery/contracts/libraries/PositionValue.sol"; // kept optional, but not used to avoid PoolAddress.computeAddress() DoS
import "@uniswap/v3-periphery/contracts/libraries/LiquidityAmounts.sol";
import "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import "@uniswap/v3-core/contracts/libraries/FullMath.sol";

import "./ERC20Guard.sol";
import "../../interfaces/IHasAssetInfo.sol";
import "../../interfaces/IPoolLogic.sol";
import "../../interfaces/IERC20Extended.sol";
import "../contractGuards/uniswapV3/UniswapV3NonfungiblePositionGuard.sol";
import "../../utils/UniswapV3PriceLibrary.sol";

/**
 * @title Frgmnt Uniswap V3 Asset Guard
 * @notice Values and withdraws Uniswap V3 LP NFT positions held by a pool.
 * @dev Asset type = 5
 *      - Aggregates USD value of all owned Uniswap V3 NFT positions (token0 + token1).
 *      - For withdrawals, proportionally decreases liquidity and collects fees/principals to the recipient.
 *      - Skips NFTs whose underlying tokens are not valid assets in the factory.
 * @custom:project Frgmnt
 */
contract UniswapV3AssetGuard is ERC20Guard {
	struct UniV3PoolParams {
		address token0;
		address token1;
		uint24 fee;
		uint160 sqrtPriceX96;
	}

	/// @dev Time buffer added to the current block timestamp for Uniswap V3 deadlines.
	uint256 public constant DEADLINE_BUFFER = 15 minutes;

	/// @dev Admin allowed to adjust withdrawal slippage and twap window.
	address public admin;

	/// @dev Slippage protection used for Uniswap V3 liquidity withdrawals (in bps).
	uint256 public withdrawalSlippageBps = 100; // 1%

	/// @dev TWAP window (seconds) used to mitigate price manipulation during withdrawal construction.
	uint32 public withdrawalTwapWindow = 600; // 10 minutes

	uint256 private constant BPS_DENOMINATOR = 10_000;

	/// @dev 100% withdraw = 1e18
    uint256 private constant PORTION_DENOMINATOR = 1e18;

	event WithdrawalSlippageBpsUpdated(uint256 oldValue, uint256 newValue);
    event WithdrawalTwapWindowUpdated(uint32 oldValue, uint32 newValue);
    event AdminUpdated(address oldAdmin, address newAdmin);

	constructor() {
		admin = msg.sender;
	}

	modifier onlyAdmin() {
		require(msg.sender == admin, "UniswapV3AssetGuard: not admin");
		_;
	}

	/// @notice Updates the slippage tolerance (in bps) used for amount0Min/amount1Min on decreaseLiquidity.
	/// @dev 0 bps = no buffer; 10_000 bps = 100% (not recommended). We cap it for safety.
	function setWithdrawalSlippageBps(uint256 _withdrawalSlippageBps) external onlyAdmin {
		require(_withdrawalSlippageBps <= 2_000, "UniswapV3AssetGuard: slippage too high"); // max 20%
		uint256 oldValue = withdrawalSlippageBps;
		withdrawalSlippageBps = _withdrawalSlippageBps;
		emit WithdrawalSlippageBpsUpdated(oldValue, _withdrawalSlippageBps);
	}

	/// @notice Updates the TWAP window (seconds) used during withdrawal construction.
	function setWithdrawalTwapWindow(uint32 _withdrawalTwapWindow) external onlyAdmin {
		require(_withdrawalTwapWindow >= 60, "UniswapV3AssetGuard: twap too small"); // minimum 1 minute
		uint32 oldValue = withdrawalTwapWindow;
		withdrawalTwapWindow = _withdrawalTwapWindow;
		emit WithdrawalTwapWindowUpdated(oldValue, _withdrawalTwapWindow);
	}

	/// @notice Transfers admin role.
	function setAdmin(address _admin) external onlyAdmin {
		require(_admin != address(0), "UniswapV3AssetGuard: zero admin");
		address oldAdmin = admin;
		admin = _admin;
		emit AdminUpdated(oldAdmin, _admin);
	}

	/**
	 * @notice Returns the pool’s total Uniswap V3 position value in USD.
	 * @dev For each owned NFT:
	 *      - Validates underlying tokens against the factory’s asset list.
	 *      - Pulls a fair TWAP price via UniswapV3PriceLibrary.
	 *      - Computes amounts and values of token0 and token1 and sums them.
	 * @param pool PoolLogic address
	 * @param asset The Uniswap V3 NonfungiblePositionManager (NFT manager) address
	 */
	function getBalance(address pool, address asset) public view override returns (uint256 balance) {
		address factory = IPoolLogic(pool).factory();
		INonfungiblePositionManager nonfungiblePositionManager = INonfungiblePositionManager(asset);

		UniswapV3NonfungiblePositionGuard guard = UniswapV3NonfungiblePositionGuard(
			IHasGuardInfo(factory).getContractGuard(asset)
		);

		uint256[] memory tokenIds = guard.getOwnedTokenIds(pool);
		for (uint256 i = 0; i < tokenIds.length; ++i) {
			uint256 tokenId = tokenIds[i];

			UniV3PoolParams memory params;
			(, , params.token0, params.token1, params.fee, , , , , , , ) = nonfungiblePositionManager.positions(tokenId);

			// Skip NFTs where either underlying token is not supported by the factory
			if (!IHasAssetInfo(factory).isSupportedAsset(params.token0) || !IHasAssetInfo(factory).isSupportedAsset(params.token1)) {
				continue;
			}

			// Load conservative fair price (TWAP) for the pool
			params.sqrtPriceX96 = UniswapV3PriceLibrary.assertFairPrice(
				factory,
				nonfungiblePositionManager.factory(),
				params.token0,
				params.token1,
				params.fee
			);

			// Total amounts for this NFT at current sqrtPrice
			(uint256 amount0, uint256 amount1) = _positionTotalAmounts(nonfungiblePositionManager, tokenId, params.sqrtPriceX96);

			balance = balance + _assetValue(factory, params.token0, amount0) + _assetValue(factory, params.token1, amount1);
		}
	}

	/// @dev Helper to convert a token amount to USD using the factory price + token decimals.
	function _assetValue(address factory, address token, uint256 amount) internal view returns (uint256) {
		if (IHasAssetInfo(factory).isSupportedAsset(token)) {
			uint256 tokenPriceInUsd = IHasAssetInfo(factory).getAssetPrice(token);
			uint256 dec = IERC20Extended(token).decimals();
			return (tokenPriceInUsd * amount) / (10 ** dec);
		} else {
			return 0;
		}
	}

	/// @notice Synthetic valuation uses 18 decimals.
	function getDecimals(address) external pure override returns (uint256 decimals) {
		decimals = 18;
	}

	/**
	 * @notice Builds transactions to withdraw a portion of all Uniswap V3 NFT positions.
	 * @dev For each NFT owned by the pool:
	 *      1) Decrease liquidity by `portion` of current NFT liquidity (if > 0)
	 *      2) Collect fees + decreased principals directly to the recipient.
	 * @param pool PoolLogic address
	 * @param asset Uniswap V3 NonfungiblePositionManager address
	 * @param portion Portion in 1e18 precision (1e18 = 100%)
	 * @param to Recipient of collected tokens
	 * @return withdrawAsset Always zero address for this guard (payout occurs via transactions)
	 * @return withdrawBalance Always zero for this guard (payout occurs via transactions)
	 * @return transactions Encoded calls to decreaseLiquidity and collect for each NFT
	 */
	function withdrawProcessing(
		address pool,
		address asset,
		uint256 portion,
		address to
	)
		external
		view
		virtual
		override
		returns (address withdrawAsset, uint256 withdrawBalance, MultiTransaction[] memory transactions)
	{
		INonfungiblePositionManager nonfungiblePositionManager = INonfungiblePositionManager(asset);

		address factory = IPoolLogic(pool).factory();
		UniswapV3NonfungiblePositionGuard guard = UniswapV3NonfungiblePositionGuard(
			IHasGuardInfo(factory).getContractGuard(asset)
		);

		uint256[] memory tokenIds = guard.getOwnedTokenIds(pool);

		uint256 txCount;
		transactions = new MultiTransaction[](tokenIds.length * 2);

		for (uint256 i = 0; i < tokenIds.length; ++i) {
			DecreaseLiquidity memory dec = _calcDecreaseLiquidity(nonfungiblePositionManager, tokenIds[i], portion);

			// 1) Decrease liquidity, if any
			if (dec.lpAmount != 0) {
				// Slippage protection: use TWAP-priced expected principal amounts and apply configurable bps buffer.
				uint256 amount0Min;
				uint256 amount1Min;

				if (dec.principal0 != 0) {
					amount0Min = (dec.principal0 * (BPS_DENOMINATOR - withdrawalSlippageBps)) / BPS_DENOMINATOR;
				}
				if (dec.principal1 != 0) {
					amount1Min = (dec.principal1 * (BPS_DENOMINATOR - withdrawalSlippageBps)) / BPS_DENOMINATOR;
				}

				transactions[txCount].to = address(nonfungiblePositionManager);
				transactions[txCount].txData = abi.encodeWithSelector(
					INonfungiblePositionManager.decreaseLiquidity.selector,
					INonfungiblePositionManager.DecreaseLiquidityParams(
						tokenIds[i],
						dec.lpAmount,
						amount0Min,
						amount1Min,
						block.timestamp + DEADLINE_BUFFER
					)
				);
				txCount++;
			}

			// NOTE:
			// Collect requests are intentionally capped to ensure that all owed
            // principal and only pro-rata fee amounts are paid out. The actual amounts owed are determined
            // by the pool's spot price at execution time, not by the TWAP-based estimates used
            // for decreaseLiquidity slippage protection.
			if (dec.amount0 != 0 || dec.amount1 != 0) {
				require(dec.amount0 <= type(uint128).max, "UniswapV3AssetGuard: amount0 overflow");
				require(dec.amount1 <= type(uint128).max, "UniswapV3AssetGuard: amount1 overflow");
				transactions[txCount].to = address(nonfungiblePositionManager);
				transactions[txCount].txData = abi.encodeWithSelector(
					INonfungiblePositionManager.collect.selector,
					INonfungiblePositionManager.CollectParams(
						tokenIds[i],
						to,
						 uint128(dec.amount0),
                         uint128(dec.amount1)
					)
				);
				txCount++;
			}
		}

		// Shrink array to actual size
		uint256 reduceLength = (tokenIds.length * 2) - txCount;
		assembly {
			mstore(transactions, sub(mload(transactions), reduceLength))
		}

		// No direct asset/amount return — all value is realized via the transactions above
		return (withdrawAsset, withdrawBalance, transactions);
	}

	// For stack-too-deep friendliness
	struct DecreaseLiquidity {
		uint128 lpAmount;
		uint256 amount0;
		uint256 amount1;
		// Principal amounts (TWAP-priced) used for slippage mins on decreaseLiquidity
		uint256 principal0;
		uint256 principal1;
	}

	// For stack-too-deep friendliness (fees computation only)
	struct FeeData {
		address token0;
		address token1;
		uint24 fee;
		int24 tickLower;
		int24 tickUpper;
		uint128 liquidity;
		uint256 feeGrowthInside0LastX128;
		uint256 feeGrowthInside1LastX128;
		uint128 tokensOwed0;
		uint128 tokensOwed1;
	}

	/// @dev Reads only fee-related position data into a struct (reduces locals).
	/// @dev Uses low-level staticcall + assembly writes to avoid stack-too-deep from tuple destructuring.
	function _loadFeeData(
		INonfungiblePositionManager nonfungiblePositionManager,
		uint256 tokenId
	) internal view returns (FeeData memory d) {
		// Allocate struct in memory
		d = FeeData({
			token0: address(0),
			token1: address(0),
			fee: 0,
			tickLower: 0,
			tickUpper: 0,
			liquidity: 0,
			feeGrowthInside0LastX128: 0,
			feeGrowthInside1LastX128: 0,
			tokensOwed0: 0,
			tokensOwed1: 0
		});

		(bool ok, bytes memory data) = address(nonfungiblePositionManager).staticcall(
			abi.encodeWithSelector(INonfungiblePositionManager.positions.selector, tokenId)
		);
		require(ok && data.length >= 32 * 12, "UniswapV3AssetGuard: positions() failed");

		// positions(uint256) returns 12 words:
		// 0 nonce(uint96), 1 operator(address), 2 token0, 3 token1, 4 fee(uint24), 5 tickLower(int24), 6 tickUpper(int24),
		// 7 liquidity(uint128), 8 feeGrowthInside0LastX128, 9 feeGrowthInside1LastX128, 10 tokensOwed0(uint128), 11 tokensOwed1(uint128)
		assembly {
			let p := add(data, 32)

			// token0 (word2)
			mstore(add(d, 0x00), and(mload(add(p, 0x40)), 0x000000000000000000000000ffffffffffffffffffffffffffffffffffffffff))
			// token1 (word3)
			mstore(add(d, 0x20), and(mload(add(p, 0x60)), 0x000000000000000000000000ffffffffffffffffffffffffffffffffffffffff))

			// fee (word4) - uint24
			mstore(add(d, 0x40), and(mload(add(p, 0x80)), 0xffffff))

			// tickLower (word5) - int24 (already sign-extended in ABI word)
			mstore(add(d, 0x60), mload(add(p, 0xa0)))
			// tickUpper (word6) - int24
			mstore(add(d, 0x80), mload(add(p, 0xc0)))

			// liquidity (word7) - uint128
			mstore(add(d, 0xa0), and(mload(add(p, 0xe0)), 0xffffffffffffffffffffffffffffffff))

			// feeGrowthInside0LastX128 (word8)
			mstore(add(d, 0xc0), mload(add(p, 0x100)))
			// feeGrowthInside1LastX128 (word9)
			mstore(add(d, 0xe0), mload(add(p, 0x120)))

			// tokensOwed0 (word10) - uint128
			mstore(add(d, 0x100), and(mload(add(p, 0x140)), 0xffffffffffffffffffffffffffffffff))
			// tokensOwed1 (word11) - uint128
			mstore(add(d, 0x120), and(mload(add(p, 0x160)), 0xffffffffffffffffffffffffffffffff))
		}
	}

	/// @dev Helper to reduce stack usage in _calcDecreaseLiquidity.
	function _getPositionParams(
		INonfungiblePositionManager nonfungiblePositionManager,
		uint256 tokenId
	)
		internal
		view
		returns (address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity)
	{
		(
			,
			,
			token0,
			token1,
			fee,
			tickLower,
			tickUpper,
			liquidity,
			,
			,
			,

		) = nonfungiblePositionManager.positions(tokenId);
	}

	/// @dev Time-safe pool resolution that avoids PoolAddress.computeAddress() entirely.
	function _getV3Pool(address uniswapFactory, address token0, address token1, uint24 fee) internal view returns (address pool) {
		pool = IUniswapV3Factory(uniswapFactory).getPool(token0, token1, fee);
		if (pool == address(0) || pool.code.length == 0) return address(0);
	}

	/// @dev Compute feeGrowthInside using the real pool from factory.getPool().
	function _feeGrowthInside(IUniswapV3Pool pool, int24 tickLower, int24 tickUpper) internal view returns (uint256 inside0, uint256 inside1) {
		(, int24 tickCurrent, , , , , ) = pool.slot0();

		(, , uint256 lower0, uint256 lower1, , , , ) = pool.ticks(tickLower);
		(, , uint256 upper0, uint256 upper1, , , , ) = pool.ticks(tickUpper);

		if (tickCurrent < tickLower) {
			unchecked {
				inside0 = lower0 - upper0;
				inside1 = lower1 - upper1;
			}
		} else if (tickCurrent < tickUpper) {
			uint256 global0 = pool.feeGrowthGlobal0X128();
			uint256 global1 = pool.feeGrowthGlobal1X128();
			unchecked {
				inside0 = global0 - lower0 - upper0;
				inside1 = global1 - lower1 - upper1;
			}
		} else {
			unchecked {
				inside0 = upper0 - lower0;
				inside1 = upper1 - lower1;
			}
		}
	}

	/// @dev Computes total uncollected fees for a position using factory.getPool() (no PoolAddress.computeAddress()).
	function _positionFees(INonfungiblePositionManager nonfungiblePositionManager, uint256 tokenId)
		internal
		view
		returns (uint256 feeAmount0, uint256 feeAmount1)
	{
		FeeData memory d = _loadFeeData(nonfungiblePositionManager, tokenId);

		address poolAddr = _getV3Pool(nonfungiblePositionManager.factory(), d.token0, d.token1, d.fee);
		if (poolAddr == address(0)) return (0, 0);

		(uint256 inside0, uint256 inside1) = _feeGrowthInside(IUniswapV3Pool(poolAddr), d.tickLower, d.tickUpper);

		uint256 delta0;
		uint256 delta1;
		unchecked {
			delta0 = inside0 - d.feeGrowthInside0LastX128;
			delta1 = inside1 - d.feeGrowthInside1LastX128;
		}

		feeAmount0 = FullMath.mulDiv(delta0, d.liquidity, 1 << 128) + uint256(d.tokensOwed0);
		feeAmount1 = FullMath.mulDiv(delta1, d.liquidity, 1 << 128) + uint256(d.tokensOwed1);
	}

	/// @dev Replacement for PositionValue.total() that uses factory.getPool() rather than PoolAddress.computeAddress().
	function _positionTotalAmounts(INonfungiblePositionManager nonfungiblePositionManager, uint256 tokenId, uint160 sqrtPriceX96)
		internal
		view
		returns (uint256 amount0, uint256 amount1)
	{
		(
			,
			,
			,
			,
			,
			int24 tickLower,
			int24 tickUpper,
			uint128 liquidity,
			,
			,
			,

		) = nonfungiblePositionManager.positions(tokenId);

		// Principal amounts for full liquidity at sqrtPriceX96
		(uint256 principal0, uint256 principal1) = LiquidityAmounts.getAmountsForLiquidity(
			sqrtPriceX96,
			TickMath.getSqrtRatioAtTick(tickLower),
			TickMath.getSqrtRatioAtTick(tickUpper),
			liquidity
		);

		// Fees (uncollected) using the real pool from getPool()
		(uint256 fee0, uint256 fee1) = _positionFees(nonfungiblePositionManager, tokenId);

		amount0 = principal0 + fee0;
		amount1 = principal1 + fee1;
	}

	/// @dev Helper to reduce stack usage in _calcDecreaseLiquidity.
	function _calcAmountsIncludingFees(
		INonfungiblePositionManager nonfungiblePositionManager,
		uint256 tokenId,
		uint256 portion,
		uint256 principal0,
		uint256 principal1
	) internal view returns (uint256 amount0, uint256 amount1) {
		// Include proportional share of uncollected fees
	    (uint256 feeAmount0, uint256 feeAmount1) = _positionFees(nonfungiblePositionManager, tokenId);
    
		amount0 = principal0 + ((feeAmount0 * portion) / PORTION_DENOMINATOR );
		amount1 = principal1 + ((feeAmount1 * portion) / PORTION_DENOMINATOR );
	}

	/**
	 * @notice Calculates the decreaseLiquidity share and expected amounts for an NFT.
	 * @param nonfungiblePositionManager Uniswap V3 position manager
	 * @param tokenId NFT position id
	 * @param portion Portion in 1e18 precision
	 */
	function _calcDecreaseLiquidity(
		INonfungiblePositionManager nonfungiblePositionManager,
		uint256 tokenId,
		uint256 portion
	) internal view returns (DecreaseLiquidity memory dec) {
		(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity) =
			_getPositionParams(nonfungiblePositionManager, tokenId);

		// LP portion to remove
		dec.lpAmount = _calcLiquidityPortion(liquidity, portion);
		// Current pool sqrtPrice
		// NOTE: Use TWAP to mitigate spot price manipulation during withdrawal construction.
		address pool = IUniswapV3Factory(nonfungiblePositionManager.factory()).getPool(token0, token1, fee);
		require(pool != address(0), "UniswapV3AssetGuard: pool not found");

		(int24 twapTick, ) = OracleLibrary.consult(pool, withdrawalTwapWindow);
		uint160 twapSqrtPriceX96 = TickMath.getSqrtRatioAtTick(twapTick);
		(uint160 spotSqrtPriceX96, , , , , , ) = IUniswapV3Pool(pool).slot0();
		_checkSpotPriceDeviation(spotSqrtPriceX96, twapSqrtPriceX96);

		// Amounts corresponding to the lp portion
		(dec.principal0, dec.principal1) = LiquidityAmounts.getAmountsForLiquidity(
			spotSqrtPriceX96,
			TickMath.getSqrtRatioAtTick(tickLower),
			TickMath.getSqrtRatioAtTick(tickUpper),
			dec.lpAmount
		);

		// Include proportional share of uncollected fees
		(dec.amount0, dec.amount1) =
			_calcAmountsIncludingFees(nonfungiblePositionManager, tokenId, portion, dec.principal0, dec.principal1);
	}

    

    function _calcLiquidityPortion(uint128 liquidity, uint256 portion)
	    internal pure returns (uint128) {
		uint256 lpAmount = (uint256(liquidity) * portion) / PORTION_DENOMINATOR;
		require(lpAmount <= type(uint128).max, "UniswapV3AssetGuard: lpAmount overflow");
		return uint128(lpAmount);
	}

	function _checkSpotPriceDeviation(uint160 spotSqrtPriceX96, uint160 twapSqrtPriceX96)
	    internal view returns (bool ) {
	    uint256 deviation = spotSqrtPriceX96 > twapSqrtPriceX96 
		? uint256(spotSqrtPriceX96) - uint256(twapSqrtPriceX96 )
		: uint256(twapSqrtPriceX96) - uint256(spotSqrtPriceX96);
		require(deviation * BPS_DENOMINATOR / uint256(twapSqrtPriceX96 ) <= withdrawalSlippageBps,
		    "UniswapV3AssetGuard: spot deviation too high");
		return true;
	}
		
}
