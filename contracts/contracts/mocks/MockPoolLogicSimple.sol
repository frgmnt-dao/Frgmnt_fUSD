// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IPoolLogic } from "../interfaces/IPoolLogic.sol";

/// @notice Minimal PoolLogic mock for TokenLogic deposit tests.
/// Accepts collateral transfers and tracks accountedAssets.
contract MockPoolLogicSimple {
    uint256 public accountedAssets;
    bool public navIncomplete;
    uint256 public checkpointCallCount;

    function incrementAccountedAssets(uint256 amount) external {
        accountedAssets += amount;
    }

    function poolManagerLogic() external view returns (address) {
        return address(this);
    }

    // Lets a test simulate PoolLogic.checkpointFeesForDeposit() reverting IncompleteNAV
    // (FNA-04 follow-up), to exercise TokenLogic._deposit()'s selective re-revert.
    function setNavIncomplete(bool _incomplete) external {
        navIncomplete = _incomplete;
    }

    function checkpointFeesForDeposit() external {
        checkpointCallCount += 1;
        if (navIncomplete) revert IPoolLogic.IncompleteNAV();
    }
}
