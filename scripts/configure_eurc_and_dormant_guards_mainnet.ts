import { ethers } from 'hardhat';
import fs from 'fs';
import path from 'path';
import hre from 'hardhat';

// REAL BASE MAINNET. Phase 2 of the internal-testing fEURO deployment
// (deployments/deploy-eur-mainnet-internal-*.json):
//   A) Switch the deposit gate from USDC-only to EURC-only (EURC is Circle's real, native
//      EUR-pegged stablecoin on Base — a more natural deposit asset for a EUR product than USDC,
//      and correctly prices to ~1.0 EUR per EURC once combined with the pool's own EUR/USD
//      conversion, since EURC already tracks EUR directly).
//   B) Deploy and register, for real, the three previously fork-only "dormant" guard families
//      (AaveV4Spoke, AaveV4Tokenization, Morpho Vault V2) against this fEURO pool, reusing the
//      exact sequences already proven on the fork rehearsal
//      (scripts/fork/eur_dormant_guards_integration_test.ts), against the SAME real, live Base
//      external infrastructure that rehearsal already verified.
//
// USDC stays registered as a SUPPORTED (non-deposit) asset throughout — still usable for
// swaps/lending exposure, just no longer a user-facing deposit option.
//
// KNOWN, UNCHANGED LIMITATION: Morpho Blue markets remain unconfigured (M-11 self-dealing check,
// explained at deploy time) — this phase does not touch Morpho Blue at all.
//
// SAFETY GATE: dry run by default; only broadcasts with SEND=1.

const EURC = '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42'; // real Circle EURC, Base mainnet, confirmed on-chain (name/symbol/decimals)
const EURC_USD_FEED = '0x9867186e52d2F1C2c565CDA6E747101Fa56501e0'; // real Chainlink EURC/USD, Base, confirmed live earlier this engagement
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ONE_DAY = 24 * 60 * 60;

// Real, live Aave V4 Base addresses (Aave's own official address-book registry) — same ones
// already confirmed live on-chain during this engagement's fork rehearsal.
const MAG7_SPOKE = '0x17905Db0e4A3514467539956c084180616AE7B8D';
const GIVER_POSITION_MANAGER = '0x9E81c2fDE4E34CAB3AB1667ca3c932dBAED95F08';
const TAKER_POSITION_MANAGER = '0x8481204E528735aF2F3391AD98f36E757A56D695';
const USDC_RESERVE_ID = 7n;
const TOKENIZATION_SPOKE = '0x7081CE7EB1282c53CF38EA9B622f6269cb8FeFDc';
const VAULT_V2_FACTORY = '0x4501125508079A99ebBebCE205DeC9593C2b5857';
const FIXED_USD_AGGREGATOR = '0x5bb4eA3b0187bb503c81Bd91Ebc2A1021497e538';

const ASSET_TYPE_SPOKE = 5;
const ASSET_TYPE_TOKENIZATION = 6;
const ASSET_TYPE_VAULT_V2 = 7;

