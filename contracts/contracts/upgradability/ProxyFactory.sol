// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import {InitializableUpgradeabilityProxy} from "./InitializableUpgradeabilityProxy.sol";
import {HasLogic} from "./HasLogic.sol";

/// @notice Factory that deploys upgradeable proxies and serves the logic addresses per proxy type.
contract ProxyFactory is OwnableUpgradeable, HasLogic {
  event ProxyCreated(address proxy);

  // 1 = PoolManagerLogic, 2 = Vault/PoolLogic (sFUSD)
  address private poolLogic;
  address private poolManagerLogic;

  // Additional implementation ids (e.g., 3 = FUSD)
  mapping(uint256 => address) private extraImplementations;

  // ---------------------------------------------------------------------
  // Initializer
  // ---------------------------------------------------------------------

  /// @notice Initialize with logic addresses and set the owner.
  /// @param _poolLogic Vault/PoolLogic (proxy type = 2)
  /// @param _poolManagerLogic PoolManagerLogic (proxy type = 1)
  /// @param _owner Owner for Ownable
  // solhint-disable-next-line func-name-mixedcase
  function __ProxyFactory_init(address _poolLogic, address _poolManagerLogic, address _owner)
    internal
    onlyInitializing
  {
    __Ownable_init(_owner);

    require(_poolLogic != address(0), "Invalid poolLogic");
    require(_poolManagerLogic != address(0), "Invalid poolManagerLogic");

    poolLogic = _poolLogic;
    poolManagerLogic = _poolManagerLogic;
  }

  // ---------------------------------------------------------------------
  // Logic registry
  // ---------------------------------------------------------------------

  /// @notice Set both core logic addresses at once.
  function setLogic(address _poolLogic, address _poolManagerLogic) external onlyOwner {
    require(_poolLogic != address(0), "Invalid poolLogic");
    require(_poolManagerLogic != address(0), "Invalid poolManagerLogic");
    poolLogic = _poolLogic;
    poolManagerLogic = _poolManagerLogic;
  }

  /// @notice Internal hook used by PoolFactory to register extra implementations (e.g., FUSD).
  /// @dev PoolFactory calls this via low-level call using the same signature.
  function _proxyFactorySetImpl(uint256 id, address impl) external onlyOwner {
    require(id != 0, "id=0");
    require(impl != address(0), "impl=0");
    extraImplementations[id] = impl;
  }

  /// @inheritdoc HasLogic
  function getLogic(uint8 _proxyType) external view override returns (address) {
    if (_proxyType == 1) return poolManagerLogic;
    if (_proxyType == 2) return poolLogic;
    return extraImplementations[_proxyType];
  }

  // ---------------------------------------------------------------------
  // Deployment
  // ---------------------------------------------------------------------

  /// @notice Deploy a fresh proxy and initialize it via delegatecall into the logic.
  /// @param _data ABI-encoded initializer for the proxied implementation
  /// @param _proxyType 1 = PoolManagerLogic, 2 = Vault/Pool (sFUSD), 3+ = extras (e.g., FUSD)
  function deploy(bytes memory _data, uint8 _proxyType) public returns (address) {
    InitializableUpgradeabilityProxy proxy = _createProxy();
    emit ProxyCreated(address(proxy));
    proxy.initialize(address(this), _data, _proxyType);
    return address(proxy);
  }

  function _createProxy() internal returns (InitializableUpgradeabilityProxy) {
    // No constructor params; simple new is fine (cleaner than inline assembly here)
    return new InitializableUpgradeabilityProxy();
  }

  uint256[47] private __gap;
}
