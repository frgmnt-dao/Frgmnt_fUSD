// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IManaged } from "./interfaces/IManaged.sol";

/// @title Frgmnt — Managed
/// @notice Role management contract handling manager, trader, and member permissions.
contract Managed is IManaged {
	// =====================================================
	//                     EVENTS
	// =====================================================

	/// @notice Emitted when a new manager is assigned.
	/// @param newManager The address of the new manager.
	/// @param newManagerName The human-readable name of the new manager.
	event ManagerUpdated(address indexed newManager, string newManagerName);

	// =====================================================
	//                 STATE VARIABLES
	// =====================================================

	/// @notice The address of the current manager.
	address public override manager;

	/// @notice The manager’s name (off-chain human-readable metadata).
	string public override managerName;

	/// @notice Dynamic array holding the list of member addresses.
	address[] private _memberList;

	/// @notice Mapping to track each member’s position in `_memberList`.
	/// @dev Positions are 1-based. A value of 0 means "not a member".
	mapping(address => uint256) private _memberPosition;

	/// @notice The address of the assigned trader (optional role).
	address public override trader;

	// =====================================================
	//                     ERRORS
	// =====================================================

	/// @notice Thrown when a non-manager calls a manager-only function.
	error OnlyManager();

	/// @notice Thrown when a non-manager and non-trader calls a restricted function.
	error OnlyManagerOrTrader();

	/// @notice Thrown when an invalid (zero) manager address is provided.
	error InvalidManager();

	/// @notice Thrown when an invalid (zero) trader address is provided.
	error InvalidTrader();

	// =====================================================
	//                   INITIALIZATION
	// =====================================================

	/// @notice Initializes the contract with a new manager and name.
	/// @param _newManager The address of the new manager.
	/// @param _newManagerName The name of the new manager.
	function _initialize(address _newManager, string memory _newManagerName) internal {
		if (_newManager == address(0)) revert InvalidManager();
		manager = _newManager;
		managerName = _newManagerName;
	}

	// =====================================================
	//                     MODIFIERS
	// =====================================================

	/// @notice Restricts execution to the current manager.
	modifier onlyManager() {
		if (msg.sender != manager) revert OnlyManager();
		_;
	}

	/// @notice Restricts execution to the manager or the trader.
	modifier onlyManagerOrTrader() {
		if (msg.sender != manager && msg.sender != trader) revert OnlyManagerOrTrader();
		_;
	}

	// =====================================================
	//                  MEMBER MANAGEMENT
	// =====================================================

	/// @notice Checks if an address is a member of the list.
	/// @param _member The address to check.
	/// @return True if the address is a registered member, false otherwise.
	function _isMemberAllowed(address _member) internal view returns (bool) {
		return _memberPosition[_member] != 0;
	}

	/// @notice Returns the full list of current members.
	/// @return members An array containing all member addresses.
	function getMembers() external view returns (address[] memory members) {
		members = _memberList;
	}

	/// @notice Adds a new member to the internal member list.
	/// @dev Internal helper called by `addMember` and `addMembers`.
	/// @param _member The address of the new member.
	function _addMember(address _member) internal {
		_memberList.push(_member);
		// Store position as 1-based index (0 means “not in list”)
		_memberPosition[_member] = _memberList.length;
	}

	/// @notice Removes a member from the list using swap-and-pop for O(1) efficiency.
	/// @dev Internal helper called by `removeMember` and `removeMembers`.
	/// @param _member The address of the member to remove.
	function _removeMember(address _member) internal {
		uint256 length = _memberList.length;
		uint256 index = _memberPosition[_member] - 1; // convert to 0-based index
		address lastMember = _memberList[length - 1];

		// Move last member to the removed slot to maintain continuity
		_memberList[index] = lastMember;
		_memberPosition[lastMember] = index + 1; // maintain 1-based mapping
		_memberPosition[_member] = 0;

		_memberList.pop();
	}

	// =====================================================
	//                MANAGER OPERATIONS
	// =====================================================

	/// @notice Changes the manager address and name.
	/// @param _newManager The address of the new manager.
	/// @param _newManagerName The name of the new manager.
	function changeManager(address _newManager, string memory _newManagerName) external onlyManager {
		if (_newManager == address(0)) revert InvalidManager();
		manager = _newManager;
		managerName = _newManagerName;
		emit ManagerUpdated(_newManager, _newManagerName);
	}

	/// @notice Adds multiple members in a single transaction.
	/// @param _members Array of addresses to add.
	function addMembers(address[] memory _members) external onlyManager {
		uint256 len = _members.length;
		for (uint256 i = 0; i < len; ) {
			address member = _members[i];
			if (!_isMemberAllowed(member)) {
				_addMember(member);
			}
			unchecked {
				++i;
			}
		}
	}

	/// @notice Removes multiple members in a single transaction.
	/// @param _members Array of addresses to remove.
	function removeMembers(address[] memory _members) external onlyManager {
		uint256 len = _members.length;
		for (uint256 i = 0; i < len; ) {
			address member = _members[i];
			if (_isMemberAllowed(member)) {
				_removeMember(member);
			}
			unchecked {
				++i;
			}
		}
	}

	/// @notice Adds a single member.
	/// @param _member Address of the member to add.
	function addMember(address _member) external onlyManager {
		if (_isMemberAllowed(_member)) return;
		_addMember(_member);
	}

	/// @notice Removes a single member.
	/// @param _member Address of the member to remove.
	function removeMember(address _member) external onlyManager {
		if (!_isMemberAllowed(_member)) return;
		_removeMember(_member);
	}

	/// @notice Returns the number of registered members.
	/// @return numOfMembers The number of members in the list.
	function numberOfMembers() external view returns (uint256 numOfMembers) {
		numOfMembers = _memberList.length;
	}

	// =====================================================
	//                  TRADER OPERATIONS
	// =====================================================

	/// @notice Assigns a new trader address.
	/// @param _newTrader The address of the new trader.
	function setTrader(address _newTrader) external onlyManager {
		if (_newTrader == address(0)) revert InvalidTrader();
		trader = _newTrader;
	}

	/// @notice Removes the currently assigned trader.
	function removeTrader() external onlyManager {
		trader = address(0);
	}
}
