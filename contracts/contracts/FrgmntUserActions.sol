// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ITokenLogicUserActions {
    function deposit(
        address asset,
        uint256 amount,
        address to,
        uint256 minFusdAmount
    ) external;
}

interface IPoolLogicUserActions {
    function stake(uint256 amountFusd, uint256 minShares) external;

    function unstake(uint256 shareAmount) external;

    function withdrawCashImmediate(uint256 amount) external;
}

/**
 * @title Frgmnt User Actions
 * @notice Typed workflow router for common user actions.
 * @dev This contract deliberately avoids arbitrary multicall execution. Users approve
 *      TokenLogic and PoolLogic directly; the router only coordinates scoped flows.
 */
contract FrgmntUserActions is ReentrancyGuard {
    struct PermitData {
        bool enabled;
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    address public immutable tokenLogic;
    address public immutable poolLogic;
    address public actionUser;

    event DepositAndStake(
        address indexed user,
        address indexed asset,
        uint256 assetAmount,
        uint256 fusdMinted,
        uint256 sharesMinted
    );
    event StakeWithPermit(address indexed user, uint256 fusdAmount, uint256 sharesMinted);
    event UnstakeAndWithdrawImmediate(address indexed user, uint256 sharesBurned, uint256 fusdOut);
    event WithdrawImmediateWithPermit(address indexed user, uint256 fusdAmount);

    constructor(address tokenLogic_, address poolLogic_) {
        require(tokenLogic_ != address(0), "FrgmntUserActions: token=0");
        require(poolLogic_ != address(0), "FrgmntUserActions: pool=0");
        tokenLogic = tokenLogic_;
        poolLogic = poolLogic_;
    }

    function depositAndStake(
        address asset,
        uint256 amount,
        uint256 minFusdAmount,
        uint256 minShares,
        PermitData calldata collateralPermit,
        PermitData calldata fusdPermit
    ) external nonReentrant returns (uint256 fusdMinted, uint256 sharesMinted) {
        address user = msg.sender;
        actionUser = user;

        _permitIfEnabled(asset, user, tokenLogic, collateralPermit);

        uint256 fusdBefore = IERC20(tokenLogic).balanceOf(user);
        ITokenLogicUserActions(tokenLogic).deposit(asset, amount, user, minFusdAmount);
        fusdMinted = IERC20(tokenLogic).balanceOf(user) - fusdBefore;

        _permitIfEnabled(tokenLogic, user, poolLogic, fusdPermit);

        uint256 sharesBefore = IERC20(poolLogic).balanceOf(user);
        IPoolLogicUserActions(poolLogic).stake(fusdMinted, minShares);
        sharesMinted = IERC20(poolLogic).balanceOf(user) - sharesBefore;

        actionUser = address(0);

        emit DepositAndStake(user, asset, amount, fusdMinted, sharesMinted);
    }

    function stakeWithPermit(
        uint256 amountFusd,
        uint256 minShares,
        PermitData calldata fusdPermit
    ) external nonReentrant returns (uint256 sharesMinted) {
        address user = msg.sender;
        actionUser = user;

        _permitIfEnabled(tokenLogic, user, poolLogic, fusdPermit);
        uint256 sharesBefore = IERC20(poolLogic).balanceOf(user);
        IPoolLogicUserActions(poolLogic).stake(amountFusd, minShares);
        sharesMinted = IERC20(poolLogic).balanceOf(user) - sharesBefore;

        actionUser = address(0);

        emit StakeWithPermit(user, amountFusd, sharesMinted);
    }

    function unstakeAndWithdrawImmediate(
        uint256 shareAmount,
        PermitData calldata fusdPermit
    ) external nonReentrant returns (uint256 fusdOut) {
        address user = msg.sender;
        actionUser = user;

        _permitIfEnabled(tokenLogic, user, poolLogic, fusdPermit);

        uint256 fusdBefore = IERC20(tokenLogic).balanceOf(user);
        IPoolLogicUserActions(poolLogic).unstake(shareAmount);
        fusdOut = IERC20(tokenLogic).balanceOf(user) - fusdBefore;
        IPoolLogicUserActions(poolLogic).withdrawCashImmediate(fusdOut);

        actionUser = address(0);

        emit UnstakeAndWithdrawImmediate(user, shareAmount, fusdOut);
    }

    function withdrawImmediateWithPermit(
        uint256 amountFusd,
        PermitData calldata fusdPermit
    ) external nonReentrant {
        address user = msg.sender;
        actionUser = user;

        _permitIfEnabled(tokenLogic, user, poolLogic, fusdPermit);
        IPoolLogicUserActions(poolLogic).withdrawCashImmediate(amountFusd);

        actionUser = address(0);

        emit WithdrawImmediateWithPermit(user, amountFusd);
    }

    /// @dev A raw EIP-2612 signature submitted in calldata is inherently front-runnable: anyone
    ///      watching the mempool can copy (owner, spender, value, deadline, v, r, s) and call
    ///      permit() themselves before this transaction lands. That consumes the signature's
    ///      nonce but still sets the allowance the user intended, so — without this check —
    ///      the user's own call would revert on the now-stale signature even though the
    ///      allowance it was meant to create already exists. Checking the current allowance
    ///      first means a front-run permit only ever *helps* (skips a redundant call) rather
    ///      than griefing the transaction into failing.
    function _permitIfEnabled(
        address token,
        address owner,
        address spender,
        PermitData calldata permitData
    ) internal {
        if (!permitData.enabled) return;
        if (IERC20(token).allowance(owner, spender) >= permitData.value) return;

        IERC20Permit(token).permit(
            owner,
            spender,
            permitData.value,
            permitData.deadline,
            permitData.v,
            permitData.r,
            permitData.s
        );
    }
}
