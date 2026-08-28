// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { TokenLogic } from "../TokenLogic.sol";

/// @notice FNA-55 regression harness: exposes TokenLogic's internal cooldown-timestamp
///         weighted-average math directly, and lets a whole sequence of split mints be applied
///         within a single transaction (so every step shares the exact same block.timestamp,
///         and a many-step adversarial split doesn't need one real transaction per step).
contract TestTokenLogicCooldown is TokenLogic {
    function seedCooldown(address user, uint256 principal, uint256 timestamp) external {
        cooldownPrincipal[user] = principal;
        cooldownTimestamp[user] = timestamp;
    }

    function mintForTest(address user, uint256 amount) external {
        (cooldownPrincipal[user], cooldownTimestamp[user]) = _updateCooldownTimestamp(user, amount);
    }

    function splitMintForTest(address user, uint256[] calldata amounts) external {
        for (uint256 i; i < amounts.length; ++i) {
            (cooldownPrincipal[user], cooldownTimestamp[user]) = _updateCooldownTimestamp(
                user,
                amounts[i]
            );
        }
    }
}
