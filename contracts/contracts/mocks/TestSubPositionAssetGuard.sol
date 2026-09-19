// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IAssetGuard } from "../interfaces/guards/IAssetGuard.sol";
import { TestAssetGuard } from "./TestAssetGuard.sol";

/// @notice Test-only guard implementing the ISubPositionGuard surface on top of TestAssetGuard.
///         Models a guard fronting `totalPositions` equal positions: drawing `ids.length` of them
///         at `portion` delivers balance * portion * ids.length / totalPositions of the asset.
///         Exercises WithdrawalPlanLib's position-level plumbing (binding, validation, dispatch,
///         value conservation) without any lending-protocol mock.
contract TestSubPositionAssetGuard is TestAssetGuard {
    uint256 public totalPositions = 4;

    function setTotalPositions(uint256 n) external {
        totalPositions = n;
    }

    function isSubPositionGuard() external pure returns (bool) {
        return true;
    }

    function withdrawProcessingSubset(
        address pool,
        address asset,
        uint256 portion,
        address,
        bytes32[] calldata positionIds
    ) external view returns (address, uint256, IAssetGuard.MultiTransaction[] memory txs) {
        uint256 balance = IERC20(asset).balanceOf(pool);
        uint256 amount = (((balance * portion) / 1e18) * positionIds.length) / totalPositions;
        return (asset, amount, new IAssetGuard.MultiTransaction[](0));
    }
}
