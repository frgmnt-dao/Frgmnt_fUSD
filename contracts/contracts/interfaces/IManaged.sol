// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Frgmnt — IManaged
interface IManaged {
	function manager() external view returns (address);

	function trader() external view returns (address);

	function managerName() external view returns (string memory);
}
