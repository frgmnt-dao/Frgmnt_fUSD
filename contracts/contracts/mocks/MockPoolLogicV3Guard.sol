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
    function callAfterTxGuard(
        address guard,
        address poolManagerLogic,
        address to,
        bytes memory data
    ) external {
        (bool ok, ) = guard.call(
            abi.encodeWithSignature(
                "afterTxGuard(address,address,bytes)",
                poolManagerLogic,
                to,
                data
            )
        );
        require(ok, "MockPoolLogicV3Guard: afterTxGuard call failed");
    }

    /// @notice Helper used in tests to call guard.txGuard with msg.sender == poolLogic.
    /// @dev Returns the raw ABI-encoded (uint16 txType, bool isPublic).
    function callTxGuard(
        address guard,
        address poolManagerLogic,
        address to,
        bytes memory data
    ) external returns (uint16 txType, bool isPublic) {
        (bool ok, bytes memory result) = guard.call(
            abi.encodeWithSignature(
                "txGuard(address,address,bytes)",
                poolManagerLogic,
                to,
                data
            )
        );
        if (!ok) {
            // Bubble up the revert reason
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
        (txType, isPublic) = abi.decode(result, (uint16, bool));
    }
}
