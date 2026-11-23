import { ethers, upgrades } from 'hardhat';
import fs from 'fs';
import path from 'path';
import hre from 'hardhat';
import { assertProxyAdminOwner } from './utils/ownership';
import { validateEurUsdFeed } from './utils/validateEurUsdFeed';

// REAL BASE MAINNET deployment of a fresh EUR-pegged pool, for INTERNAL TESTING ONLY (not a
// public launch) — one single deployer wallet holds every role (manager, emergency address,
// AssetHandler/PoolManagerLogic/PoolLogic owner, TokenLogic admin). Adapted from the proven
// scripts/fork/deploy_eur_fresh.ts rehearsal, which was run and verified repeatedly against a
// local fork before this script was written.
//
// Real EUR/USD oracle: 0xc91D87E81faB8f93699ECf7Ee9B44D11e1D53F0F ("EUR / USD", 8 decimals,
// genuine FX pair) — confirmed live on-chain. Passes scripts/utils/validateEurUsdFeed.ts
// unmodified; no bypass. (An earlier rehearsal wrongly concluded no such feed existed on Base,
// traced to a parsing error reading Chainlink's own feed-directory page — corrected after direct
// on-chain verification; see docs/reports/feuro-fresh-deployment-report.md Section 3.)
//
// KNOWN LIMITATION, accepted deliberately for this internal-testing deployment: because the same
// single wallet holds both the pool-manager role and would own MorphoBlueManager,
// MorphoBlueManager.setPoolMarkets()'s own M-11 self-dealing check (owner == pool manager/trader)
// can never be satisfied — not just after a later handoff, from the very first call. Morpho Blue
// lending is therefore NOT configured in this deployment; MorphoBlueManager/ContractGuard/
// AssetGuard are still deployed and registered so the integration exists in the system, just with
// zero live markets. Aave V3, Uniswap V3, and all core deposit/stake/withdraw paths are
// unaffected. Introducing a second address for just that one ownership slot later would unblock
// Morpho Blue without touching anything else.
//
// SAFETY GATE: by default this script only validates inputs and prints exactly what it would do
// (dry run) — it NEVER deploys or sends a transaction unless run with SEND=1. This is the first
// script in this engagement to ever target real Base mainnet; treat that deliberately.

const EUR_USD_FEED_BASE = '0xc91D87E81faB8f93699ECf7Ee9B44D11e1D53F0F'; // real, genuine EUR/USD, confirmed live on-chain
const EUR_USD_TIMEOUT_SECONDS = 24n * 60n * 60n; // 24h — wide margin over the feed's ~1h heartbeat; permanent once set (FNA-40), chosen deliberately

const POOL_MANAGER_NAME = 'Frgmnt EURO (internal test)';

const TOKEN_NAME = 'Frgmnt EURO';
const TOKEN_SYMBOL = 'fEURO';
const SHARE_TOKEN_NAME = 'Staked Frgmnt EURO';
const SHARE_TOKEN_SYMBOL = 'sfEURO';

const COOLDOWN_SECONDS = 60n * 60n; // 1h — deliberately short for internal testing; adjustable anytime via setCooldown(), unlike the oracle choice
const PERFORMANCE_FEE_NUMERATOR = 2000n;
const MANAGER_FEE_NUMERATOR = 0n;
const TIMELOCK_DELAY_SECONDS = 48n * 60n * 60n;
const SEQUENCER_UPTIME_FEED = '0xBCF85224fc0756B9Fa45aA7892530B47e10b6433';
const DEPOSIT_CAP_FEURO = ethers.parseUnits('10000', 18); // scoped down from the rehearsal's 500,000 for internal testing

// Real Base mainnet addresses, same ones verified and used throughout this engagement.
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_FEED = '0x7e860098F58bBFC8648a4311b374B1D669a2bc6B';
const SHARED_PREVALUED_FEED = '0x5bb4eA3b0187bb503c81Bd91Ebc2A1021497e538';
const UNISWAP_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';
const UNI_POSITION_MANAGER = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const AAVE_POOL = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';
const AAVE_DATA_PROVIDER = '0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A';
const MORPHO_CORE = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';

