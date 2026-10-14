// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPoolHarvestLike {
    function harvest() external;

    function stake(uint256 amountFusd) external;

    function unstake(uint256 shareAmount) external;
}

/// @notice SoftStack M-12 verification double: reproduces the finding's own mechanism (an
///         ERC-777-style "hook token" transfer callback firing mid-swap, reached through
///         PoolLogic.execTransaction's own transaction loop, calling directly back into the
///         pool's harvest()/stake()/unstake()) WITHOUT going through execTransaction a second
///         time, matching the PoC's own LiveAttacker.onTransfer() -> ILivePool(pool).harvest()
///         call shape exactly. Records the raw revert selector so a test can confirm the
///         SPECIFIC reason the nested call failed — SoftStack M-01's nonReentrant on
///         execTransaction sharing the same ReentrancyGuard mutex as these functions, not some
///         unrelated revert.
contract ReentrantHarvestCallbackSender {
    bytes4 public lastHarvestRevertSelector;
    bool public lastHarvestReverted;
    bytes4 public lastStakeRevertSelector;
    bool public lastStakeReverted;
    bytes4 public lastUnstakeRevertSelector;
    bool public lastUnstakeReverted;

    function callHarvest(address pool) external {
        try IPoolHarvestLike(pool).harvest() {
            lastHarvestReverted = false;
            lastHarvestRevertSelector = bytes4(0);
        } catch (bytes memory reason) {
            lastHarvestReverted = true;
            lastHarvestRevertSelector = _selector(reason);
        }
    }

    function callStake(address pool, uint256 amountFusd) external {
        try IPoolHarvestLike(pool).stake(amountFusd) {
            lastStakeReverted = false;
            lastStakeRevertSelector = bytes4(0);
        } catch (bytes memory reason) {
            lastStakeReverted = true;
            lastStakeRevertSelector = _selector(reason);
        }
    }

    function callUnstake(address pool, uint256 shareAmount) external {
        try IPoolHarvestLike(pool).unstake(shareAmount) {
            lastUnstakeReverted = false;
            lastUnstakeRevertSelector = bytes4(0);
        } catch (bytes memory reason) {
            lastUnstakeReverted = true;
            lastUnstakeRevertSelector = _selector(reason);
        }
    }

    function _selector(bytes memory reason) private pure returns (bytes4 sel) {
        if (reason.length < 4) return bytes4(0);
        assembly {
            sel := mload(add(reason, 32))
        }
    }
}
