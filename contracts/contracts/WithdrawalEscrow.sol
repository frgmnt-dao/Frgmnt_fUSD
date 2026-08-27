// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IWithdrawalEscrow } from "./interfaces/IWithdrawalEscrow.sol";

/**
 * @title WithdrawalEscrow — Frgmnt Protocol
 * @notice FNA-03: physically segregates a pool's finalized-but-unclaimed queued-withdrawal
 *         assets away from that pool's own balance, so guarded manager/trader transactions
 *         (investment approvals, swaps, protocol interactions routed through
 *         PoolLogic.execTransaction) can never reach funds already earmarked for a specific
 *         claimant. CertiK's follow-up findings showed that capping individual or aggregate
 *         approvals against a bookkept "reserved" balance still sitting in the pool's own
 *         balanceOf() could not fully close this — a spender approved before a reservation was
 *         created, or a second spender approved independently of the first, could still drain
 *         it. Physically moving the asset out of the pool's own balance removes the class of
 *         bug entirely: there is nothing left in the pool's balance for an approval to reach.
 * @dev One escrow instance is deployed per pool and bound to it for its lifetime — never
 *      shared across pools. This keeps the accounting trivial and safe: this contract's own
 *      `balanceOf(asset)` *is* the ground truth of what's reserved for its one pool, with no
 *      internal ledger to keep in sync and no risk of one pool's asset accounting being
 *      affected by another's. Deliberately minimal and non-upgradeable — the security property
 *      this contract exists to provide depends on its own logic never changing in a way the
 *      bound pool doesn't expect.
 */
contract WithdrawalEscrow is IWithdrawalEscrow {
    using SafeERC20 for IERC20;

    /// @inheritdoc IWithdrawalEscrow
    address public immutable pool;

    error OnlyPool();
    error ZeroAddress();

    event Reserved(address indexed asset, uint256 amount);
    event Released(address indexed asset, address indexed recipient, uint256 amount, uint256 delivered);

    modifier onlyPool() {
        if (msg.sender != pool) revert OnlyPool();
        _;
    }

    constructor(address pool_) {
        if (pool_ == address(0)) revert ZeroAddress();
        pool = pool_;
    }

    /// @inheritdoc IWithdrawalEscrow
    function reserve(address asset, uint256 amount) external onlyPool {
        IERC20(asset).safeTransferFrom(pool, address(this), amount);
        emit Reserved(asset, amount);
    }

    /// @inheritdoc IWithdrawalEscrow
    /// @dev Measures what the recipient's own balance actually increased by rather than
    ///      assuming it equals `amount`, mirroring the same principle as TokenLogic._deposit()
    ///      (FNA-23): a recipient-fee asset can deliver less than the nominal amount. The bound
    ///      pool's own supported-asset allowlist is the only gate on what ends up escrowed
    ///      here, so this contract relies on the same "no fee-on-transfer, no rebasing"
    ///      baseline assumption already documented for every other supported asset in the
    ///      protocol (see docs/security.md's Trust Assumptions) rather than re-solving that
    ///      class of risk a second time at the escrow layer.
    function release(
        address asset,
        uint256 amount,
        address recipient
    ) external onlyPool returns (uint256 delivered) {
        uint256 before = IERC20(asset).balanceOf(recipient);
        IERC20(asset).safeTransfer(recipient, amount);
        delivered = IERC20(asset).balanceOf(recipient) - before;
        emit Released(asset, recipient, amount, delivered);
    }
}
