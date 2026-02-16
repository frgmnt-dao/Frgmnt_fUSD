// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

library CallResultChecker {

    error TxFailed();

    function _checkCallResult(bytes memory data, bool success, bytes memory returndata) public pure {
        if (!success) revert TxFailed();

        // Only verify return value for ERC20 transfer/approve
        require(data.length >= 4, "no selector");
        bytes4 sig;
        assembly {
            sig := mload(add(data, 32))
        }

        bool isERC20 = (sig == IERC20.transfer.selector || sig == IERC20.approve.selector);

        if (isERC20 && returndata.length > 0) {
            // SafeERC20-style: decode as bool
            bool ok = abi.decode(returndata, (bool));
            if (!ok) revert TxFailed();
        }
        // For other calls (e.g., Aave withdraw/repay uint256), ignore returndata
	}
}