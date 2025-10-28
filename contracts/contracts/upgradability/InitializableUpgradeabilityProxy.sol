// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseUpgradeabilityProxy} from "./BaseUpgradeabilityProxy.sol";
import {AddressHelper} from "../utils/AddressHelper.sol";

/// @title InitializableUpgradeabilityProxy
/// @dev Writes the *factory* into the EIP-1967 slot, stores proxyType, then delegatecalls `_data`.
contract InitializableUpgradeabilityProxy is BaseUpgradeabilityProxy {
  using AddressHelper for address;

  /// @param _factory Address of the ProxyFactory (stores the registry of logic ids).
  /// @param _data Initialization calldata that will be delegatecalled into the implementation.
  /// @param _proxyType Logic id to resolve via factory.getLogic(proxyType).
  function initialize(address _factory, bytes memory _data, uint8 _proxyType) public payable {
    require(_implementation() == address(0), "Impl not zero");
    // Sanity: EIP-1967 impl slot constant must be correct
    assert(
      IMPLEMENTATION_SLOT == bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
    );

    // Store the factory in the impl slot (pattern used by this codebase)
    _setImplementation(_factory);
    _setProxyType(_proxyType);

    if (_data.length > 0) {
      // delegatecall into the resolved implementation (via AddressHelper to bubble reasons)
      address impl = _implementation();
      impl.tryAssemblyDelegateCall(_data);
    }
  }
}
