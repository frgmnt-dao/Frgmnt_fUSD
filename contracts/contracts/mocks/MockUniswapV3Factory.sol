// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal Uniswap V3 factory mock used by UniswapV3PriceLibrary tests.
contract MockUniswapV3Factory {
    // key = keccak256(abi.encode(token0, token1, fee))
    mapping(bytes32 => address) public pools;

    function setPool(address token0, address token1, uint24 fee, address pool) external {
        bytes32 key = keccak256(abi.encode(token0, token1, fee));
        pools[key] = pool;
    }

    function getPool(address token0, address token1, uint24 fee) external view returns (address) {
        bytes32 key = keccak256(abi.encode(token0, token1, fee));
        return pools[key];
    }
}