async function main() {
  if (hre.network.name !== 'base') {
    throw new Error(
      'Run this with --network base (real Base mainnet). Rehearse on baseFork first if you have not already.',
    );
  }

  const sendLive = process.env.SEND === '1';

  const [signer] = await ethers.getSigners();
  const deployerAddr = await signer.getAddress();
  const owner = deployerAddr; // single wallet for every role, per explicit instruction

  console.log('=== REAL BASE MAINNET — fresh fEURO deployment (internal testing) ===');
  console.log(
    'Mode:',
    sendLive
      ? '!!! SEND=1 — THIS WILL BROADCAST REAL TRANSACTIONS !!!'
      : 'DRY RUN (no transactions will be sent — set SEND=1 to actually deploy)',
  );
  console.log('Deployer / sole role-holder:', deployerAddr);

  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 8453n) {
    throw new Error(`Expected chainId 8453 (Base mainnet), got ${network.chainId}`);
  }
  const balance = await ethers.provider.getBalance(deployerAddr);
  console.log('Deployer ETH balance:', ethers.formatEther(balance));
  if (balance === 0n) {
    throw new Error(
      'Deployer wallet has zero ETH on Base mainnet — fund it with gas before proceeding.',
    );
  }

  console.log('\n=== Validating the EUR/USD price source (real validator, no bypass) ===');
  const validation = await validateEurUsdFeed(
    EUR_USD_FEED_BASE,
    EUR_USD_TIMEOUT_SECONDS,
    ethers.provider,
  );
  console.log(`  feed: ${validation.feed}`);
  console.log(`  description: "${validation.description}"`);
  console.log(
    `  decimals: ${validation.decimals}, price: ${validation.formattedAnswer}, updatedAt: ${validation.updatedAt}`,
  );
  console.log('  Validator passed with NO bypass — genuine EUR/USD feed.');

  console.log('\n=== Configuration summary ===');
  console.log(
    '  Pool manager / emergency address / every owner role:',
    owner,
    '(single wallet, as instructed)',
  );
  console.log(
    '  EUR/USD timeout:',
    EUR_USD_TIMEOUT_SECONDS.toString(),
    'seconds (permanent once set — FNA-40)',
  );
  console.log('  Exit cooldown:', COOLDOWN_SECONDS.toString(), 'seconds (adjustable later)');
  console.log(
    '  Deposit cap:',
    ethers.formatUnits(DEPOSIT_CAP_FEURO, 18),
    'fEURO (adjustable later)',
  );
  console.log(
    '  Morpho Blue: guards deployed, but NO markets configured (M-11 self-dealing check cannot be satisfied with a single-wallet owner/manager — see header comment). Aave V3 + Uniswap V3 fully configured.',
  );
  console.log(
    '  Attested withdrawal plan feature: NOT initialized (not needed for internal testing; can be added later via PoolLogic.initializeAttestedWithdrawal()).',
  );

  if (!sendLive) {
    console.log('\nDry run complete. Re-run with SEND=1 to actually deploy to Base mainnet.');
    return;
  }

  console.log('\n!!! SEND=1 set — proceeding to deploy for real on Base mainnet !!!');

  // ============================================================
  // 1) Libraries
  // ============================================================
  console.log('\n=== Deploying libraries ===');
  const FundCalculationLibrary = await ethers.getContractFactory('FundCalculationLibrary', signer);
  const fundLib = await FundCalculationLibrary.deploy();
  await fundLib.waitForDeployment();

  const CallResultChecker = await ethers.getContractFactory('CallResultChecker', signer);
  const callChecker = await CallResultChecker.deploy();
  await callChecker.waitForDeployment();

  const PoolTxExecutor = await ethers.getContractFactory('PoolTxExecutor', {
    signer,
    libraries: { CallResultChecker: await callChecker.getAddress() },
  });
  const poolTxExecutor = await PoolTxExecutor.deploy();
  await poolTxExecutor.waitForDeployment();

  const WithdrawalPlanLib = await ethers.getContractFactory('WithdrawalPlanLib', {
    signer,
    libraries: { FundCalculationLibrary: await fundLib.getAddress() },
  });
  const withdrawalPlanLib = await WithdrawalPlanLib.deploy();
  await withdrawalPlanLib.waitForDeployment();
  console.log('  Libraries deployed.');

  // ============================================================
  // 2) Governance + Timelock
  // ============================================================
  console.log('\n=== Deploying Governance + Timelock ===');
  const Governance = await ethers.getContractFactory('Governance', signer);
  const governance = await Governance.deploy(owner);
  await governance.waitForDeployment();
  console.log('  Governance:', await governance.getAddress());

  const Timelock = await ethers.getContractFactory('Timelock', signer);
  const timelock = await Timelock.deploy(TIMELOCK_DELAY_SECONDS.toString(), [owner], [], owner);
  await timelock.waitForDeployment();
  console.log('  Timelock:', await timelock.getAddress());

  // ============================================================
  // 3) AssetHandler (proxy) + EUR/USD conversion
  // ============================================================
  console.log('\n=== Deploying AssetHandler ===');
  const AssetHandler = await ethers.getContractFactory('AssetHandler', signer);
  const assetHandler = await upgrades.deployProxy(AssetHandler, [[]], {
    initializer: 'initialize',
    initialOwner: owner,
  });
  await assetHandler.waitForDeployment();
  const assetHandlerProxy = await assetHandler.getAddress();
  console.log('  AssetHandler (proxy):', assetHandlerProxy);

  await (await assetHandler.setEurUsdAggregator(EUR_USD_FEED_BASE, EUR_USD_TIMEOUT_SECONDS)).wait();
  console.log('  AssetHandler EUR/USD conversion configured (real feed, no bypass).');

  await (await assetHandler.setSequencerUptimeFeed(SEQUENCER_UPTIME_FEED)).wait();
  console.log('  AssetHandler sequencer feed set.');

  // ============================================================
  // 4) PoolManagerLogic (proxy)
  // ============================================================
  console.log('\n=== Deploying PoolManagerLogic ===');
  const PoolManagerLogic = await ethers.getContractFactory('PoolManagerLogic', signer);
  const poolManagerLogic = await upgrades.deployProxy(
    PoolManagerLogic,
    [
      deployerAddr,
      owner,
      POOL_MANAGER_NAME,
      ethers.ZeroAddress,
      assetHandlerProxy,
      await governance.getAddress(),
      PERFORMANCE_FEE_NUMERATOR,
      MANAGER_FEE_NUMERATOR,
    ],
    { initializer: 'initialize', initialOwner: owner },
  );
  await poolManagerLogic.waitForDeployment();
  const poolManagerProxy = await poolManagerLogic.getAddress();
  console.log('  PoolManagerLogic (proxy):', poolManagerProxy);

  // ============================================================
  // 5) TokenLogic / fEURO (UUPS proxy)
  // ============================================================
  console.log('\n=== Deploying TokenLogic (fEURO) ===');
  const TokenLogic = await ethers.getContractFactory('TokenLogic', signer);
  const tokenLogic = await upgrades.deployProxy(
    TokenLogic,
    [
      deployerAddr,
      owner,
      ethers.ZeroAddress,
      poolManagerProxy,
      COOLDOWN_SECONDS.toString(),
      TOKEN_NAME,
      TOKEN_SYMBOL,
    ],
    { initializer: 'initialize', kind: 'uups' },
  );
  await tokenLogic.waitForDeployment();
  const fusdProxy = await tokenLogic.getAddress();
  console.log(`  TokenLogic / ${TOKEN_SYMBOL} (proxy):`, fusdProxy);

  // ============================================================
  // 6) PoolLogic (proxy)
  // ============================================================
  console.log('\n=== Deploying PoolLogic (sfEURO) ===');
  const PoolLogic = await ethers.getContractFactory('PoolLogic', {
    signer,
    libraries: {
      FundCalculationLibrary: await fundLib.getAddress(),
      PoolTxExecutor: await poolTxExecutor.getAddress(),
      CallResultChecker: await callChecker.getAddress(),
      WithdrawalPlanLib: await withdrawalPlanLib.getAddress(),
    },
  });
  const poolLogic = await upgrades.deployProxy(
    PoolLogic,
    [fusdProxy, poolManagerProxy, owner, SHARE_TOKEN_NAME, SHARE_TOKEN_SYMBOL],
    {
      initializer: 'initialize',
      initialOwner: owner,
      unsafeAllowLinkedLibraries: true,
      unsafeAllow: ['missing-initializer-call'],
    },
  );
  await poolLogic.waitForDeployment();
  const poolLogicProxy = await poolLogic.getAddress();
  console.log('  PoolLogic (proxy):', poolLogicProxy);

  // ============================================================
  // 7) Link everything
  // ============================================================
  console.log('\n=== Linking PoolLogic to Manager + Token ===');
  const pm = await ethers.getContractAt('PoolManagerLogic', poolManagerProxy, signer);
  const fusd = await ethers.getContractAt('TokenLogic', fusdProxy, signer);

  await (await pm.setPoolLogic(poolLogicProxy)).wait();
  await (await fusd.setPoolLogic(poolLogicProxy)).wait();
  console.log('  Linked.');

  const WithdrawalEscrowFactory = await ethers.getContractFactory('WithdrawalEscrow', signer);
  const withdrawalEscrow = await WithdrawalEscrowFactory.deploy(poolLogicProxy);
  await withdrawalEscrow.waitForDeployment();
  const withdrawalEscrowAddress = await withdrawalEscrow.getAddress();
  await (await poolLogic.initializeWithdrawalEscrow(withdrawalEscrowAddress)).wait();
  console.log('  WithdrawalEscrow deployed and wired:', withdrawalEscrowAddress);

  await assertProxyAdminOwner('AssetHandler', assetHandlerProxy, owner, signer);
  await assertProxyAdminOwner('PoolManagerLogic', poolManagerProxy, owner, signer);
  await assertProxyAdminOwner('PoolLogic', poolLogicProxy, owner, signer);
  console.log('  ProxyAdmin ownership confirmed on all three Transparent proxies.');

  // ============================================================
  // 8) Deploy guards
  // ============================================================
  console.log('\n=== Deploying guards ===');

  const NftTrackerStorage = await ethers.getContractFactory('NftTrackerStorage', signer);
  const nftTracker = await upgrades.deployProxy(NftTrackerStorage, [poolManagerProxy], {
    initializer: 'initialize',
    kind: 'transparent',
  });
  await nftTracker.waitForDeployment();
  const nftTrackerProxy = await nftTracker.getAddress();
  console.log('  NftTrackerStorage (proxy):', nftTrackerProxy);

  const SlippageAccumulator = await ethers.getContractFactory('SlippageAccumulator', signer);
  const slippage = await SlippageAccumulator.deploy(poolManagerProxy, 21600, 50000);
  await slippage.waitForDeployment();
  console.log('  SlippageAccumulator:', await slippage.getAddress());

  const MorphoManagerFactory = await ethers.getContractFactory('MorphoBlueManager', signer);
  const morphoManager = await MorphoManagerFactory.deploy(MORPHO_CORE);
  await morphoManager.waitForDeployment();
  console.log(
    '  MorphoBlueManager:',
    await morphoManager.getAddress(),
    '(deployed, but setPoolMarkets() deliberately NOT called — see header comment)',
  );

  const MorphoGuardFactory = await ethers.getContractFactory('MorphoBlueContractGuard', signer);
  const morphoGuard = await MorphoGuardFactory.deploy(await morphoManager.getAddress());
  await morphoGuard.waitForDeployment();
  console.log('  MorphoBlueContractGuard:', await morphoGuard.getAddress());

  const UniV3RouterGuardFactory = await ethers.getContractFactory('UniswapV3RouterGuard', signer);
  const uniV3RouterGuard = await UniV3RouterGuardFactory.deploy(await slippage.getAddress());
  await uniV3RouterGuard.waitForDeployment();
  console.log('  UniswapV3RouterGuard:', await uniV3RouterGuard.getAddress());

  const UniNFTFactory = await ethers.getContractFactory(
    'UniswapV3NonfungiblePositionGuard',
    signer,
  );
  const uniNFT = await UniNFTFactory.deploy(50, nftTrackerProxy, await slippage.getAddress());
  await uniNFT.waitForDeployment();
  console.log('  UniswapV3NonfungiblePositionGuard:', await uniNFT.getAddress());

  const AaveContractGuardFactory = await ethers.getContractFactory(
    'AaveLendingPoolGuardV3',
    signer,
  );
  const aaveContractGuard = await AaveContractGuardFactory.deploy(AAVE_DATA_PROVIDER);
  await aaveContractGuard.waitForDeployment();
  console.log('  AaveLendingPoolGuardV3:', await aaveContractGuard.getAddress());

  const UniAssetGuardFactory = await ethers.getContractFactory('UniswapV3AssetGuard', signer);
  const uniAssetGuard = await UniAssetGuardFactory.deploy();
  await uniAssetGuard.waitForDeployment();
  console.log('  UniswapV3AssetGuard:', await uniAssetGuard.getAddress());
  await (await uniAssetGuard.setAdmin(owner)).wait();

  const AaveAssetGuardFactory = await ethers.getContractFactory(
    'AaveV3LendingPoolAssetGuard',
    signer,
  );
  const aaveAssetGuard = await AaveAssetGuardFactory.deploy(
    AAVE_DATA_PROVIDER,
    AAVE_POOL,
    USDC,
    UNISWAP_ROUTER,
  );
  await aaveAssetGuard.waitForDeployment();
  console.log('  AaveV3LendingPoolAssetGuard:', await aaveAssetGuard.getAddress());

  const MorphoCollectLibFactory = await ethers.getContractFactory('MorphoCollectLib', signer);
  const morphoCollectLib = await MorphoCollectLibFactory.deploy();
  await morphoCollectLib.waitForDeployment();

  const MorphoAssetGuardFactory = await ethers.getContractFactory(
    'MorphoBlueLendingPoolAssetGuard',
    {
      signer,
      libraries: { MorphoCollectLib: await morphoCollectLib.getAddress() },
    },
  );
  const morphoAssetGuard = await MorphoAssetGuardFactory.deploy(
    MORPHO_CORE,
    await morphoManager.getAddress(),
    UNISWAP_ROUTER,
    USDC,
  );
  await morphoAssetGuard.waitForDeployment();
  console.log('  MorphoBlueLendingPoolAssetGuard:', await morphoAssetGuard.getAddress());

  const ERC20GuardFactory = await ethers.getContractFactory('ERC20Guard', signer);
  const erc20Guard = await ERC20GuardFactory.deploy();
  await erc20Guard.waitForDeployment();
  console.log('  ERC20Guard:', await erc20Guard.getAddress());

  await (await aaveAssetGuard.setOwner(owner)).wait();

  // ============================================================
  // 9) Register everything
  // ============================================================
  console.log('\n=== Registering guards + assets ===');
  await (
    await governance.setContractGuard(UNISWAP_ROUTER, await uniV3RouterGuard.getAddress())
  ).wait();
  await (await governance.setContractGuard(UNI_POSITION_MANAGER, await uniNFT.getAddress())).wait();
  await (await governance.setContractGuard(MORPHO_CORE, await morphoGuard.getAddress())).wait();
  await (await governance.setContractGuard(AAVE_POOL, await aaveContractGuard.getAddress())).wait();
  await (await governance.setAssetGuard(1n, await morphoAssetGuard.getAddress())).wait();
  await (await governance.setAssetGuard(2n, await aaveAssetGuard.getAddress())).wait();
  await (await governance.setAssetGuard(3n, await uniAssetGuard.getAddress())).wait();
  await (await governance.setAssetGuard(4n, await erc20Guard.getAddress())).wait();
  console.log('  Contract + asset guards registered.');

  const ONE_DAY = 24 * 60 * 60;
  const pseudoAssets: [string, number][] = [
    [MORPHO_CORE, 1],
    [AAVE_POOL, 2],
    [UNI_POSITION_MANAGER, 3],
  ];
  for (const [addr, type] of pseudoAssets) {
    await (await assetHandler.addAsset(addr, type, SHARED_PREVALUED_FEED)).wait();
    await (await assetHandler.setChainlinkTimeout(addr, ONE_DAY)).wait();
  }
  await (await assetHandler.addAsset(USDC, 4, USDC_FEED)).wait();
  await (await assetHandler.setChainlinkTimeout(USDC, ONE_DAY)).wait();
  console.log('  Pseudo-assets (Morpho/Aave/Uniswap) + real USDC registered on AssetHandler.');

  await (
    await pm.changeAssets(
      [
        { asset: USDC, isDeposit: true },
        { asset: MORPHO_CORE, isDeposit: false },
        { asset: AAVE_POOL, isDeposit: false },
        { asset: UNI_POSITION_MANAGER, isDeposit: false },
      ],
      [],
    )
  ).wait();
  console.log('  Supported assets registered on PoolManagerLogic.');

  await (await fusd.configureAsset(USDC, true, 0n)).wait();
  console.log('  TokenLogic.configureAsset(USDC, allowed=true) done.');

  await (await fusd.initializeDepositFusdCap(DEPOSIT_CAP_FEURO)).wait();
  console.log(
    `  TokenLogic.initializeDepositFusdCap(${ethers.formatUnits(DEPOSIT_CAP_FEURO, 18)} fEURO) done.`,
  );

  console.log(
    '  Morpho Blue markets: deliberately NOT configured (single-wallet M-11 constraint — see header comment).',
  );

  // ============================================================
  // Save + summary
  // ============================================================
  const out = {
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    product: 'EUR',
    note: 'REAL BASE MAINNET deployment for internal testing only. Single deployer wallet holds every role. Morpho Blue markets NOT configured (M-11 self-dealing check cannot be satisfied with owner == manager).',
    deployer: deployerAddr,
    eurUsdFeed: {
      address: EUR_USD_FEED_BASE,
      description: validation.description,
      decimals: validation.decimals.toString(),
      answer: validation.answer.toString(),
    },
    depositCapFeuro: ethers.formatUnits(DEPOSIT_CAP_FEURO, 18),
    cooldownSeconds: COOLDOWN_SECONDS.toString(),
    governance: await governance.getAddress(),
    timelock: await timelock.getAddress(),
    assetHandler: assetHandlerProxy,
    poolManagerLogic: poolManagerProxy,
    tokenLogic: fusdProxy,
    poolLogic: poolLogicProxy,
    withdrawalEscrow: withdrawalEscrowAddress,
    guards: {
      NftTrackerStorage: nftTrackerProxy,
      SlippageAccumulator: await slippage.getAddress(),
      MorphoBlueManager: await morphoManager.getAddress(),
      MorphoBlueContractGuard: await morphoGuard.getAddress(),
      UniswapV3RouterGuard: await uniV3RouterGuard.getAddress(),
      UniswapV3NonfungiblePositionGuard: await uniNFT.getAddress(),
      AaveLendingPoolGuardV3: await aaveContractGuard.getAddress(),
      UniswapV3AssetGuard: await uniAssetGuard.getAddress(),
      AaveV3LendingPoolAssetGuard: await aaveAssetGuard.getAddress(),
      MorphoBlueLendingPoolAssetGuard: await morphoAssetGuard.getAddress(),
      ERC20Guard: await erc20Guard.getAddress(),
    },
  };
  const dir = path.join(process.cwd(), 'deployments');
  fs.mkdirSync(dir, { recursive: true });
  const outFile = path.join(dir, `deploy-eur-mainnet-internal-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));

  console.log('\n=== Sanity checks ===');
  console.log('  TokenLogic.name():', await fusd.name());
  console.log('  TokenLogic.symbol():', await fusd.symbol());
  console.log('  PoolLogic.name():', await poolLogic.name());
  console.log('  PoolLogic.symbol():', await poolLogic.symbol());
  const usdcEurPrice = await assetHandler.getUSDPrice(USDC);
  console.log(
    `  AssetHandler.getUSDPrice(USDC) [EUR-converted]: ${ethers.formatUnits(usdcEurPrice, 18)}`,
  );

  console.log('\nDEPLOYMENT COMPLETE on real Base mainnet. Saved to', outFile);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
