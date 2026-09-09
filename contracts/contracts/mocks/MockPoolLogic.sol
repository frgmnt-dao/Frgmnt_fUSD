// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockPoolLogic {
    address public manager;
    uint256 public mintCount_;
    address public fusd;

    // CertiK FNA-60: mirrors PoolLogic's real public mapping getter so
    // PoolManagerLogic._removeAsset()'s staticcall against it can be exercised in tests.
    mapping(address => uint256) public pendingCashWithdrawCount;

    function setManager(address m) external {
        manager = m;
    }

    function setPendingCashWithdrawCount(address asset, uint256 count) external {
        pendingCashWithdrawCount[asset] = count;
    }

    function setFusd(address _fusd) external {
        fusd = _fusd;
    }

    // PoolManagerLogic requires this equality check:
    function poolManagerLogic() external view returns (address) {
        return manager;
    }

    // Called before committing fee increase in tests
    function mintManagerFee() external {
        mintCount_++;
    }

    function mintCount() external view returns (uint256) {
        return mintCount_;
    }
}
