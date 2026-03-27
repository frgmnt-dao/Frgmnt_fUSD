// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Extended mock of Uniswap V3 NonfungiblePositionManager
/// @dev Designed for testing UniswapV3AssetGuard and PositionValue/LiquidityAmounts logic.
contract MockUniV3PositionManagerExtended {
    address public uniFactory;

    mapping(uint256 => uint256) public tokenByIndexStorage;
    uint256 public totalSupplyStorage;

    struct PositionFull {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 feeAmount0;
        uint256 feeAmount1;
    }

    mapping(uint256 => PositionFull) public fullPositions;

    constructor(address factoryAddress) {
        uniFactory = factoryAddress;
    }

    function factory() external view returns (address) {
        return uniFactory;
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
        PositionFull memory p = fullPositions[tokenId];

        token0 = p.token0;
        token1 = p.token1;
        fee = p.fee;
        tickLower = p.tickLower;
        tickUpper = p.tickUpper;
        liquidity = p.liquidity;

        nonce = 0;
        operator = address(0);
        feeGrowthInside0LastX128 = 0;
        feeGrowthInside1LastX128 = 0;
        tokensOwed0 = 0;
        tokensOwed1 = 0;
    }

    function fees(uint256 tokenId) external view returns (uint256 feeAmount0, uint256 feeAmount1) {
        PositionFull memory p = fullPositions[tokenId];
        feeAmount0 = p.feeAmount0;
        feeAmount1 = p.feeAmount1;
    }

    function totalSupply() external view returns (uint256) {
        return totalSupplyStorage;
    }

    function tokenByIndex(uint256 index) external view returns (uint256) {
        return tokenByIndexStorage[index];
    }

    function setTokenByIndex(uint256 index, uint256 tokenId) external {
        tokenByIndexStorage[index] = tokenId;
        if (index + 1 > totalSupplyStorage) {
            totalSupplyStorage = index + 1;
        }
    }

    function setFullPosition(
        uint256 tokenId,
        address token0,
        address token1,
        uint24 fee,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 feeAmount0,
        uint256 feeAmount1
    ) external {
        fullPositions[tokenId] = PositionFull({
            token0: token0,
            token1: token1,
            fee: fee,
            tickLower: tickLower,
            tickUpper: tickUpper,
            liquidity: liquidity,
            feeAmount0: feeAmount0,
            feeAmount1: feeAmount1
        });
    }

    function setBasicPosition(
        uint256 tokenId,
        address token0,
        address token1,
        uint24 fee,
        uint128 liquidity
    ) external {
        fullPositions[tokenId] = PositionFull({
            token0: token0,
            token1: token1,
            fee: fee,
            tickLower: 0,
            tickUpper: 0,
            liquidity: liquidity,
            feeAmount0: 0,
            feeAmount1: 0
        });
    }

    function setFactory(address newFactory) external {
        uniFactory = newFactory;
    }
}
