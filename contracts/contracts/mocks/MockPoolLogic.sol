// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockPoolLogic {
    address public manager;
    uint256 public mintCount_;
    address public fusd;

    function setManager(address m) external {
        manager = m;
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
