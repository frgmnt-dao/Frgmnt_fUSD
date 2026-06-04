module.exports = {
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
    'contracts/guards/contractGuards/MorphoBlueRewardClaimGuard.sol',
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
