// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title Governance — Frgmnt Protocol
 * @notice Core governance registry for defining contract and asset guards.
 * @dev Updated for Solidity 0.8.24 and OpenZeppelin v5.
 *      Ownable now requires an explicit owner passed to its constructor.
 */

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IGovernance } from "./interfaces/IGovernance.sol";

contract Governance is IGovernance, Ownable {
	/*//////////////////////////////////////////////////////////////
                               EVENTS
    //////////////////////////////////////////////////////////////*/

	/// @notice Emitted when a guard is set for an external contract
	event ContractGuardSet(address indexed extContract, address indexed guardAddress);

	/// @notice Emitted when a guard is set for an asset type
	event AssetGuardSet(uint16 indexed assetType, address indexed guardAddress);

	/*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

	/// @notice Maps an external contract to its guard contract
	mapping(address => address) public override contractGuards;

	/// @notice Maps an asset type to its guard contract
	mapping(uint16 => address) public override assetGuards;

	/*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

	/**
	 * @notice Initializes governance with the given owner.
	 * @param initialOwner The address of the governance owner (admin).
	 */
	constructor(address initialOwner) Ownable(initialOwner) {}

	/*//////////////////////////////////////////////////////////////
                          RESTRICTED FUNCTIONS
    //////////////////////////////////////////////////////////////*/

	/**
	 * @notice Assigns a guard to an external contract.
	 * @param extContract The target contract to integrate.
	 * @param guardAddress The guard contract responsible for validations.
	 */
	function setContractGuard(address extContract, address guardAddress) external onlyOwner {
		_setContractGuard(extContract, guardAddress);
	}

	/**
	 * @notice Internal function to assign a guard to a contract.
	 */
	function _setContractGuard(address extContract, address guardAddress) internal {
		require(extContract != address(0), "Invalid extContract address");
		require(guardAddress != address(0), "Invalid guardAddress");

		contractGuards[extContract] = guardAddress;
		emit ContractGuardSet(extContract, guardAddress);
	}

	/**
	 * @notice Assigns a guard to an asset type.
	 * @param assetType Asset type identifier.
	 * @param guardAddress The guard contract for that asset type.
	 */
	function setAssetGuard(uint16 assetType, address guardAddress) external onlyOwner {
		_setAssetGuard(assetType, guardAddress);
	}

	/**
	 * @notice Internal function to assign a guard to an asset type.
	 */
	function _setAssetGuard(uint16 assetType, address guardAddress) internal {
		require(guardAddress != address(0), "Invalid guardAddress");

		assetGuards[assetType] = guardAddress;
		emit AssetGuardSet(assetType, guardAddress);
	}
}
