// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal asset guard compatible with PoolLogic.
/// It:
/// - Reports balance as ERC20(asset).balanceOf(pool)
/// - withdrawProcessing() just returns a proportional share, no extra txs.
contract TestAssetGuard {
    struct MultiTransaction {
        address to;
        bytes txData;
    }

    function getBalance(address poolLogic, address asset) external view returns (uint256) {
        return IERC20(asset).balanceOf(poolLogic);
    }

    /// @notice Withdraws a portion of the asset balance; no external transactions.
    function withdrawProcessing(
        address poolLogic,
        address asset,
        uint256 portion,
        address /*to*/
    )
        external
        view
        returns (
            address withdrawAsset,
            uint256 withdrawAmount,
            MultiTransaction[] memory transactions
        )
    {
        uint256 balance = IERC20(asset).balanceOf(poolLogic);
        uint256 amount = (balance * portion) / 1e18;

        withdrawAsset = asset;
        withdrawAmount = amount;
    }
}
