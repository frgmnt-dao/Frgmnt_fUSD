// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Frgmnt — IHasDaoInfo
interface IHasDaoInfo {
    function getDaoFee() external view returns (uint256, uint256);

    function daoAddress() external view returns (address);
}
