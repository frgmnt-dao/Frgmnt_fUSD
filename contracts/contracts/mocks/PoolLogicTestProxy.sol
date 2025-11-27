// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice Simple ERC1967 proxy used only for testing PoolLogic.
///         It calls PoolLogic.initialize(...) via the constructor `initData`.
contract PoolLogicTestProxy is ERC1967Proxy {
	constructor(address impl, bytes memory initData) ERC1967Proxy(impl, initData) {}
}
