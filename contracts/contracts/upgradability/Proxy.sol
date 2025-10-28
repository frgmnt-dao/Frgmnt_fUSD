// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Proxy
/// @dev Minimal EIP-1967-compatible delegate proxy core.
abstract contract Proxy {
  /// @notice Fallback function delegates to implementation.
  fallback() external payable { _fallback(); }

  /// @notice Receive function delegates to implementation.
  receive() external payable { _fallback(); }

  /// @return impl Address of the implementation.
  function _implementation() internal view virtual returns (address);

  /// @notice Delegates execution to an implementation contract.
  function _delegate(address implementation) internal {
    assembly {
      calldatacopy(0, 0, calldatasize())
      let result := delegatecall(gas(), implementation, 0, calldatasize(), 0, 0)
      returndatacopy(0, 0, returndatasize())
      switch result
      case 0 { revert(0, returndatasize()) }
      default { return(0, returndatasize()) }
    }
  }

  /// @notice Hook called before delegating.
  function _willFallback() internal virtual {}

  /// @notice fallback implementation.
  function _fallback() internal {
    _willFallback();
    _delegate(_implementation());
  }
}
