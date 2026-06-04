// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Simple target contract used for guarded tx execution tests.
contract TestTarget {
    uint256 public lastValue;

    fallback() external payable {}

    function doSomething(uint256 v) external {
        lastValue = v;
    }

    function mintToken(address token, address to, uint256 amount) external {
        (bool ok, ) = token.call(abi.encodeWithSignature("mint(address,uint256)", to, amount));
        require(ok, "mint failed");
    }

    function returnFalse() external pure returns (bool) {
        return false;
    }

    function revertAlways() external pure {
        revert("target revert");
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}
