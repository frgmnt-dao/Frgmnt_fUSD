pragma solidity ^0.8.24;

import "../../utils/TxDataUtils.sol";
import "../../interfaces/guards/IAssetGuard.sol";
import "../../interfaces/guards/IGuard.sol";

/**
 * @title Frgmnt Closed Asset Guard (Base)
 * @notice Base class for assets that should not be freely transferable via the router.
 * @dev
 * - Implements the IGuard + IAssetGuard interfaces.
 * - `txGuard` is a no-op (disallows arbitrary calls by returning txType=0).
 * - `getBalance` MUST be implemented by children to report pool-held balance.
 * - `removeAssetCheck` ensures an asset can be removed only when balance is zero.
 * @custom:project Frgmnt
 */
abstract contract ClosedAssetGuard is TxDataUtils, IGuard, IAssetGuard {
	/**
	 * @notice Closed guard: does not authorize any transaction itself.
	 * @dev Children typically pair with a separate ContractGuard for allowed calls.
	 * @return txType Always 0 (no specific tx classification).
	 * @return isPublic Always false.
	 */
	function txGuard(
		address,
		address,
		bytes calldata
	) external pure virtual override returns (uint16 txType, bool isPublic) {
		return (txType, false);
	}

	/**
	 * @notice Returns the pool's balance for the given asset.
	 * @dev Must be implemented by the concrete guard.
	 */
	function getBalance(address, address) public view virtual override returns (uint256) {
		revert("ClosedAssetGuard: not implemented");
	}

	/**
	 * @notice Ensures the asset can be removed only when its balance is zero.
	 */
	function removeAssetCheck(address pool, address asset) public view virtual override {
		uint256 balance = getBalance(pool, asset);
		require(balance == 0, "ClosedAssetGuard: non-empty asset");
	}
}