function loadDeployment() {
  const dir = path.join(process.cwd(), 'deployments');
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('deploy-eur-mainnet-internal-'));
  if (files.length === 0)
    throw new Error(
      'No deploy-eur-mainnet-internal-*.json found. Run scripts/deploy_eur_mainnet_internal.ts first.',
    );
  files.sort();
  const file = path.join(dir, files[files.length - 1]);
  return { file, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

async function main() {
  if (hre.network.name !== 'base') {
    throw new Error('Run this with --network base (real Base mainnet).');
  }
  const sendLive = process.env.SEND === '1';
  const { file: deployFile, data: d } = loadDeployment();
  console.log('Loaded mainnet deployment:', deployFile);
  console.log(
    'Mode:',
    sendLive
      ? '!!! SEND=1 — THIS WILL BROADCAST REAL TRANSACTIONS !!!'
      : 'DRY RUN (no transactions will be sent)',
  );

  const [signer] = await ethers.getSigners();
  const owner = await signer.getAddress();
  console.log('Signer / sole role-holder:', owner);
  const balance = await ethers.provider.getBalance(owner);
  console.log('ETH balance:', ethers.formatEther(balance));

  const poolLogic = await ethers.getContractAt('PoolLogic', d.poolLogic);
  const poolManagerLogic = await ethers.getContractAt('PoolManagerLogic', d.poolManagerLogic);
  const tokenLogic = await ethers.getContractAt('TokenLogic', d.tokenLogic);
  const assetHandler = await ethers.getContractAt('AssetHandler', d.assetHandler);
  const governance = await ethers.getContractAt('Governance', d.governance);

  console.log('\n=== Verifying EURC + its real market data (read-only) ===');
  const erc20Abi = [
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
  ];
  const eurcToken = await ethers.getContractAt(erc20Abi, EURC);
  console.log('  EURC symbol/decimals:', await eurcToken.symbol(), await eurcToken.decimals());
  const feedAbi = [
    'function description() view returns (string)',
    'function decimals() view returns (uint8)',
    'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
  ];
  const eurcFeed = await ethers.getContractAt(feedAbi, EURC_USD_FEED);
  const [, eurcAnswer] = await eurcFeed.latestRoundData();
  console.log(
    '  EURC/USD feed description/price:',
    await eurcFeed.description(),
    ethers.formatUnits(eurcAnswer, await eurcFeed.decimals()),
  );

  const tsRead = await ethers.getContractAt(
    ['function asset() view returns (address)'],
    TOKENIZATION_SPOKE,
  );
  const tsAsset = await tsRead.asset();
  console.log(
    '  TOKENIZATION_SPOKE.asset():',
    tsAsset,
    tsAsset.toLowerCase() === USDC.toLowerCase() ? '(USDC, as expected)' : '(unexpected!)',
  );
  const factoryCode = await ethers.provider.getCode(VAULT_V2_FACTORY);
  console.log('  Morpho VaultV2Factory has code:', factoryCode !== '0x');

  console.log('\n=== Plan ===');
  console.log(
    '  A) Register EURC on AssetHandler (real EURC/USD feed), add as the sole deposit asset; disable USDC as a deposit asset (stays supported, non-deposit).',
  );
  console.log(
    '  B) Deploy + register AaveV4Spoke guard family (asset type 5) against real MAG7_SPOKE.',
  );
  console.log(
    '  C) Deploy + register AaveV4Tokenization guard family (asset type 6) against real TOKENIZATION_SPOKE.',
  );
  console.log(
    '  D) Create a real Morpho Vault V2 (USDC-denominated, via the real factory) + deploy/register its guard family (asset type 7).',
  );
  console.log('  Morpho Blue: untouched, still unconfigured (M-11).');

  if (!sendLive) {
    console.log('\nDry run complete. Re-run with SEND=1 to execute for real.');
    return;
  }

  console.log('\n!!! SEND=1 — executing for real on Base mainnet !!!');

  // ============================================================
  // A) EURC as the sole deposit asset
  // ============================================================
  console.log('\n=== A) Registering EURC, switching deposit gate from USDC to EURC ===');
  await (await assetHandler.addAsset(EURC, 4, EURC_USD_FEED)).wait();
  await (await assetHandler.setChainlinkTimeout(EURC, ONE_DAY)).wait();
  console.log('  AssetHandler: EURC registered (type 4, real EURC/USD feed).');

  // Must disable USDC's TokenLogic-level allowlist BEFORE changing its PoolManagerLogic
  // isDepositAsset flag — configureAsset() itself requires isDepositAsset(_asset) to still be
  // true at call time (TokenLogic.sol:321), so flipping PoolManagerLogic first would make this
  // very call revert.
  await (await tokenLogic.configureAsset(USDC, false, 0n)).wait();
  console.log('  TokenLogic: USDC deposits disabled.');

  await (await poolManagerLogic.changeAssets([{ asset: EURC, isDeposit: true }], [])).wait();
  await (await poolManagerLogic.changeAssets([{ asset: USDC, isDeposit: false }], [])).wait();
  console.log(
    '  PoolManagerLogic: EURC added as deposit asset; USDC isDeposit flipped to false (still supported).',
  );

  await (await tokenLogic.configureAsset(EURC, true, 0n)).wait();
  console.log('  TokenLogic: EURC deposits enabled. EURC is now the sole deposit asset.');

  // ============================================================
  // B) Aave V4 Spoke guard family
  // ============================================================
  console.log('\n=== B) Deploying AaveV4Spoke guard family ===');
  const spokeManager = await (
    await ethers.getContractFactory('AaveV4SpokeManager', signer)
  ).deploy();
  await spokeManager.waitForDeployment();
  const spokeManagerAddr = await spokeManager.getAddress();
  const spokeContractGuard = await (
    await ethers.getContractFactory('AaveV4SpokeContractGuard')
  ).deploy(spokeManagerAddr);
  await spokeContractGuard.waitForDeployment();
  const spokeAssetGuard = await (
    await ethers.getContractFactory('AaveV4SpokeAssetGuard')
  ).deploy(spokeManagerAddr, TAKER_POSITION_MANAGER, GIVER_POSITION_MANAGER);
  await spokeAssetGuard.waitForDeployment();
  console.log(`  AaveV4SpokeManager: ${spokeManagerAddr}`);
  console.log(`  AaveV4SpokeContractGuard: ${await spokeContractGuard.getAddress()}`);
  console.log(`  AaveV4SpokeAssetGuard: ${await spokeAssetGuard.getAddress()}`);

  await (
    await governance.setContractGuard(GIVER_POSITION_MANAGER, await spokeContractGuard.getAddress())
  ).wait();
  await (
    await governance.setContractGuard(TAKER_POSITION_MANAGER, await spokeContractGuard.getAddress())
  ).wait();
  await (await governance.setContractGuard(MAG7_SPOKE, await spokeAssetGuard.getAddress())).wait();
  await (
    await governance.setAssetGuard(ASSET_TYPE_SPOKE, await spokeAssetGuard.getAddress())
  ).wait();
  await (await assetHandler.addAsset(MAG7_SPOKE, ASSET_TYPE_SPOKE, FIXED_USD_AGGREGATOR)).wait();
  await (await assetHandler.setChainlinkTimeout(MAG7_SPOKE, ONE_DAY)).wait();
  await (await spokeManager.setPoolReserves(d.poolLogic, MAG7_SPOKE, [USDC_RESERVE_ID])).wait();
  await (await poolManagerLogic.changeAssets([{ asset: MAG7_SPOKE, isDeposit: false }], [])).wait();
  const spokeIface = new ethers.Interface(['function setUserPositionManager(address,bool)']);
  await (
    await poolLogic.execTransaction(
      MAG7_SPOKE,
      spokeIface.encodeFunctionData('setUserPositionManager', [GIVER_POSITION_MANAGER, true]),
      { gasLimit: 2_000_000 },
    )
  ).wait();
  await (
    await poolLogic.execTransaction(
      MAG7_SPOKE,
      spokeIface.encodeFunctionData('setUserPositionManager', [TAKER_POSITION_MANAGER, true]),
      { gasLimit: 2_000_000 },
    )
  ).wait();
  console.log('  Registered, whitelisted (USDC reserve), PositionManagers authorized.');

  // ============================================================
  // C) Aave V4 Tokenization guard family
  // ============================================================
  console.log('\n=== C) Deploying AaveV4Tokenization guard family ===');
  const tokenizationManager = await (
    await ethers.getContractFactory('AaveV4TokenizationManager', signer)
  ).deploy();
  await tokenizationManager.waitForDeployment();
  const tokenizationManagerAddr = await tokenizationManager.getAddress();
  const tsContractGuard = await (
    await ethers.getContractFactory('AaveV4TokenizationContractGuard')
  ).deploy(tokenizationManagerAddr);
  await tsContractGuard.waitForDeployment();
  const tsAssetGuard = await (
    await ethers.getContractFactory('AaveV4TokenizationAssetGuard')
  ).deploy(tokenizationManagerAddr);
  await tsAssetGuard.waitForDeployment();
  console.log(`  AaveV4TokenizationManager: ${tokenizationManagerAddr}`);
  console.log(`  AaveV4TokenizationContractGuard: ${await tsContractGuard.getAddress()}`);
  console.log(`  AaveV4TokenizationAssetGuard: ${await tsAssetGuard.getAddress()}`);

  await (
    await governance.setContractGuard(TOKENIZATION_SPOKE, await tsContractGuard.getAddress())
  ).wait();
  await (
    await governance.setAssetGuard(ASSET_TYPE_TOKENIZATION, await tsAssetGuard.getAddress())
  ).wait();
  await (
    await assetHandler.addAsset(TOKENIZATION_SPOKE, ASSET_TYPE_TOKENIZATION, FIXED_USD_AGGREGATOR)
  ).wait();
  await (await assetHandler.setChainlinkTimeout(TOKENIZATION_SPOKE, ONE_DAY)).wait();
  await (await tokenizationManager.setPoolVaults(d.poolLogic, [TOKENIZATION_SPOKE])).wait();
  await (
    await poolManagerLogic.changeAssets([{ asset: TOKENIZATION_SPOKE, isDeposit: false }], [])
  ).wait();
  console.log('  Registered + whitelisted.');

  // ============================================================
  // D) Morpho Vault V2 guard family (fresh real vault via the real factory)
  // ============================================================
  console.log('\n=== D) Creating a real Morpho Vault V2 + deploying its guard family ===');
  const factory = await ethers.getContractAt(
    [
      'function createVaultV2(address owner, address asset, bytes32 salt) external returns (address)',
    ],
    VAULT_V2_FACTORY,
  );
  const salt = ethers.encodeBytes32String(
    'frgmnt-eur-mainnet-' + Date.now().toString(36).slice(-8),
  );
  const vaultAddr = await factory.createVaultV2.staticCall(owner, USDC, salt);
  await (await factory.createVaultV2(owner, USDC, salt)).wait();
  console.log(`  Created real Morpho Vault V2 at ${vaultAddr}, asset=USDC.`);

  const vaultManager = await (
    await ethers.getContractFactory('MorphoVaultV2Manager', signer)
  ).deploy();
  await vaultManager.waitForDeployment();
  const vaultManagerAddr = await vaultManager.getAddress();
  const vaultContractGuard = await (
    await ethers.getContractFactory('MorphoVaultV2ContractGuard')
  ).deploy(vaultManagerAddr);
  await vaultContractGuard.waitForDeployment();
  const vaultAssetGuard = await (
    await ethers.getContractFactory('MorphoVaultV2AssetGuard')
  ).deploy(vaultManagerAddr);
  await vaultAssetGuard.waitForDeployment();
  console.log(`  MorphoVaultV2Manager: ${vaultManagerAddr}`);
  console.log(`  MorphoVaultV2ContractGuard: ${await vaultContractGuard.getAddress()}`);
  console.log(`  MorphoVaultV2AssetGuard: ${await vaultAssetGuard.getAddress()}`);

  await (
    await governance.setContractGuard(vaultAddr, await vaultContractGuard.getAddress())
  ).wait();
  await (
    await governance.setAssetGuard(ASSET_TYPE_VAULT_V2, await vaultAssetGuard.getAddress())
  ).wait();
  await (await assetHandler.addAsset(vaultAddr, ASSET_TYPE_VAULT_V2, FIXED_USD_AGGREGATOR)).wait();
  await (await assetHandler.setChainlinkTimeout(vaultAddr, ONE_DAY)).wait();
  await (await vaultManager.setPoolVaults(d.poolLogic, [vaultAddr])).wait();
  await (await poolManagerLogic.changeAssets([{ asset: vaultAddr, isDeposit: false }], [])).wait();
  console.log('  Registered + whitelisted.');

  // ============================================================
  // Save
  // ============================================================
  const out = {
    ...d,
    eurc: { address: EURC, feed: EURC_USD_FEED },
    depositAsset: 'EURC (USDC disabled as a deposit asset, still supported)',
    dormantGuards: {
      AaveV4Spoke: {
        manager: spokeManagerAddr,
        contractGuard: await spokeContractGuard.getAddress(),
        assetGuard: await spokeAssetGuard.getAddress(),
        assetType: ASSET_TYPE_SPOKE,
        target: MAG7_SPOKE,
        reserveId: USDC_RESERVE_ID.toString(),
      },
      AaveV4Tokenization: {
        manager: tokenizationManagerAddr,
        contractGuard: await tsContractGuard.getAddress(),
        assetGuard: await tsAssetGuard.getAddress(),
        assetType: ASSET_TYPE_TOKENIZATION,
        target: TOKENIZATION_SPOKE,
      },
      MorphoVaultV2: {
        vault: vaultAddr,
        manager: vaultManagerAddr,
        contractGuard: await vaultContractGuard.getAddress(),
        assetGuard: await vaultAssetGuard.getAddress(),
        assetType: ASSET_TYPE_VAULT_V2,
      },
    },
  };
  const outFile = path.join(
    process.cwd(),
    'deployments',
    `deploy-eur-mainnet-phase2-${Date.now()}.json`,
  );
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log('\nPHASE 2 COMPLETE on real Base mainnet. Saved to', outFile);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
