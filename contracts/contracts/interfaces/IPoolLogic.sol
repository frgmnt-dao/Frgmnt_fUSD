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

    function incrementAccountedAssets(uint256 amount) external;

    /// @notice FNA-04 follow-up: reverted by checkpointFeesForDeposit() when the pool's active
    ///         NAV reading is incomplete (see IPoolManagerLogic.totalFundValueWithCompleteness()),
    ///         so a deposit cannot proceed while a position's true value is transiently unknown.
    error IncompleteNAV();

    function checkpointFeesForDeposit() external;
}
