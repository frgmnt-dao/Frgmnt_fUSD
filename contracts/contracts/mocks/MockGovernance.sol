// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IGovernance } from "../interfaces/IGovernance.sol";

/// @notice Test mock implementing IGovernance.
contract MockGovernance is IGovernance {
    mapping(address => address) private _contractGuards;
    mapping(uint16 => address) private _assetGuards;

    function setContractGuard(address target, address guard) external {
        _contractGuards[target] = guard;
    }

    function setAssetGuard(uint16 assetType, address guard) external {
        _assetGuards[assetType] = guard;
    }

    function contractGuards(address target) external view override returns (address guard) {
        return _contractGuards[target];
    }

    function assetGuards(uint16 assetType) external view override returns (address guard) {
        return _assetGuards[assetType];
    }
}
