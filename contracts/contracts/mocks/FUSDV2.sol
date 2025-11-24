// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../TokenLogic.sol";

/**
 * @title FUSDV2
 * @notice Simple upgrade adding version(); storage layout unchanged.
 * @dev No constructor. Provide a no-op reinitializer instead.
 */
contract FUSDV2 is TokenLogic {
    /// @notice No-op initializer to satisfy OZ upgrades validator on upgrade.
    function initializeV2() external reinitializer(2) {
        // Intentionally empty. Place role grants / param tweaks here in future upgrades.
    }

    function version() external pure returns (uint256) {
        return 2;
    }
}
