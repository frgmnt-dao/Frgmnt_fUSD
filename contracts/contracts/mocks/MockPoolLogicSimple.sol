// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IPoolLogic } from "../interfaces/IPoolLogic.sol";

/// @notice Minimal PoolLogic mock for TokenLogic deposit tests.
/// Accepts collateral transfers and tracks accountedAssets.
contract MockPoolLogicSimple {
    uint256 public accountedAssets;
    bool public navIncomplete;
    bool public revertOther;
    uint256 public checkpointCallCount;

    // FNA-04 follow-up (CertiK's second round): TokenLogic._deposit() previously only
    // re-reverted the specific IncompleteNAV selector, silently swallowing any *other*
    // checkpointFeesForDeposit() failure (e.g. an unrelated bug or panic in the fee/reward
    // pipeline) and letting the deposit proceed anyway. Lets a test prove the fix bubbles up
    // an arbitrary, unrelated revert reason too, not just IncompleteNAV.
    error OtherCheckpointFailure();

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

    // Lets a test simulate checkpointFeesForDeposit() reverting with a selector unrelated
    // to IncompleteNAV.
    function setRevertOther(bool _revertOther) external {
        revertOther = _revertOther;
    }

    function checkpointFeesForDeposit() external {
        checkpointCallCount += 1;
        if (navIncomplete) revert IPoolLogic.IncompleteNAV();
        if (revertOther) revert OtherCheckpointFailure();
    }
}
