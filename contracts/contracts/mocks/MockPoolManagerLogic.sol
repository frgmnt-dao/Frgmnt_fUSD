// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal mock that satisfies both IPoolManagerLogic and IManaged
///         for the purposes of ERC20Guard.
contract MockPoolManagerLogic {
    address public _factory;
    address public _poolLogic;
    address public _manager;

    constructor(address factory_, address poolLogic_, address manager_) {
        _factory = factory_;
        _poolLogic = poolLogic_;
        _manager = manager_;
    }

    // IPoolManagerLogic-like
    function factory() external view returns (address) {
        return _factory;
    }

    function poolLogic() external view returns (address) {
        return _poolLogic;
    }

    // IManaged-like
    function manager() external view returns (address) {
        return _manager;
    }
}
