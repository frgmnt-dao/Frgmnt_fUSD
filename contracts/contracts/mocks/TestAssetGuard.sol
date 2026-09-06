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
    // FNA-36: lets a test simulate a leveraged position whose reported balance (e.g. Aave
    // collateral-minus-debt) is zero even though a real ERC20 balance exists underneath, so
    // withdrawProcessing() below (and any transaction it would plan) must never actually be
    // reached for this asset — see PoolLogic._withdrawProcessing()'s v.portionBalance == 0 skip.
    bool public forceZeroBalance;

    // FNA-07 follow-up: lets a test simulate a IWithdrawableBalanceGuard whose real,
    // liquidity-capped withdrawable amount is smaller than getBalance() — mirroring a lending
    // guard whose external market cannot currently pay out its full reported position.
    bool public withdrawableBalanceCapEnabled;
    uint256 public withdrawableBalanceCap;

    function setForceZeroBalance(bool value) external {
        forceZeroBalance = value;
    }

    function setWithdrawableBalanceCap(bool enabled, uint256 cap) external {
        withdrawableBalanceCapEnabled = enabled;
        withdrawableBalanceCap = cap;
    }

    function isWithdrawableBalanceGuard() external view returns (bool) {
        return withdrawableBalanceCapEnabled;
    }

    function getWithdrawableBalance(address, address) external view returns (uint256) {
        return withdrawableBalanceCap;
    }

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
        if (forceZeroBalance) return 0;
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
        // FNA-07 follow-up: when simulating a liquidity-capped guard, deliver against the capped
        // balance (what would actually be redeemable) rather than the raw ERC20 balance, mirroring
        // a real IWithdrawableBalanceGuard's withdrawProcessing().
        uint256 balance = withdrawableBalanceCapEnabled
            ? withdrawableBalanceCap
            : IERC20(asset).balanceOf(poolLogic);
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
