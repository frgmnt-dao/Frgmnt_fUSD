// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IHasAssetInfo.sol";
import "../interfaces/IHasGuardInfo.sol";
import "../interfaces/IPoolLogic.sol";
import "../interfaces/IERC20Extended.sol";

import "../guards/contractGuards/uniswapV3/UniswapV3NonfungiblePositionGuard.sol";
import "@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol";

/// @notice Test-only stub that mimics the behaviour of UniswapV3AssetGuard
/// without calling Uniswap/PositionValue/LiquidityAmounts.
/// @dev Used purely in tests to avoid requiring full Uniswap V3 core implementation.
contract TestUniswapV3AssetGuardStubbed {
	// ------------------------------------------------------------------
	// Structs (mirroring ERC20Guard / UniswapV3AssetGuard)
	// ------------------------------------------------------------------

	struct MultiTransaction {
		address to;
		bytes txData;
	}

	struct DecreaseLiquidity {
		uint128 lpAmount;
		uint256 amount0;
		uint256 amount1;
	}

	// ------------------------------------------------------------------
	// Synthetic state for testing
	// ------------------------------------------------------------------

	/// @notice For each pool, which NFT tokenIds it owns.
	mapping(address => uint256[]) private _ownedTokenIdsOverride;

	/// @notice For each tokenId, which underlying tokens it represents.
	mapping(uint256 => address) public token0Override;
	mapping(uint256 => address) public token1Override;

	/// @notice For each tokenId, the "current" token0/token1 amounts used by getBalance().
	mapping(uint256 => uint256) public amount0Override;
	mapping(uint256 => uint256) public amount1Override;

	/// @notice For each tokenId, preconfigured decreaseLiquidity result used by withdrawProcessing().
	mapping(uint256 => DecreaseLiquidity) public decOverride;

	// ------------------------------------------------------------------
	// Test helpers to configure stub behaviour
	// ------------------------------------------------------------------

	/// @notice Configure which tokenIds belong to a pool (mirrors guard.getOwnedTokenIds).
	function setOwnedTokenIds(address pool, uint256[] calldata ids) external {
		_ownedTokenIdsOverride[pool] = ids;
	}

	/// @notice Configure synthetic NFT position data for getBalance().
	function setPositionData(
		uint256 tokenId,
		address token0,
		address token1,
		uint256 amount0,
		uint256 amount1
	) external {
		token0Override[tokenId] = token0;
		token1Override[tokenId] = token1;
		amount0Override[tokenId] = amount0;
		amount1Override[tokenId] = amount1;
	}

	/// @notice Configure synthetic DecreaseLiquidity data for withdrawProcessing().
	function setDecData(uint256 tokenId, uint128 lpAmount, uint256 amount0, uint256 amount1) external {
		decOverride[tokenId] = DecreaseLiquidity({ lpAmount: lpAmount, amount0: amount0, amount1: amount1 });
	}

	// ------------------------------------------------------------------
	// Public API (mirroring the guard interface)
	// ------------------------------------------------------------------

	/// @notice Synthetic valuation uses 18 decimals (same as real guard).
	function getDecimals(address) external pure returns (uint256 decimals) {
		decimals = 18;
	}

	/// @notice Internal helper copied from UniswapV3AssetGuard._assetValue logic.
	function _assetValue(address factory, address token, uint256 amount) internal view returns (uint256) {
		if (IHasAssetInfo(factory).validateAsset(token)) {
			uint256 tokenPriceInUsd = IHasAssetInfo(factory).getAssetPrice(token);
			uint256 dec = IERC20Extended(token).decimals();
			return (tokenPriceInUsd * amount) / (10 ** dec);
		} else {
			return 0;
		}
	}

	/// @notice Stubbed getBalance:
	/// - Uses IPoolLogic(pool).factory() to get factory
	/// - Checks IHasAssetInfo(factory).isValidAsset for token0/token1
	/// - Uses _assetValue to convert token amounts to USD
	/// - Aggregates over _ownedTokenIdsOverride[pool]
	function getBalance(address pool, address /*asset*/) public view returns (uint256 balance) {
		address factory = IPoolLogic(pool).factory();

		uint256[] memory tokenIds = _ownedTokenIdsOverride[pool];
		for (uint256 i = 0; i < tokenIds.length; ++i) {
			uint256 tokenId = tokenIds[i];

			address token0 = token0Override[tokenId];
			address token1 = token1Override[tokenId];

			// Skip NFTs where either underlying token is not supported by the factory
			if (!IHasAssetInfo(factory).validateAsset(token0) || !IHasAssetInfo(factory).validateAsset(token1)) {
				continue;
			}

			uint256 amount0 = amount0Override[tokenId];
			uint256 amount1 = amount1Override[tokenId];

			balance = balance + _assetValue(factory, token0, amount0) + _assetValue(factory, token1, amount1);
		}
	}

	/// @notice Stubbed withdrawProcessing:
	/// - Uses IHasGuardInfo(factory).getContractGuard(asset) to find the NFT guard
	/// - Reads tokenIds via guard.getOwnedTokenIds(pool)
	/// - Uses preconfigured decOverride[tokenId] instead of _calcDecreaseLiquidity
	/// - Builds decreaseLiquidity + collect txs and shrinks the array
	function withdrawProcessing(
		address pool,
		address asset,
		uint256 /*portion*/,
		address to
	) external view returns (address withdrawAsset, uint256 withdrawBalance, MultiTransaction[] memory transactions) {
		INonfungiblePositionManager nonfungiblePositionManager = INonfungiblePositionManager(asset);

		address factory = IPoolLogic(pool).factory();
		UniswapV3NonfungiblePositionGuard guard = UniswapV3NonfungiblePositionGuard(
			IHasGuardInfo(factory).getContractGuard(asset)
		);

		uint256[] memory tokenIds = guard.getOwnedTokenIds(pool);

		uint256 txCount;
		transactions = new MultiTransaction[](tokenIds.length * 2);

		for (uint256 i = 0; i < tokenIds.length; ++i) {
			uint256 tokenId = tokenIds[i];

			// Use preconfigured decOverride instead of calling _calcDecreaseLiquidity
			DecreaseLiquidity memory dec = decOverride[tokenId];

			// 1) Decrease liquidity, if any
			if (dec.lpAmount != 0) {
				transactions[txCount].to = address(nonfungiblePositionManager);
				transactions[txCount].txData = abi.encodeWithSelector(
					INonfungiblePositionManager.decreaseLiquidity.selector,
					INonfungiblePositionManager.DecreaseLiquidityParams(tokenId, dec.lpAmount, 0, 0, type(uint256).max)
				);
				txCount++;
			}

			// 2) Collect fees + principals to `to`, if any
			if (dec.amount0 != 0 || dec.amount1 != 0) {
				transactions[txCount].to = address(nonfungiblePositionManager);
				transactions[txCount].txData = abi.encodeWithSelector(
					INonfungiblePositionManager.collect.selector,
					INonfungiblePositionManager.CollectParams(tokenId, to, uint128(dec.amount0), uint128(dec.amount1))
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
}
