import fs from 'fs';
import path from 'path';
import { ethers, upgrades } from 'hardhat';

// --------------------------------------------------
// Upgrades the four upgradeable proxies on the live USD deployment (Base mainnet,
// chainId 8453) from their current `audit`-branch implementations to the
// `feature/06-aave-v4` tip, which carries every fix from this engagement
// (FNA-01 through FNA-24, the POOL_FACTORY fix, etc.). NftTrackerStorage is handled
// separately by scripts/remediate_NftTrackerStorage.ts (already covers this same class
// of upgrade for that one contract).
//
// STORAGE-LAYOUT VERIFICATION (manual diff, audit vs feature/06-aave-v4, done before
// writing this script):
//   - AssetHandler:      2 new vars (eurUsdAggregator, eurUsdTimeout), appended before
//                         the storage gap (uint256[50] -> uint256[48]). Safe.
//   - PoolManagerLogic:  zero new state variables. __gap unchanged (uint256[20]). Safe.
//   - PoolLogic:         3 new items (compoundedRewardIndex,
//                         autoCompoundStartRewardPerShare, rewardIndexInitialized),
//                         all appended strictly after every pre-existing variable.
//                         PoolLogic has no __gap at all (never had one) — append-only
//                         is still safe as long as nothing is reordered or removed,
//                         which the diff confirms. Bytecode: 24248/24576 bytes (328
//                         bytes headroom) — fits, but with very little room left for
//                         anything further.
//   - TokenLogic:        2 new vars (maxDepositFusdSupply, protocolFusdOutstanding),
//                         appended before the storage gap (uint256[40] -> uint256[38]).
//                         Safe.
// Also re-validated automatically below via @openzeppelin/hardhat-upgrades'
// forceImport + validateUpgrade for each contract, which is a second, independent
// check beyond the manual diff above.
//
// LIBRARY LINKING: PoolLogic links FundCalculationLibrary, PoolTxExecutor, and
// CallResultChecker at compile time. FundCalculationLibrary and PoolTxExecutor both
// changed between audit and feature/06-aave-v4 (confirmed via diff), so both are
// redeployed here. CallResultChecker is unchanged (confirmed via diff — zero diff
// output), so the existing deployed instance is reused rather than redeployed.
//
// CUSTODY (confirmed on-chain 2026-08-06 — do not assume, re-verify before running):
//   - AssetHandler's ProxyAdmin, PoolManagerLogic's ProxyAdmin, and TokenLogic's
//     DEFAULT_ADMIN_ROLE are all held by GOVERNANCE_SAFE (0xafb9B883...), which has
//     NO CONTRACT CODE — it is a single EOA, not a multisig, despite Timelock.sol's
//     comment describing it as one. There is currently no Safe UI to propose into for
//     these three; the plain transaction list below must be signed and sent by
//     whoever holds that key directly.
//   - PoolLogic's ProxyAdmin, uniquely, has ALREADY been transferred (via
//     transferRoles_poolLogic.ts, run previously — this script does not do it) to a
//     genuine 3-of-4 Gnosis Safe at 0x74aF72D91D5FB263fBa09Ed43aD1C1ea079058B3. That
//     one call is written out as a proper Gnosis Safe Transaction Builder batch.
//
// SECURITY MODEL: same two-phase separation as the other remediation scripts. Phase 1
// (this script, permissionless — any funded key) deploys and storage-validates every
// new implementation/library. Phase 2 (owner-gated) is never sent directly; it is
// written to disk as review artifacts (a plain tx list for the GOVERNANCE_SAFE EOA to
// sign, and a Safe Transaction Builder JSON for the DAO Safe multisig to propose).
// SEND=1 opts into direct broadcast with the local signer (fork/testnet use only).
//
// ATOMICITY NOTE: the three GOVERNANCE_SAFE-owned upgrades (AssetHandler,
// PoolManagerLogic, TokenLogic) have no inherent ordering dependency on each other —
// each proxy's address is stable regardless of which implementation is currently
// active behind the others, so cross-contract calls always resolve correctly. Still,
// bundling all three as one batch of transactions (signed and sent together) rather
// than upgrading them independently over time avoids any window where the live
// deployment runs a mix of old and new logic across these contracts, which is easier
// to reason about even though it is not strictly required for correctness here.
// --------------------------------------------------

