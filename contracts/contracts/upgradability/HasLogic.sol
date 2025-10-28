// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface HasLogic {
  function getLogic(uint8 _proxyType) external view returns (address);
}
