// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol";
import "@uniswap/v3-periphery/contracts/interfaces/IMulticall.sol";

import "../../../utils/TxDataUtils.sol";
import "../../../utils/UniswapV3PriceLibrary.sol";
import "../../../utils/tracker/NftTrackerStorage.sol";
import "../../../interfaces/guards/ITxTrackingGuard.sol";
import "../../../interfaces/guards/IGuard.sol";
import "../../../interfaces/IPoolManagerLogic.sol";
import "../../../interfaces/IPoolLogic.sol";
import "../../../interfaces/IHasSupportedAsset.sol";

/**
 * @title Frgmnt Uniswap V3 Nonfungible Position Guard
 * @notice Validates & tracks Uniswap V3 LP NFT operations for a pool.
 * @dev Supports: mint, increaseLiquidity, decreaseLiquidity, burn, collect, multicall.
 *      - Enforces asset allowlists and recipient = pool
 *      - Checks Uniswap TWAP “fair price” on mint/increase
 *      - Tracks owned NFT tokenIds in an external tracker (add on mint, remove on burn)
 *      - Limits max number of positions per pool via `uniV3PositionsLimit`
 * @custom:project Frgmnt
 */
contract UniswapV3NonfungiblePositionGuard is TxDataUtils, ITxTrackingGuard {
	event Mint(
		address fundAddress,
		address token0,
		address token1,
		uint24 fee,
		int24 tickLower,
		int24 tickUpper,
		uint256 amount0Desired,
		uint256 amount1Desired,
		uint256 amount0Min,
		uint256 amount1Min,
		uint256 time
	);
	event IncreaseLiquidity(
		address fundAddress,
		uint256 tokenId,
		uint256 amount0Desired,
		uint256 amount1Desired,
		uint256 amount0Min,
		uint256 amount1Min,
		uint256 time
	);
	event DecreaseLiquidity(
		address fundAddress,
		uint256 tokenId,
		uint128 liquidity,
		uint256 amount0Min,
		uint256 amount1Min,
		uint256 time
	);
	event Burn(address fundAddress, uint256 tokenId, uint256 time);
	event Collect(address fundAddress, uint256 tokenId, uint128 amount0Max, uint128 amount1Max, uint256 time);

	// FRG-24: Emit events for runtime tracking state changes
	event PositionTracked(address indexed fundAddress, address indexed positionManager, uint256 indexed tokenId);
	event PositionUntracked(address indexed fundAddress, address indexed positionManager, uint256 indexed tokenId);

	bytes32 public constant NFT_TYPE = keccak256("UNISWAP_NFT_TYPE");
	address public immutable nftTracker;

	/// @notice Maximum allowed Uniswap V3 positions per pool.
	uint256 public uniV3PositionsLimit;

	bool public override isTxTrackingGuard = true;

	constructor(uint256 _uniV3PositionsLimit, address _nftTracker) {
		require(_nftTracker != address(0), "Frgmnt: invalid tracker.");
		uniV3PositionsLimit = _uniV3PositionsLimit;
		nftTracker = _nftTracker;
	}

	/// @notice Return all tracked NFT tokenIds owned by a pool.
	function getOwnedTokenIds(address poolLogic) public view returns (uint256[] memory tokenIds) {
		bytes[] memory data = NftTrackerStorage(nftTracker).getAllData(NFT_TYPE, poolLogic);
		tokenIds = new uint256[](data.length);
		for (uint256 i = 0; i < data.length; i++) {
			tokenIds[i] = abi.decode(data[i], (uint256));
		}
	}

	function _isValidOwnedTokenId(
		address poolLogic,
		uint256 tokenId
	) internal view returns (bool isValid, uint256 index) {
		uint256[] memory tokenIds = getOwnedTokenIds(poolLogic);
		uint256 i;
		for (i = 0; i < tokenIds.length; i++) {
			if (tokenId == tokenIds[i]) {
				return (true, i);
			}
		}
		return (false, i);
	}

	/**
	 * @notice Transaction guard for Uniswap V3 Nonfungible Position Manager.
	 * @param _poolManagerLogic Pool manager logic
	 * @param to Position manager address
	 * @param data Encoded call data
	 * @return txType Encoded transaction type for PoolLogic
	 * @return isPublic Always false
	 */
	function txGuard(
		address _poolManagerLogic,
		address to,
		bytes memory data
	) public override returns (uint16 txType, bool) {
		bytes4 method = getMethod(data);
		INonfungiblePositionManager nonfungiblePositionManager = INonfungiblePositionManager(to);

		IPoolManagerLogic poolManagerLogic = IPoolManagerLogic(_poolManagerLogic);
		IHasSupportedAsset poolManagerLogicAssets = IHasSupportedAsset(_poolManagerLogic);
		address pool = poolManagerLogic.poolLogic();

		if (method == INonfungiblePositionManager.mint.selector) {
			INonfungiblePositionManager.MintParams memory param = abi.decode(
				getParams(data),
				(INonfungiblePositionManager.MintParams)
			);

			require(poolManagerLogicAssets.isSupportedAsset(param.token0), "Frgmnt: unsupported token0");
			require(poolManagerLogicAssets.isSupportedAsset(param.token1), "Frgmnt: unsupported token1");
			require(poolManagerLogicAssets.isSupportedAsset(to), "Frgmnt: Uniswap position mgr not enabled");
			require(pool == param.recipient, "Frgmnt: recipient != pool");

			UniswapV3PriceLibrary.assertFairPrice(
				IPoolLogic(pool).factory(),
				nonfungiblePositionManager.factory(),
				param.token0,
				param.token1,
				param.fee
			);

			emit Mint(
				poolManagerLogic.poolLogic(),
				param.token0,
				param.token1,
				param.fee,
				param.tickLower,
				param.tickUpper,
				param.amount0Desired,
				param.amount1Desired,
				param.amount0Min,
				param.amount1Min,
				block.timestamp
			);

			txType = 20; // Mint
		} else if (method == INonfungiblePositionManager.increaseLiquidity.selector) {
			INonfungiblePositionManager.IncreaseLiquidityParams memory param = abi.decode(
				getParams(data),
				(INonfungiblePositionManager.IncreaseLiquidityParams)
			);
            // Validate token id is tracked
			(bool isValidTokenId, ) = _isValidOwnedTokenId(pool, param.tokenId);
			require(isValidTokenId, "Frgmnt: position not tracked");

			(, , address token0, address token1, uint24 fee, , , , , , , ) = nonfungiblePositionManager.positions(
				param.tokenId
			);

			UniswapV3PriceLibrary.assertFairPrice(
				IPoolLogic(pool).factory(),
				nonfungiblePositionManager.factory(),
				token0,
				token1,
				fee
			);

			emit IncreaseLiquidity(
				poolManagerLogic.poolLogic(),
				param.tokenId,
				param.amount0Desired,
				param.amount1Desired,
				param.amount0Min,
				param.amount1Min,
				block.timestamp
			);

			txType = 21; // IncreaseLiquidity
		} else if (method == INonfungiblePositionManager.decreaseLiquidity.selector) {
			INonfungiblePositionManager.DecreaseLiquidityParams memory param = abi.decode(
				getParams(data),
				(INonfungiblePositionManager.DecreaseLiquidityParams)
			);

			(bool isValidTokenId, ) = _isValidOwnedTokenId(pool, param.tokenId);
			require(isValidTokenId, "Frgmnt: position not tracked");

			emit DecreaseLiquidity(
				poolManagerLogic.poolLogic(),
				param.tokenId,
				param.liquidity,
				param.amount0Min,
				param.amount1Min,
				block.timestamp
			);

			txType = 22; // DecreaseLiquidity
		} else if (method == INonfungiblePositionManager.burn.selector) {
			uint256 tokenId = abi.decode(getParams(data), (uint256));

			(bool isValidTokenId, ) = _isValidOwnedTokenId(pool, tokenId);
			require(isValidTokenId, "Frgmnt: position not tracked");

			emit Burn(poolManagerLogic.poolLogic(), tokenId, block.timestamp);
			txType = 23; // Burn
		} else if (method == INonfungiblePositionManager.collect.selector) {
			INonfungiblePositionManager.CollectParams memory param = abi.decode(
				getParams(data),
				(INonfungiblePositionManager.CollectParams)
			);

			(bool isValidTokenId, ) = _isValidOwnedTokenId(pool, param.tokenId);
			require(isValidTokenId, "Frgmnt: position not tracked");

			(, , address token0, address token1, , , , , , , , ) =
				nonfungiblePositionManager.positions(param.tokenId);

			require(poolManagerLogicAssets.isSupportedAsset(token0), "Frgmnt: unsupported token0");
			require(poolManagerLogicAssets.isSupportedAsset(token1), "Frgmnt: unsupported token1");
			require(pool == param.recipient, "Frgmnt: recipient != pool");

			emit Collect(
				poolManagerLogic.poolLogic(),
				param.tokenId,
				param.amount0Max,
				param.amount1Max,
				block.timestamp
			);

			txType = 24; // Collect
		} else if (method == IMulticall.multicall.selector) {
			bytes[] memory params = abi.decode(getParams(data), (bytes[]));
			for (uint256 i = 0; i < params.length; i++) {
				(txType, ) = txGuard(_poolManagerLogic, to, params[i]);
				require(txType > 0, "Frgmnt: invalid tx in multicall");
			}
			txType = 25; // Multicall
		}

		return (txType, false);
	}

	/// @notice Called after execution to update NFT tracking (mint/burn) and enforce limits.
	function afterTxGuard(address poolManagerLogic, address to, bytes memory data) public virtual override {
		afterTxGuardHandle(poolManagerLogic, to, data);
	}

	function afterTxGuardHandle(
		address poolManagerLogic,
		address to,
		bytes memory data
	) internal returns (bool isMintOrBurn) {
		address poolLogic = IPoolManagerLogic(poolManagerLogic).poolLogic();
		require(msg.sender == poolLogic, "Frgmnt: not pool logic");

		bytes4 method = getMethod(data);
		INonfungiblePositionManager nonfungiblePositionManager = INonfungiblePositionManager(to);

		if (method == INonfungiblePositionManager.mint.selector) {
			uint256 index = nonfungiblePositionManager.totalSupply();
			// Underflow revert on index-1 if index == 0 is intentional to prevent stale state
			uint256 tokenId = nonfungiblePositionManager.tokenByIndex(index - 1);

			NftTrackerStorage(nftTracker).addData(
				to,
				NFT_TYPE,
				poolLogic,
				abi.encode(tokenId)
			);

			emit PositionTracked(poolLogic, to, tokenId);

			require(
				NftTrackerStorage(nftTracker).getDataCount(NFT_TYPE, poolLogic) <= uniV3PositionsLimit,
				"Frgmnt: too many Uniswap V3 positions"
			);

			return true;
		} else if (method == INonfungiblePositionManager.burn.selector) {
			uint256 tokenId = abi.decode(getParams(data), (uint256));

			(bool isValidTokenId, uint256 i) = _isValidOwnedTokenId(poolLogic, tokenId);
			require(isValidTokenId, "Frgmnt: position not tracked");

			NftTrackerStorage(nftTracker).removeData(to, NFT_TYPE, poolLogic, i);

			emit PositionUntracked(poolLogic, to, tokenId);

			return true;
		} else if (method == IMulticall.multicall.selector) {
			bytes[] memory params = abi.decode(getParams(data), (bytes[]));

			bool includeMintOrBurn;
			for (uint256 i = 0; i < params.length; i++) {
				if (afterTxGuardHandle(poolManagerLogic, to, params[i])) {
					// Only one mint OR one burn is allowed per multicall for safety
					require(!includeMintOrBurn, "Frgmnt: invalid multicall");
					includeMintOrBurn = true;
				}
			}

			return includeMintOrBurn;
		}

		return false;
	}
}
