// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { PoolTxExecutor } from "./PoolTxExecutor.sol";

/// @title PoolLogicFlashloanMorpho
/// @notice Stateless Morpho Blue flashloan callback logic
/// @dev The callback body itself lives in PoolTxExecutor.executeMorphoFlashloan() (an
///      externally-linked library reached via DELEGATECALL, so it still runs in the pool's own
///      context) — moved there verbatim purely to recover EIP-170 bytecode headroom on PoolLogic.
///      Its callback-sender check calls IPoolManagerLogic.getAllowedCallbackSenders() directly,
///      which is exactly what PoolLogic's _isAllowedCallbackSender() override does.
abstract contract PoolLogicFlashloanMorpho {
    /// @dev MUST be implemented by PoolLogic
    function _isAllowedCallbackSender(address sender) internal view virtual returns (bool);

    /// @dev MUST be implemented by PoolLogic
    function _getPoolManagerLogic() internal view virtual returns (address);

    function _executeMorphoFlashloan(uint256 repayAmount, bytes calldata data) internal {
        PoolTxExecutor.executeMorphoFlashloan(_getPoolManagerLogic(), repayAmount, data);
    }
}
