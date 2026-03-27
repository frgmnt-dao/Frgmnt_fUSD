// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../utils/DhedgeMath.sol";

contract DhedgeMathTest {
    function sqrt(uint256 x) external pure returns (uint128) {
        return DhedgeMath.sqrt(x);
    }
}
