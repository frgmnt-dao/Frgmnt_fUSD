// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Managed } from "../Managed.sol";

/// @dev Simple harness to expose `initialize` and internal helpers for testing.
contract ManagedMock is Managed {
    function initialize(address newManager, string memory newManagerName) external {
        _initialize(newManager, newManagerName);
    }

    // Expose internal member check for tests
    function isMember(address a) external view returns (bool) {
        return _isMemberAllowed(a);
    }

    // Expose _changeManager as a public function for tests
    function changeManager(address newManager, string memory newManagerName) external onlyManager {
        _changeManager(newManager, newManagerName);
    }
}
