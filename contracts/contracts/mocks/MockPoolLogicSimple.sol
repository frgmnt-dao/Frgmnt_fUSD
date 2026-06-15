// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal PoolLogic mock for TokenLogic deposit tests.
/// Accepts collateral transfers and tracks accountedAssets.
contract MockPoolLogicSimple {
    uint256 public accountedAssets;

    function incrementAccountedAssets(uint256 amount) external {
        accountedAssets += amount;
    }

    function poolManagerLogic() external view returns (address) {
        return address(this);
    }
}
