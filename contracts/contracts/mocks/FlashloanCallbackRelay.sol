// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPoolFlashloanCallbacks {
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external returns (bool);

    function onMorphoFlashLoan(uint256 assets, bytes calldata params) external;
}

/// @notice SoftStack M-02/M-03 test double. When invoked (directly, or nested via
///         PoolLogic.execTransaction), calls back into the pool's own flashloan callbacks with
///         minimal, otherwise-harmless arguments, and records the raw revert selector (if any) so
///         a test can assert on exactly which check fired — specifically distinguishing
///         FlashloanCallbackOutsideGuardedCall() from anything else.
contract FlashloanCallbackRelay {
    bytes4 public lastAaveRevertSelector;
    bool public lastAaveReverted;
    bytes4 public lastMorphoRevertSelector;
    bool public lastMorphoReverted;

    function callExecuteOperation(address pool) external {
        address[] memory emptyAddr = new address[](0);
        uint256[] memory emptyUint = new uint256[](0);
        try
            IPoolFlashloanCallbacks(pool).executeOperation(
                emptyAddr,
                emptyUint,
                emptyUint,
                pool,
                ""
            )
        {
            lastAaveReverted = false;
            lastAaveRevertSelector = bytes4(0);
        } catch (bytes memory reason) {
            lastAaveReverted = true;
            lastAaveRevertSelector = _selector(reason);
        }
    }

    function callOnMorphoFlashLoan(address pool) external {
        try IPoolFlashloanCallbacks(pool).onMorphoFlashLoan(0, "") {
            lastMorphoReverted = false;
            lastMorphoRevertSelector = bytes4(0);
        } catch (bytes memory reason) {
            lastMorphoReverted = true;
            lastMorphoRevertSelector = _selector(reason);
        }
    }

    function _selector(bytes memory reason) private pure returns (bytes4 sel) {
        if (reason.length < 4) return bytes4(0);
        assembly {
            sel := mload(add(reason, 32))
        }
    }
}
