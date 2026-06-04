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

    bool public returnZeroAsset;
    bool public returnZeroAmount;
    bool public complexShouldRevert;
    uint256 public amountBps = 10_000;
    address public transactionTo;
    bytes public transactionData;

    function setWithdrawMode(bool zeroAsset, bool zeroAmount, uint256 bps) external {
        returnZeroAsset = zeroAsset;
        returnZeroAmount = zeroAmount;
        amountBps = bps;
    }

    function setTransaction(address to, bytes calldata data) external {
        transactionTo = to;
        transactionData = data;
    }

    function clearTransaction() external {
        transactionTo = address(0);
        delete transactionData;
    }

    function setComplexShouldRevert(bool value) external {
        complexShouldRevert = value;
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
        amount = (amount * amountBps) / 10_000;

        withdrawAsset = returnZeroAsset ? address(0) : asset;
        withdrawAmount = returnZeroAmount ? 0 : amount;

        if (transactionTo != address(0)) {
            transactions = new MultiTransaction[](1);
            transactions[0] = MultiTransaction({ to: transactionTo, txData: transactionData });
        }
    }

    function withdrawProcessing(
        address poolLogic,
        address asset,
        uint256 portion,
        address /*to*/,
        bytes memory /*withdrawData*/
    )
        external
        view
        returns (
            address withdrawAsset,
            uint256 withdrawAmount,
            MultiTransaction[] memory transactions
        )
    {
        if (complexShouldRevert) revert("complex failed");

        uint256 balance = IERC20(asset).balanceOf(poolLogic);
        uint256 amount = (balance * portion) / 1e18;
        amount = (amount * amountBps) / 10_000;

        withdrawAsset = returnZeroAsset ? address(0) : asset;
        withdrawAmount = returnZeroAmount ? 0 : amount;

        if (transactionTo != address(0)) {
            transactions = new MultiTransaction[](1);
            transactions[0] = MultiTransaction({ to: transactionTo, txData: transactionData });
        }
    }
}
