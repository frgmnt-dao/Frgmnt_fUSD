module.exports = {
  // Normal Hardhat compilation stays on the faster non-IR path.
  // Coverage instrumentation adds stack pressure, so coverage uses IR only here.
  //
  // irMinimum forces EVERY file into a fixed "stack allocation only, zero
  // optimizer steps" Yul mode with no per-file escape hatch, which is too
  // weak for a handful of complex guard contracts (and the two test
  // harnesses built on top of one of them) — they need real optimization to
  // resolve stack-too-deep. Those files get explicit viaIR + low `runs`
  // overrides in hardhat.config.ts instead (gated on COVERAGE_BUILD, which
  // the `coverage` npm script sets), so irMinimum stays off here.
  viaIR: true,
  irMinimum: false,
  skipFiles: [
    // Mocks — test helpers, not production code
    'contracts/mocks',
    // Complex guards with stack-too-deep under instrumentation
    'contracts/guards/contractGuards/MorphoBlueContractGuard.sol',
    'contracts/guards/contractGuards/AaveLendingPoolGuardV3.sol',
    'contracts/guards/contractGuards/uniswapV3/UniswapV3NonfungiblePositionGuard.sol',
    'contracts/guards/contractGuards/uniswapV3/UniswapV3RouterGuard.sol',
    // Asset guards not yet tested (complex DeFi integrations)
    'contracts/guards/assetGuards/AaveLendingPoolAssetGuard.sol',
    'contracts/guards/assetGuards/ClosedAssetGuard.sol',
    'contracts/guards/assetGuards/MorphoBlueLendingPoolAssetGuard.sol',
    'contracts/guards/assetGuards/UniswapV3AssetGuard.sol',
    // Contract guards not yet tested
    'contracts/guards/contractGuards/MorphoBlueManager.sol',
    'contracts/guards/contractGuards/MerklRewardClaimGuard.sol',
    // External/utility contracts
    'contracts/utils/DateTime.sol',
    'contracts/utils/SafeERC20.sol',
    'contracts/utils/ProxyAdmin.sol',
    'contracts/utils/AddressHelper.sol',
    'contracts/utils/MorphoMathLib.sol',
    'contracts/utils/MorphoChecksLib.sol',
    'contracts/utils/MorphoCollectLib.sol',
    'contracts/utils/PrecisionHelper.sol',
    'contracts/utils/PoolLogicFlashloanAave.sol',
    'contracts/utils/PoolLogicFlashloanMorpho.sol',
    'contracts/Timelock.sol',
    'contracts/priceAggregators/UniV3TWAPAggregator.sol',
    'contracts/priceAggregators/USDPriceAggregator.sol',
  ],
};
