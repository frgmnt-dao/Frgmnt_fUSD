// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IAssetGuard } from "../interfaces/guards/IAssetGuard.sol";
import { IMorphoBlueLendingPoolAssetGuard } from "../interfaces/guards/IMorphoBlueLendingPoolAssetGuard.sol";
import { IPoolManagerLogic } from "../interfaces/IPoolManagerLogic.sol";

/// @title PoolLogicFlashloanMorpho
/// @notice Stateless Morpho Blue flashloan callback logic
abstract contract PoolLogicFlashloanMorpho {
	/// @dev MUST be implemented by PoolLogic
	function _isAllowedCallbackSender(address sender) internal view virtual returns (bool);

	/// @dev MUST be implemented by PoolLogic
	function _getPoolManagerLogic() internal view virtual returns (address);

	function _executeMorphoFlashloan(
		uint256  repayAmount,
		bytes calldata data
	) internal {
		require(_isAllowedCallbackSender(msg.sender), "callback sender not allowed");
		require(data.length >= 64, "bad morpho data");

		address pml = _getPoolManagerLogic();
		address guard = IPoolManagerLogic(pml).getAssetGuard(msg.sender);
		require(guard != address(0), "invalid morpho guard");

		require(msg.sender == _validateMorphoGuard(guard), "invalid morpho sender");

		(address repayAsset, bytes memory innerParams) = abi.decode(data, (address, bytes));
		require(repayAsset != address(0), "repayAsset=0");

		uint256 balanceBefore = IERC20(repayAsset).balanceOf(address(this));

		IAssetGuard.MultiTransaction[] memory txs =
			IMorphoBlueLendingPoolAssetGuard(guard).flashloanProcessing(
				address(this),
				repayAsset,
				repayAmount,
				innerParams
			);

		for (uint256 i = 0; i < txs.length; ++i) {
			(bool success, ) = txs[i].to.call(txs[i].txData);
			require(success, "tx failed");
		}

		require(
			IERC20(repayAsset).balanceOf(address(this)) >= balanceBefore,
			"high slippage"
		);
	}

	// Guard MUST implement IMorphoBlueLendingPoolAssetGuard.
    // Using staticcall to avoid DoS if the guard is misconfigured.

	function _validateMorphoGuard(address guard) internal view returns (address) {
        (bool ok, bytes memory data) = guard.staticcall(
        abi.encodeWithSelector(
            IMorphoBlueLendingPoolAssetGuard.morpho.selector)
        );

        require(ok && data.length == 32, "invalid morpho guard");
        return abi.decode(data, (address));
    }

}
