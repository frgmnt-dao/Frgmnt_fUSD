// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal mock for IHasGuardInfo used by ERC20Guard tests.
contract MockGuardInfo {
    mapping(address => address) public contractGuards;

    function setContractGuard(address target, address guard) external {
        contractGuards[target] = guard;
    }

    function getContractGuard(address target) external view returns (address) {
        return contractGuards[target];
    }
}
