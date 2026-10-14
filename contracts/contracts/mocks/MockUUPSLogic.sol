// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/// @notice Minimal UUPS-upgradeable contract used only to exercise the "no ProxyAdmin
/// behind this proxy" branch of scripts/utils/ownership.ts in tests — a UUPS proxy's
/// EIP-1967 admin slot is the zero address, unlike a Transparent proxy's.
contract MockUUPSLogic is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    function initialize(address initialOwner) external initializer {
        __Ownable_init(initialOwner);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
