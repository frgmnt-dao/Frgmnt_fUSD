// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal mock of PoolLogic for UniswapV3NonfungiblePositionGuard tests.
///         Exposes `factory()` (for IPoolLogic) and a helper to call afterTxGuard
///         with msg.sender == this.
contract MockPoolLogicV3Guard {
	address public _factory;

	constructor(address factory_) {
		_factory = factory_;
	}

	/// @dev Used by UniswapV3PriceLibrary via IPoolLogic(pool).factory()
	function factory() external view returns (address) {
		return _factory;
	}

	/// @notice Helper used in tests to call guard.afterTxGuard with msg.sender == poolLogic.
	function callAfterTxGuard(address guard, address poolManagerLogic, address to, bytes memory data) external {
		(bool ok, ) = guard.call(
			abi.encodeWithSignature("afterTxGuard(address,address,bytes)", poolManagerLogic, to, data)
		);
		require(ok, "MockPoolLogicV3Guard: afterTxGuard call failed");
	}
}
