// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ClosedAssetGuard } from "../guards/assetGuards/ClosedAssetGuard.sol";

/// @notice Concrete implementation of ClosedAssetGuard for testing.
contract TestConcreteClosedAssetGuard is ClosedAssetGuard {
    function baseGetBalance(address pool, address asset) external view returns (uint256) {
        return super.getBalance(pool, asset);
    }

    /// @notice Returns ERC20 balance of pool for the asset.
    function getBalance(address pool, address asset) public view override returns (uint256) {
        return IERC20(asset).balanceOf(pool);
    }

    /// @notice Returns 18 decimals.
    function getDecimals(address) external pure override returns (uint256) {
        return 18;
    }

    /// @notice No-op withdraw processing.
    function withdrawProcessing(
        address,
        address,
        uint256,
        address
    )
        external
        pure
        override
        returns (address, uint256, MultiTransaction[] memory txs)
    {
        return (address(0), 0, txs);
    }
}