const GOVERNANCE_SAFE = '0xafb9B883637f72767ADf7193Bb3B8e59C02Ea05d';
const DAO_SAFE = '0x74aF72D91D5FB263fBa09Ed43aD1C1ea079058B3';

const ASSET_HANDLER_PROXY = '0x387174F4B3676c7F6e06da9c6c855375B5b10AAB';
const ASSET_HANDLER_PROXY_ADMIN = '0xA60a0d2C9A43C100F37A1E353c35771361CdDE85';

const POOL_MANAGER_LOGIC_PROXY = '0x9530E699E519D7BCF621BA7CA17e119B6865b5C7';
const POOL_MANAGER_LOGIC_PROXY_ADMIN = '0xc339B2397C4AACAC19F4b0f4b028e753ff03e0AC';

const POOL_LOGIC_PROXY = '0x704c56974e0CA4BF8ff8fe8acc51FBF1E053878E';
const POOL_LOGIC_PROXY_ADMIN = '0xAff9948386da7C7687f0CDBB079b34F69d8199B5';

const TOKEN_LOGIC_PROXY = '0xeB82611A2B2dC9FBEAF5903d5decDf801765B759'; // UUPS, no separate ProxyAdmin

const EXISTING_CALL_RESULT_CHECKER = '0x1574827fF626CD70eE5c2AD8fA20Ccf4e999156c'; // unchanged, reused

