// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Proxy} from "./Proxy.sol";
import {OpenZeppelinUpgradesAddress} from "./Address.sol";
import {HasLogic} from "./HasLogic.sol";

/// @title BaseUpgradeabilityProxy
/// @dev EIP-1967 storage slots; implementation resolved via ProxyFactory.getLogic(proxyType).
contract BaseUpgradeabilityProxy is Proxy {
  event Upgraded(address indexed implementation);

  // EIP-1967 implementation slot
  bytes32 internal constant IMPLEMENTATION_SLOT =
    0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

  // Custom slot for proxy type (1=manager, 2=vault, etc.)
  bytes32 internal constant PROXY_TYPE =
    0x1000000000000000000000000000000000000000000000000000000000000000;

  /// @notice Returns the current implementation (resolved via factory.getLogic(proxyType)).
  function _implementation() internal view override returns (address) {
    address factory;
    bytes32 slot = IMPLEMENTATION_SLOT;
    assembly {
      factory := sload(slot)
    }
    if (factory == address(0)) return address(0);
    return HasLogic(factory).getLogic(_proxyType());
  }

  /// @notice Return the proxy type id.
  function _proxyType() internal view returns (uint8 proxyType) {
    bytes32 slot = PROXY_TYPE;
    assembly {
      proxyType := sload(slot)
    }
  }

  /// @notice Set the “factory” address into EIP-1967 implementation slot (see initialize()).
  function _setImplementation(address newImplementation) internal {
    require(OpenZeppelinUpgradesAddress.isContract(newImplementation), "Cannot set implementation to EOA");
    bytes32 slot = IMPLEMENTATION_SLOT;
    assembly {
      sstore(slot, newImplementation)
    }
  }

  /// @notice Set the proxy type id (1=manager, 2=vault, etc.)
  function _setProxyType(uint8 proxyType) internal {
    bytes32 slot = PROXY_TYPE;
    assembly {
      sstore(slot, proxyType)
    }
  }

  /// @notice (Optional) direct upgrade — not used in this pattern but kept for completeness.
  function _upgradeTo(address newImplementation) internal {
    _setImplementation(newImplementation);
    emit Upgraded(newImplementation);
  }
}
