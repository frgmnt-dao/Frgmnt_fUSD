// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "../interfaces/IERC20.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title SafeERC20
 * @dev Minimal SafeERC20 wrappers compatible with OpenZeppelin v5.
 * - Uses Address.functionCall(target, data) (no errorMessage overload in OZ v5).
 * - No SafeMath (not needed on ^0.8.x).
 */
library SafeERC20 {
    using Address for address;

    function safeTransfer(IERC20 token, address to, uint256 value) internal {
        _callOptionalReturn(token, abi.encodeWithSelector(token.transfer.selector, to, value));
    }

    function safeTransferFrom(IERC20 token, address from, address to, uint256 value) internal {
        _callOptionalReturn(
            token,
            abi.encodeWithSelector(token.transferFrom.selector, from, to, value)
        );
    }

    /**
     * @dev Deprecated. Only use when setting allowance from 0 or back to 0.
     * Prefer {safeIncreaseAllowance}/{safeDecreaseAllowance}.
     */
    function safeApprove(IERC20 token, address spender, uint256 value) internal {
        require(
            value == 0 || token.allowance(address(this), spender) == 0,
            "SafeERC20: approve from non-zero to non-zero allowance"
        );
        _callOptionalReturn(token, abi.encodeWithSelector(token.approve.selector, spender, value));
    }

    function safeIncreaseAllowance(IERC20 token, address spender, uint256 value) internal {
        uint256 newAllowance = token.allowance(address(this), spender) + value;
        _callOptionalReturn(
            token,
            abi.encodeWithSelector(token.approve.selector, spender, newAllowance)
        );
    }

    function safeDecreaseAllowance(IERC20 token, address spender, uint256 value) internal {
        uint256 current = token.allowance(address(this), spender);
        require(current >= value, "SafeERC20: decreased allowance below zero");
        unchecked {
            uint256 newAllowance = current - value;
            _callOptionalReturn(
                token,
                abi.encodeWithSelector(token.approve.selector, spender, newAllowance)
            );
        }
    }

    /**
     * @dev Performs a low-level call via Address.functionCall and checks the optional boolean return.
     */
    function _callOptionalReturn(IERC20 token, bytes memory data) private {
        // OZ v5: only the 2-arg functionCall exists
        bytes memory returndata = address(token).functionCall(data);

        if (returndata.length > 0) {
            // Tokens may or may not return a boolean
            require(abi.decode(returndata, (bool)), "SafeERC20: ERC20 operation did not succeed");
        }
    }
}
