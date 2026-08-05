// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { MockAaveV4Spoke } from "./MockAaveV4Spoke.sol";

/// @notice Minimal mock of Aave V4's GiverPositionManager for guard unit tests.
/// @dev Pulls the underlying asset from the caller and credits the position 1:1 (shares ==
///      assets) on the given mock Spoke — enough to exercise the real supply flow end-to-end.
contract MockAaveV4GiverPositionManager {
    function supplyOnBehalfOf(
        address spoke,
        uint256 reserveId,
        uint256 amount,
        address onBehalfOf
    ) external returns (uint256 suppliedShares, uint256 suppliedAmount) {
        (address underlying, , ) = MockAaveV4Spoke(spoke).getReserve(reserveId);
        IERC20(underlying).transferFrom(msg.sender, address(this), amount);
        MockAaveV4Spoke(spoke).adjustSupplied(reserveId, onBehalfOf, true, amount);
        suppliedShares = amount;
        suppliedAmount = amount;
    }
}
