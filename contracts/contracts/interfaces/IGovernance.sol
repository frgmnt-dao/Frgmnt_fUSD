// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Frgmnt — IGovernance
interface IGovernance {
    function contractGuards(address target) external view returns (address guard);

    function assetGuards(uint16 assetType) external view returns (address guard);
}
