// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Simulates a not-yet-upgraded PoolLogic implementation that predates FNA-22's
///         checkpointFeesForDeposit() (still implements the older incrementAccountedAssets(),
///         which has existed since before that fix) — used to prove TokenLogic._deposit()'s
///         low-level checkpoint call (FNA-04 follow-up) stays fail-open for a missing selector
///         on a real contract, as opposed to a codeless EOA (see MockPoolLogicSimple).
contract MockPoolLogicNoCheckpoint {
    uint256 public accountedAssets;

    function incrementAccountedAssets(uint256 amount) external {
        accountedAssets += amount;
    }

    function poolManagerLogic() external view returns (address) {
        return address(this);
    }
}
