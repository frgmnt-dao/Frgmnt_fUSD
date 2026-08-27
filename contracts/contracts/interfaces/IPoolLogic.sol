// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Frgmnt — IPoolLogic
interface IPoolLogic {
    struct ComplexAsset {
        address supportedAsset;
        bytes withdrawData; // at the moment could be only struct ComplexAssetSwapData
        uint256 slippageTolerance; // duplicated from ComplexAssetSwapData on purpose
    }

    function factory() external view returns (address);

    function fusd() external view returns (address);

    function poolManagerLogic() external view returns (address);

    function mintManagerFee() external;

    function reservedAssetBalance(address asset) external view returns (uint256);

    /// @notice FNA-34: cumulative net yield ever routed into the staking reward index
    ///         (_accrueYield()'s appliedNetYield), regardless of whether any staker has
    ///         harvested it yet. Together with totalRewardHarvested below, the difference is
    ///         the FUSD the protocol is already committed to minting via harvest() — a real,
    ///         outstanding claim against the pool that existing FUSD claims-haircut math must
    ///         not ignore.
    function totalRewardAccrued() external view returns (uint256);

    /// @notice FNA-34: cumulative amount already minted out via harvest(). See
    ///         totalRewardAccrued above — the difference between the two is what's still owed.
    function totalRewardHarvested() external view returns (uint256);

    function incrementAccountedAssets(uint256 amount) external;

    /// @notice FNA-04 follow-up: reverted by checkpointFeesForDeposit() when the pool's active
    ///         NAV reading is incomplete (see IPoolManagerLogic.totalFundValueWithCompleteness()),
    ///         so a deposit cannot proceed while a position's true value is transiently unknown.
    error IncompleteNAV();

    function checkpointFeesForDeposit() external;
}
