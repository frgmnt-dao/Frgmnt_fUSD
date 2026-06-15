// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Generic mock that can call txGuard and afterTxGuard on behalf of itself,
///         so msg.sender == address(this) == poolLogic inside guards.
contract MockPoolLogicCaller {
    /// @notice Call guard.txGuard from this contract's address.
    function callTxGuard(
        address guard,
        address poolManagerLogic,
        address to,
        bytes calldata data
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
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
        (txType, isPublic) = abi.decode(result, (uint16, bool));
    }

    /// @notice Call guard.afterTxGuard from this contract's address.
    function callAfterTxGuard(
        address guard,
        address poolManagerLogic,
        address to,
        bytes calldata data
    ) external {
        (bool ok, bytes memory result) = guard.call(
            abi.encodeWithSignature(
                "afterTxGuard(address,address,bytes)",
                poolManagerLogic,
                to,
                data
            )
        );
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }
}
