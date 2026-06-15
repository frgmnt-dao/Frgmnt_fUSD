// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Mock PoolLogic that returns a configurable poolManagerLogic and factory.
contract MockPoolLogicWithManager {
    address public _poolManagerLogic;
    address public _factory;

    constructor(address poolManagerLogic_, address factory_) {
        _poolManagerLogic = poolManagerLogic_;
        _factory = factory_;
    }

    function poolManagerLogic() external view returns (address) {
        return _poolManagerLogic;
    }

    function factory() external view returns (address) {
        return _factory;
    }
}
