# Deployments

## Base Network (Chain ID: 8453)

**Deployer:** `0xafb9B883637f72767ADf7193Bb3B8e59C02Ea05d`
**Release:** Beta

### Core Protocol

| Contract | Address | Description | Explorer |
|----------|---------|-------------|---------|
| TokenLogic (fUSD) | `0xeB82611A2B2dC9FBEAF5903d5decDf801765B759` | fUSD ERC20 stablecoin (UUPS proxy) | [Basescan](https://basescan.org/address/0xeB82611A2B2dC9FBEAF5903d5decDf801765B759) |
| PoolLogic (sfUSD) | `0x704c56974e0CA4BF8ff8fe8acc51FBF1E053878E` | sfUSD vault (Transparent proxy) | [Basescan](https://basescan.org/address/0x704c56974e0CA4BF8ff8fe8acc51FBF1E053878E) |
| PoolManagerLogic | `0x9530E699E519D7BCF621BA7CA17e119B6865b5C7` | Pool configuration (Transparent proxy) | [Basescan](https://basescan.org/address/0x9530E699E519D7BCF621BA7CA17e119B6865b5C7) |
| Governance | `0xC393A896D15641cA970F682BE62e89347941985d` | Guard registry | [Basescan](https://basescan.org/address/0xC393A896D15641cA970F682BE62e89347941985d) |
| Timelock | `0xD3e2691b0c765EAD8A0041e76b5e51E28967Ea3e` | DAO governance timelock | [Basescan](https://basescan.org/address/0xD3e2691b0c765EAD8A0041e76b5e51E28967Ea3e) |

### Price Infrastructure

| Contract | Address | Description | Explorer |
|----------|---------|-------------|---------|
| AssetHandler | `0x387174F4B3676c7F6e06da9c6c855375B5b10AAB` | Chainlink price feed registry (Transparent proxy) | [Basescan](https://basescan.org/address/0x387174F4B3676c7F6e06da9c6c855375B5b10AAB) |
| USDPriceAggregator | `0x5bb4eA3b0187bb503c81Bd91Ebc2A1021497e538` | Fixed $1.00 USD price aggregator | [Basescan](https://basescan.org/address/0x5bb4eA3b0187bb503c81Bd91Ebc2A1021497e538) |

### Asset Guards

| Contract | Asset Type | Address | Explorer |
|----------|-----------|---------|---------|
| ERC20Guard | Type 0 | `0x26E11DC5C05ee07Cb14A2Fd475C71aAEd2F0A98C` | [Basescan](https://basescan.org/address/0x26E11DC5C05ee07Cb14A2Fd475C71aAEd2F0A98C) |
| AaveV3LendingPoolAssetGuard | Type 4 | `0xE5bc2963f3fdE832d798caC2024343C83aDD2A38` | [Basescan](https://basescan.org/address/0xE5bc2963f3fdE832d798caC2024343C83aDD2A38) |
| MorphoBlueAssetGuard | Type 5 | `0x27BeceFb6CF59b26CD73dac227Ae3597065E2850` | [Basescan](https://basescan.org/address/0x27BeceFb6CF59b26CD73dac227Ae3597065E2850) |
| UniswapV3AssetGuard | Type 7 | `0xB186BA1634d4F99798ed663319aF6ac328086DF1` | [Basescan](https://basescan.org/address/0xB186BA1634d4F99798ed663319aF6ac328086DF1) |

### Contract Guards

| Contract | Target Protocol | Address | Explorer |
|----------|----------------|---------|---------|
| AaveLendingPoolGuardV3 | Aave V3 Pool | `0x7Ef5442f796bF1Ae3e00E91a5527cAa5F7aba5A4` | [Basescan](https://basescan.org/address/0x7Ef5442f796bF1Ae3e00E91a5527cAa5F7aba5A4) |
| MorphoBlueContractGuard | Morpho Blue | `0x7A4701fAB443687F9EADCa68Ef0B207729a5acEa` | [Basescan](https://basescan.org/address/0x7A4701fAB443687F9EADCa68Ef0B207729a5acEa) |
| MorphoBlueManager | Morpho Blue | `0x7C700a84365546675B5699206e449B88756E066E` | [Basescan](https://basescan.org/address/0x7C700a84365546675B5699206e449B88756E066E) |
| MorphoBlueRewardClaimGuard | Morpho Rewards | `0x0F61cDAa75395f89695E89bFC85EC74044fBb2Af` | [Basescan](https://basescan.org/address/0x0F61cDAa75395f89695E89bFC85EC74044fBb2Af) |
| UniswapV3RouterGuard | Uniswap V3 Router | `0xcAE75F063Ef5b432F4ad3140960c888a0795d5DC` | [Basescan](https://basescan.org/address/0xcAE75F063Ef5b432F4ad3140960c888a0795d5DC) |
| UniswapV3NonfungiblePositionGuard | Uniswap V3 NonfungiblePositionManager | `0xA313f1AADFB45033498a20e2e2cfefD31D10c973` | [Basescan](https://basescan.org/address/0xA313f1AADFB45033498a20e2e2cfefD31D10c973) |

### Libraries & Infrastructure

| Contract | Address | Description | Explorer |
|----------|---------|-------------|---------|
| FundCalculationLibrary | `0x0f5c9E2a13817E7b79B47Ee6a550fCAB8433030c` | Shared fund valuation library | [Basescan](https://basescan.org/address/0x0f5c9E2a13817E7b79B47Ee6a550fCAB8433030c) |
| CallResultChecker | `0x1574827fF626CD70eE5c2AD8fA20Ccf4e999156c` | Transaction result validation utility | [Basescan](https://basescan.org/address/0x1574827fF626CD70eE5c2AD8fA20Ccf4e999156c) |
| PoolTxExecutor | `0xda955368c94c582B75B008a32C20E1c1705B2e73` | Guard dispatch executor | [Basescan](https://basescan.org/address/0xda955368c94c582B75B008a32C20E1c1705B2e73) |
| MorphoCollectLib | `0x084c3db85442F6002D6d5DB33ABA61eFC69fF18C` | Morpho reward collection library | [Basescan](https://basescan.org/address/0x084c3db85442F6002D6d5DB33ABA61eFC69fF18C) |
| SlippageAccumulator | `0xcf8aCb91851D6651649598aaE175b61ab20c70cB` | Cumulative slippage tracker | [Basescan](https://basescan.org/address/0xcf8aCb91851D6651649598aaE175b61ab20c70cB) |
| NftTrackerStorage | `0x84F46CD368f0CB7290c47738B53b7B7FEC5aFF49` | NFT position registry (Transparent proxy) | [Basescan](https://basescan.org/address/0x84F46CD368f0CB7290c47738B53b7B7FEC5aFF49) |

---

## Implementation Addresses (Base)

UUPS and Transparent proxies have separate logic contracts. Interact only through the proxy addresses above.

| Proxy Contract | Implementation Address | Explorer |
|---------------|----------------------|---------|
| TokenLogic (UUPS) | `0x4DC02b3450B0659095096C474Da2C31E817BCd6c` | [Basescan](https://basescan.org/address/0x4DC02b3450B0659095096C474Da2C31E817BCd6c) |
| PoolLogic | `0x3dE5AB1b21f3AeA66b69c90550A93425109a00C2` | [Basescan](https://basescan.org/address/0x3dE5AB1b21f3AeA66b69c90550A93425109a00C2) |
| PoolManagerLogic | `0xB49Db5579a99c30Fb4204eC400a398D404acc08b` | [Basescan](https://basescan.org/address/0xB49Db5579a99c30Fb4204eC400a398D404acc08b) |
| AssetHandler | `0x938A17D2830302828A7c3C2DC688517eF363236C` | [Basescan](https://basescan.org/address/0x938A17D2830302828A7c3C2DC688517eF363236C) |
| NftTrackerStorage | `0x254d007E78828e3a41c5a04dfbf98D3A2726ecfF` | [Basescan](https://basescan.org/address/0x254d007E78828e3a41c5a04dfbf98D3A2726ecfF) |

---

## Proxy Admin Addresses (Base)

Transparent proxies are managed by dedicated ProxyAdmin contracts.

| Proxy | ProxyAdmin Address | Explorer |
|-------|-------------------|---------|
| AssetHandler | `0xA60a0d2C9A43C100F37A1E353c35771361CdDE85` | [Basescan](https://basescan.org/address/0xA60a0d2C9A43C100F37A1E353c35771361CdDE85) |
| PoolManagerLogic | `0xc339B2397C4AACAC19F4b0f4b028e753ff03e0AC` | [Basescan](https://basescan.org/address/0xc339B2397C4AACAC19F4b0f4b028e753ff03e0AC) |
| PoolLogic | `0xAff9948386da7C7687f0CDBB079b34F69d8199B5` | [Basescan](https://basescan.org/address/0xAff9948386da7C7687f0CDBB079b34F69d8199B5) |
| NftTrackerStorage | `0x869B9dAF9811020c588F2583415C2f660061d77B` | [Basescan](https://basescan.org/address/0x869B9dAF9811020c588F2583415C2f660061d77B) |

> **Note:** TokenLogic uses the UUPS pattern — its admin slot is `0x0000...0000` (no external ProxyAdmin). Upgrade authority is managed by the `DEFAULT_ADMIN_ROLE` (Timelock).

---

## External Protocol Addresses (Base)

These are the external protocol contracts that the Frgmnt vault integrates with on Base mainnet.

| Protocol | Contract | Address |
|----------|----------|---------|
| Aave V3 | Pool | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` |
| Aave V3 | Protocol Data Provider | `0x2d8A3C5677189723C4cB8873CfC9C8976ddf54a8` |
| Morpho Blue | Core | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` |
| Uniswap V3 | Router | `0x2626664c2603336E57B271c5C0b26F421741e481` |
| Uniswap V3 | NonfungiblePositionManager | `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1` |
| Uniswap V3 | Factory | `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` |
| Chainlink | L2 Sequencer Uptime Feed | `0xBCF85224fc0756B9Fa45aA7892530B47e10b6433` |

---

## Notes

- Always interact through the **proxy** addresses, never the implementation directly
- TokenLogic uses **UUPS** — upgrade authority is controlled by `DEFAULT_ADMIN_ROLE` (Timelock)
- PoolLogic, PoolManagerLogic, and AssetHandler use **Transparent proxies** — each has a dedicated ProxyAdmin
- All contracts are verified on [Basescan](https://basescan.org)
- The deployer EOA (`0xafb9B883637f72767ADf7193Bb3B8e59C02Ea05d`) should not retain any privileged roles in production — all admin roles should be transferred to the Timelock

## EUR Deployment Oracle Checklist

For the EUR-pegged deployment, `AssetHandler` keeps the existing `getUSDPrice()` ABI but returns EUR-denominated prices after the EUR/USD conversion feed is configured.

- `EUR_USD_FEED` must be the Chainlink EUR/USD feed for the target chain, meaning USD per 1 EUR
- Asset feeds must remain USD-denominated
- Do not register direct EUR-denominated asset feeds while `eurUsdAggregator` is enabled
- The core deployment script validates the feed description, decimals, freshness, positive answer, and sane EUR/USD range before calling `setEurUsdAggregator`
- After deployment, sanity-check USDC pricing: if `EUR/USD = 1.08`, `getUSDPrice(USDC)` should be about `0.9259e18`, not `1.08e18`
