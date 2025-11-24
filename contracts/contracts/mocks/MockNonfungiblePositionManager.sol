// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockNonfungiblePositionManager {
    address public _factory;

    // token index => tokenId
    mapping(uint256 => uint256) public tokenByIndexStorage;
    uint256 public totalSupplyStorage;

    // tokenId => position data (simplified)
    struct Position {
        address token0;
        address token1;
        uint24 fee;
    }

    mapping(uint256 => Position) public positionsStorage;

    constructor(address factory_) {
        _factory = factory_;
    }

    function factory() external view returns (address) {
        return _factory;
    }

    // --- methods used by the guard ---

    function totalSupply() external view returns (uint256) {
        return totalSupplyStorage;
    }

    function tokenByIndex(uint256 index) external view returns (uint256) {
        return tokenByIndexStorage[index];
    }

    function positions(
        uint256 tokenId
    )
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        )
    {
        Position memory p = positionsStorage[tokenId];

        // we only care about token0, token1, fee for tests
        token0 = p.token0;
        token1 = p.token1;
        fee = p.fee;

        // rest zero
        nonce = 0;
        operator = address(0);
        tickLower = 0;
        tickUpper = 0;
        liquidity = 0;
        feeGrowthInside0LastX128 = 0;
        feeGrowthInside1LastX128 = 0;
        tokensOwed0 = 0;
        tokensOwed1 = 0;
    }

    // --- test helpers to set state ---

    function setTokenByIndex(uint256 index, uint256 tokenId) external {
        tokenByIndexStorage[index] = tokenId;
        // keep totalSupplyStorage = index + 1 if larger
        if (index + 1 > totalSupplyStorage) {
            totalSupplyStorage = index + 1;
        }
    }

    function setPosition(uint256 tokenId, address token0, address token1, uint24 fee) external {
        positionsStorage[tokenId] = Position({token0: token0, token1: token1, fee: fee});
    }
}
