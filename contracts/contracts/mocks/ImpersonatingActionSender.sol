// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPoolLogicUserActionsLike {
    function stake(uint256 amountFusd, uint256 minShares) external;

    function unstake(uint256 shareAmount) external;

    function withdrawCashImmediate(uint256 amount) external;
}

/// @notice SoftStack M-13 verification double: a contract that, if it were trusted to resolve
///         _actionSender(), could claim to be acting on behalf of an arbitrary victim via
///         actionUser() — exactly FrgmntUserActions' own shape, but attacker-controlled. Used to
///         prove that being listed in PoolManagerLogic.allowedCallbackSenders alone (the
///         manager-controlled list that still exists for flashloan protocol callbacks) no
///         longer grants this power; only userActionsRouter does.
contract ImpersonatingActionSender {
    address public actionUser;
    address public immutable pool;

    constructor(address pool_) {
        pool = pool_;
    }

    function setActionUser(address victim) external {
        actionUser = victim;
    }

    function forwardStake(uint256 amountFusd, uint256 minShares) external {
        IPoolLogicUserActionsLike(pool).stake(amountFusd, minShares);
    }

    function forwardUnstake(uint256 shareAmount) external {
        IPoolLogicUserActionsLike(pool).unstake(shareAmount);
    }

    function forwardWithdrawCashImmediate(uint256 amount) external {
        IPoolLogicUserActionsLike(pool).withdrawCashImmediate(amount);
    }
}
