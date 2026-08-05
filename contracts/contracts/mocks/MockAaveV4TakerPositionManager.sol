// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { MockAaveV4Spoke } from "./MockAaveV4Spoke.sol";

/// @notice Minimal mock of Aave V4's TakerPositionManager for guard unit tests.
/// @dev Mirrors the real allowance behavior closely enough to test the guard's critical
///      `spender == pool` enforcement end-to-end: `approveWithdraw`'s owner is always
///      msg.sender (never a separate parameter), and `withdrawOnBehalfOf` sends withdrawn funds
///      to msg.sender (the caller), not to `onBehalfOf` — exactly like the real contract.
///      `type(uint256).max` allowances never decrement, mirroring standard ERC20 semantics.
contract MockAaveV4TakerPositionManager {
    // spoke => reserveId => owner => spender => allowance
    mapping(address => mapping(uint256 => mapping(address => mapping(address => uint256))))
        public withdrawAllowance;

    function approveWithdraw(
        address spoke,
        uint256 reserveId,
        address spender,
        uint256 amount
    ) external {
        withdrawAllowance[spoke][reserveId][msg.sender][spender] = amount;
    }

    function withdrawOnBehalfOf(
        address spoke,
        uint256 reserveId,
        uint256 amount,
        address onBehalfOf
    ) external returns (uint256 withdrawnShares, uint256 withdrawnAmount) {
        uint256 currentAllowance = withdrawAllowance[spoke][reserveId][onBehalfOf][msg.sender];
        require(currentAllowance >= amount, "insufficient withdraw allowance");
        if (currentAllowance != type(uint256).max) {
            withdrawAllowance[spoke][reserveId][onBehalfOf][msg.sender] = currentAllowance - amount;
        }

        MockAaveV4Spoke(spoke).adjustSupplied(reserveId, onBehalfOf, false, amount);

        (address underlying, , ) = MockAaveV4Spoke(spoke).getReserve(reserveId);
        IERC20(underlying).transfer(msg.sender, amount);

        withdrawnShares = amount;
        withdrawnAmount = amount;
    }
}
