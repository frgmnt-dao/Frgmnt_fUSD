// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    TransparentUpgradeableProxy
} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/// @notice Test-only transparent proxy (with its own ProxyAdmin), mirroring the mainnet PoolLogic
///         proxy's upgrade mechanics so migration-sequence tests can observe that
///         upgradeAndCall's init data runs with the ProxyAdmin — not the owner — as msg.sender.
contract PoolLogicTransparentProxy is TransparentUpgradeableProxy {
    constructor(
        address impl,
        address initialOwner,
        bytes memory data
    ) TransparentUpgradeableProxy(impl, initialOwner, data) {}
}