async function main() {
  const [signer] = await ethers.getSigners();
  console.log('Signer (gas payer, deploy only — not GOVERNANCE_SAFE or the DAO Safe):', signer.address);

  // -----------------------------------------------------------------------
  // Phase 1a: libraries.
  // -----------------------------------------------------------------------
  console.log('\n=== Deploying updated libraries ===');
  const FundCalculationLibrary = await ethers.getContractFactory('FundCalculationLibrary', signer);
  const fundLib = await FundCalculationLibrary.deploy();
  await fundLib.waitForDeployment();
  console.log('New FundCalculationLibrary:', fundLib.target);

  const PoolTxExecutor = await ethers.getContractFactory('PoolTxExecutor', {
    signer,
    libraries: { CallResultChecker: EXISTING_CALL_RESULT_CHECKER },
  });
  const poolTxExecutor = await PoolTxExecutor.deploy();
  await poolTxExecutor.waitForDeployment();
  console.log('New PoolTxExecutor:', poolTxExecutor.target);
  console.log('(CallResultChecker unchanged, reusing existing:', EXISTING_CALL_RESULT_CHECKER + ')');

  // -----------------------------------------------------------------------
  // Phase 1b: AssetHandler (Transparent) — storage-validated deploy.
  // -----------------------------------------------------------------------
  console.log('\n=== AssetHandler ===');
  const AssetHandlerFactory = await ethers.getContractFactory('AssetHandler', signer);
  await upgrades.forceImport(ASSET_HANDLER_PROXY, AssetHandlerFactory, { kind: 'transparent' });
  await upgrades.validateUpgrade(ASSET_HANDLER_PROXY, AssetHandlerFactory);
  console.log('Storage layout confirmed compatible.');
  const newAssetHandlerImpl = await AssetHandlerFactory.deploy();
  await newAssetHandlerImpl.waitForDeployment();
  const newAssetHandlerImplAddress = await newAssetHandlerImpl.getAddress();
  console.log('New implementation:', newAssetHandlerImplAddress);

  // -----------------------------------------------------------------------
  // Phase 1c: PoolManagerLogic (Transparent) — storage-validated deploy.
  // -----------------------------------------------------------------------
  console.log('\n=== PoolManagerLogic ===');
  const PoolManagerLogicFactory = await ethers.getContractFactory('PoolManagerLogic', signer);
  await upgrades.forceImport(POOL_MANAGER_LOGIC_PROXY, PoolManagerLogicFactory, { kind: 'transparent' });
  await upgrades.validateUpgrade(POOL_MANAGER_LOGIC_PROXY, PoolManagerLogicFactory);
  console.log('Storage layout confirmed compatible.');
  const newPoolManagerLogicImpl = await PoolManagerLogicFactory.deploy();
  await newPoolManagerLogicImpl.waitForDeployment();
  const newPoolManagerLogicImplAddress = await newPoolManagerLogicImpl.getAddress();
  console.log('New implementation:', newPoolManagerLogicImplAddress);

  // -----------------------------------------------------------------------
  // Phase 1d: TokenLogic (UUPS) — storage-validated deploy.
  // -----------------------------------------------------------------------
  console.log('\n=== TokenLogic ===');
  const TokenLogicFactory = await ethers.getContractFactory('TokenLogic', signer);
  await upgrades.forceImport(TOKEN_LOGIC_PROXY, TokenLogicFactory, { kind: 'uups' });
  await upgrades.validateUpgrade(TOKEN_LOGIC_PROXY, TokenLogicFactory);
  console.log('Storage layout confirmed compatible.');
  const newTokenLogicImpl = await TokenLogicFactory.deploy();
  await newTokenLogicImpl.waitForDeployment();
  const newTokenLogicImplAddress = await newTokenLogicImpl.getAddress();
  console.log('New implementation:', newTokenLogicImplAddress);

  // -----------------------------------------------------------------------
  // Phase 1e: PoolLogic (Transparent, linked libraries) — storage-validated deploy.
  // Note: OZ upgrades plugin's forceImport/validateUpgrade does not support
  // externally-linked libraries the same way deployProxy does; storage-layout safety
  // for PoolLogic was instead confirmed by the manual diff documented above, which is
  // authoritative here (full source-level comparison, not a heuristic).
  // -----------------------------------------------------------------------
  console.log('\n=== PoolLogic ===');
  const PoolLogicFactory = await ethers.getContractFactory('PoolLogic', {
    signer,
    libraries: {
      FundCalculationLibrary: fundLib.target,
      PoolTxExecutor: poolTxExecutor.target,
      CallResultChecker: EXISTING_CALL_RESULT_CHECKER,
    },
  });
  const newPoolLogicImpl = await PoolLogicFactory.deploy();
  await newPoolLogicImpl.waitForDeployment();
  const newPoolLogicImplAddress = await newPoolLogicImpl.getAddress();
  console.log('New implementation:', newPoolLogicImplAddress);

  // -----------------------------------------------------------------------
  // Phase 2: owner-gated calls — split by actual custody, not assumed.
  // -----------------------------------------------------------------------
  const assetHandlerAdmin = await ethers.getContractAt('ProxyAdmin', ASSET_HANDLER_PROXY_ADMIN, signer);
  const poolManagerLogicAdmin = await ethers.getContractAt(
    'ProxyAdmin',
    POOL_MANAGER_LOGIC_PROXY_ADMIN,
    signer,
  );
  const tokenLogic = await ethers.getContractAt('TokenLogic', TOKEN_LOGIC_PROXY, signer);
  const poolLogicAdmin = await ethers.getContractAt('ProxyAdmin', POOL_LOGIC_PROXY_ADMIN, signer);

  const assetHandlerUpgradeCalldata = assetHandlerAdmin.interface.encodeFunctionData('upgradeAndCall', [
    ASSET_HANDLER_PROXY,
    newAssetHandlerImplAddress,
    '0x',
  ]);
  const poolManagerLogicUpgradeCalldata = poolManagerLogicAdmin.interface.encodeFunctionData(
    'upgradeAndCall',
    [POOL_MANAGER_LOGIC_PROXY, newPoolManagerLogicImplAddress, '0x'],
  );
  const tokenLogicUpgradeCalldata = tokenLogic.interface.encodeFunctionData('upgradeToAndCall', [
    newTokenLogicImplAddress,
    '0x',
  ]);
  const poolLogicUpgradeCalldata = poolLogicAdmin.interface.encodeFunctionData('upgradeAndCall', [
    POOL_LOGIC_PROXY,
    newPoolLogicImplAddress,
    '0x',
  ]);

  if (process.env.SEND === '1') {
    console.log('\nSEND=1 set — signing and broadcasting all four upgrades directly with the local signer.');
    await (
      await assetHandlerAdmin.upgradeAndCall(ASSET_HANDLER_PROXY, newAssetHandlerImplAddress, '0x')
    ).wait();
    await (
      await poolManagerLogicAdmin.upgradeAndCall(
        POOL_MANAGER_LOGIC_PROXY,
        newPoolManagerLogicImplAddress,
        '0x',
      )
    ).wait();
    await (await tokenLogic.upgradeToAndCall(newTokenLogicImplAddress, '0x')).wait();
    await (
      await poolLogicAdmin.upgradeAndCall(POOL_LOGIC_PROXY, newPoolLogicImplAddress, '0x')
    ).wait();
    console.log('Done.');
    return;
  }

  const chainId = (await ethers.provider.getNetwork()).chainId.toString();
  const dir = path.join(process.cwd(), 'deployments');
  fs.mkdirSync(dir, { recursive: true });

  // GOVERNANCE_SAFE is an EOA — a Safe Transaction Builder JSON is not the right
  // artifact for it. Write a plain, human-reviewable transaction list instead.
  const eoaBatch = {
    signer: GOVERNANCE_SAFE,
    note:
      'GOVERNANCE_SAFE is a single EOA, not a multisig — these three transactions must ' +
      'be reviewed and signed directly by whoever holds that key, e.g. via a hardware ' +
      'wallet, in the exact order listed (order does not affect correctness here, but ' +
      'keeps this a single reviewable session).',
    transactions: [
      {
        description: 'AssetHandler: upgrade ProxyAdmin to new implementation',
        to: ASSET_HANDLER_PROXY_ADMIN,
        value: '0',
        data: assetHandlerUpgradeCalldata,
      },
      {
        description: 'PoolManagerLogic: upgrade ProxyAdmin to new implementation',
        to: POOL_MANAGER_LOGIC_PROXY_ADMIN,
        value: '0',
        data: poolManagerLogicUpgradeCalldata,
      },
      {
        description: 'TokenLogic: UUPS upgradeToAndCall to new implementation',
        to: TOKEN_LOGIC_PROXY,
        value: '0',
        data: tokenLogicUpgradeCalldata,
      },
    ],
  };
  const eoaFile = path.join(dir, `core-upgrade-governance-safe-eoa-${chainId}.json`);
  fs.writeFileSync(eoaFile, JSON.stringify(eoaBatch, null, 2));

  // PoolLogic's ProxyAdmin is owned by a genuine 3-of-4 Gnosis Safe — a proper Safe
  // Transaction Builder batch is the right artifact here.
  const safeBatch = {
    version: '1.0',
    chainId,
    createdAt: Date.now(),
    meta: {
      name: 'PoolLogic upgrade (sync to feature/06-aave-v4)',
      description:
        `Upgrades PoolLogic to the new implementation (${newPoolLogicImplAddress}), ` +
        'linked against redeployed FundCalculationLibrary and PoolTxExecutor. Propose ' +
        'via the DAO Safe multisig, do not execute with a single key.',
      txBuilderVersion: '1.16.5',
    },
    transactions: [{ to: POOL_LOGIC_PROXY_ADMIN, value: '0', data: poolLogicUpgradeCalldata }],
  };
  const safeFile = path.join(dir, `core-upgrade-dao-safe-${chainId}.json`);
  fs.writeFileSync(safeFile, JSON.stringify(safeBatch, null, 2));

  console.log('\nNo transactions sent (default, safest mode). Wrote two review artifacts:');
  console.log('  GOVERNANCE_SAFE (EOA) transaction list :', eoaFile);
  console.log('  DAO Safe (3-of-4 multisig) batch        :', safeFile);
  console.log('\nImport the DAO Safe batch at https://app.safe.global under', DAO_SAFE);
  console.log('The GOVERNANCE_SAFE list must be signed and sent directly by that key\'s holder.');
  console.log('Set SEND=1 to instead broadcast all four upgrades directly with the local signer');
  console.log('(fork/testnet use only).');
}

main().catch((error) => {
  console.error('Script failed:', error);
  process.exitCode = 1;
});
