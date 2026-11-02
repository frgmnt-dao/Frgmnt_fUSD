// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPoolExecTransaction {
    function execTransaction(address to, bytes calldata data) external returns (bool);
}

/// @notice SoftStack M-01 test double: a contract that, when called via PoolLogic.execTransaction,
///         immediately re-enters execTransaction a second time with a configured inner call.
///         Used to prove execTransaction's nonReentrant modifier blocks this, and separately
///         (via setInnerCallTarget pointing at a FlashLoanStandIn, see the M-01 test file) to
///         prove a legitimate same-call nested flashloan callback still succeeds.
contract ReentrantCallbackSender {
    address public pool;
    address public innerTo;
    bytes public innerData;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    function configure(address pool_, address innerTo_, bytes calldata innerData_) external {
        pool = pool_;
        innerTo = innerTo_;
        innerData = innerData_;
    }

    function execute() external {
        reentryAttempted = true;
        try IPoolExecTransaction(pool).execTransaction(innerTo, innerData) {
            reentrySucceeded = true;
        } catch {
            reentrySucceeded = false;
        }
    }
}
