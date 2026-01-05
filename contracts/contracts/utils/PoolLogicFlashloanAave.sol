// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { IAssetGuard } from "../interfaces/guards/IAssetGuard.sol";
import { IAaveLendingPoolAssetGuard } from "../interfaces/guards/IAaveLendingPoolAssetGuard.sol";
import { IPoolManagerLogic } from "../interfaces/IPoolManagerLogic.sol";

/// @title PoolLogicFlashloanAave
/// @notice Isolated Aave flashloan execution logic (stateless)
/// @dev
///  - NO storage declared
///  - Executes in PoolLogic context via inheritance
///  - Uses hook-based access to PoolLogic storage
abstract contract PoolLogicFlashloanAave {
	/// @dev MUST be implemented by PoolLogic
	function _getPoolManagerLogic()
		internal
		view
		virtual
		returns (address);

	/// @notice Internal execution of Aave flashloan callback
	/// @dev Logic extracted verbatim from original PoolLogic.executeOperation
	function _executeAaveFlashloan(
		address[] calldata assets,
		uint256[] calldata amounts,
		uint256[] calldata premiums,
		address initiator,
		bytes calldata params
	) internal returns (bool) {
		require(
			initiator == address(this),
			"only pool flash loan origin"
		);
		require(
			assets.length == 1 &&
				amounts.length == 1 &&
				premiums.length == 1,
			"single-asset only"
		);

		// --------------------------------------------------
		// Cache calldata to reduce stack pressure
		// --------------------------------------------------
		address asset = assets[0];
		uint256 amount = amounts[0];
		uint256 premium = premiums[0];

		address pml = _getPoolManagerLogic();

		// Resolve the Aave lending pool guard
		address guard =
			IPoolManagerLogic(pml)
				.getContractGuard(msg.sender);

		require(guard != address(0), "invalid lending pool");

		require(
			msg.sender ==
				IAaveLendingPoolAssetGuard(guard)
					.aaveLendingPool(),
			"invalid lending pool"
		);

		uint256 withdrawAssetBalanceBefore =
			IERC20(asset).balanceOf(address(this));

		IAssetGuard.MultiTransaction[] memory transactions =
			IAaveLendingPoolAssetGuard(guard)
				.flashloanProcessing(
					address(this),
					asset,
					amount,
					premium,
					params
				);

		for (uint256 i = 0; i < transactions.length; ++i) {
			(bool success, ) =
				transactions[i].to.call(
					transactions[i].txData
				);
			require(success, "tx failed");
		}

		// Invariant:
		// flashloan repayment must not steal pool assets
		require(
			withdrawAssetBalanceBefore + premium <=
				IERC20(asset).balanceOf(address(this)),
			"high slippage"
		);

		return true;
	}
}
