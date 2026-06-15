// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal Uniswap V3 pool mock used by UniswapV3PriceLibrary tests.
contract MockUniswapV3Pool {
    address private _token0;
    address private _token1;
    uint160 private _sqrtPriceX96;
    int24 private _tick;
    uint256 public feeGrowthGlobal0X128;
    uint256 public feeGrowthGlobal1X128;

    struct TickData {
        uint256 feeGrowthOutside0X128;
        uint256 feeGrowthOutside1X128;
    }

    mapping(int24 => TickData) private _ticks;

    constructor(address token0_, address token1_, uint160 sqrtPriceX96_) {
        _token0 = token0_;
        _token1 = token1_;
        _sqrtPriceX96 = sqrtPriceX96_;
    }

    function token0() external view returns (address) {
        return _token0;
    }

    function token1() external view returns (address) {
        return _token1;
    }

    /// @notice Mimic Uniswap V3 slot0() signature.
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        // We only care about sqrtPriceX96 for our tests, others can be zero.
        sqrtPriceX96 = _sqrtPriceX96;
        tick = _tick;
        observationIndex = 0;
        observationCardinality = 0;
        observationCardinalityNext = 0;
        feeProtocol = 0;
        unlocked = true;
    }

    function setSqrtPriceX96(uint160 newSqrtPriceX96) external {
        _sqrtPriceX96 = newSqrtPriceX96;
    }

    function setTick(int24 newTick) external {
        _tick = newTick;
    }

    function setFeeGrowthGlobal(uint256 feeGrowthGlobal0X128_, uint256 feeGrowthGlobal1X128_) external {
        feeGrowthGlobal0X128 = feeGrowthGlobal0X128_;
        feeGrowthGlobal1X128 = feeGrowthGlobal1X128_;
    }

    function setTickFeeGrowth(
        int24 tick,
        uint256 feeGrowthOutside0X128,
        uint256 feeGrowthOutside1X128
    ) external {
        _ticks[tick] = TickData({
            feeGrowthOutside0X128: feeGrowthOutside0X128,
            feeGrowthOutside1X128: feeGrowthOutside1X128
        });
    }

    function ticks(
        int24 tick
    )
        external
        view
        returns (
            uint128 liquidityGross,
            int128 liquidityNet,
            uint256 feeGrowthOutside0X128,
            uint256 feeGrowthOutside1X128,
            int56 tickCumulativeOutside,
            uint160 secondsPerLiquidityOutsideX128,
            uint32 secondsOutside,
            bool initialized
        )
    {
        TickData memory data = _ticks[tick];
        return (
            0,
            0,
            data.feeGrowthOutside0X128,
            data.feeGrowthOutside1X128,
            0,
            0,
            0,
            true
        );
    }

    function observe(
        uint32[] calldata secondsAgos
    )
        external
        pure
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        for (uint256 i; i < secondsAgos.length; ++i) {
            secondsPerLiquidityCumulativeX128s[i] = secondsAgos[i] == 0
                ? type(uint160).max >> 32
                : 0;
        }
    }
}
