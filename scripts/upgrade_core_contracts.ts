import fs from 'fs';
import path from 'path';
import { ethers, upgrades } from 'hardhat';

// --------------------------------------------------
// Upgrades the four upgradeable proxies on the live USD deployment (Base mainnet,
// chainId 8453) from their current `audit`-branch implementations to the
// `feature/06-aave-v4` tip, which carries every fix from this engagement
// (FNA-01 through FNA-24, the POOL_FACTORY fix, etc.). NftTrackerStorage is handled
// separately by scripts/remediate_NftTrackerStorage.ts.
//
// *** REAL, ALREADY-STAKED USER FUNDS ARE LIVE IN THIS POOL. Two of the four ***
// *** contracts being upgraded ship a real-money migration, not just new logic. ***
//
// STORAGE-LAYOUT VERIFICATION (manual diff, audit vs feature/06-aave-v4):
//   - AssetHandler:      2 new vars, appended before the storage gap (50 -> 48). Safe.
//   - PoolManagerLogic:  zero new state variables. __gap unchanged. Safe.
//   - PoolLogic:         3 new items, all strictly appended after every pre-existing
//                         variable. No __gap exists on this contract at all (never
//                         had one) — append-only ordering is what's relied on for
//                         safety, confirmed by direct comparison. Bytecode: 328 bytes
//                         of headroom on the current branch tip — fits, but tight.
//   - TokenLogic:        2 new vars, appended before the storage gap (40 -> 38). Safe.
// Also re-validated automatically per-contract below via
// @openzeppelin/hardhat-upgrades' forceImport + validateUpgrade.
//
// TWO MANDATORY POST-UPGRADE MIGRATION CALLS — MUST be bundled atomically with their
// respective proxy upgrade, not run as a separate later transaction:
//
//   1) PoolLogic.initializeAutoCompounding() (onlyOwner, reinitializer(2)). The new
//      compoundedRewardIndex field starts at 0 on the live proxy (the audit-branch
//      initialize() never set it — the field didn't exist there). Every reward-gated
//      user action (stake/unstake/harvest, and anything that runs
//      updateFeesAndRewards) calls _requireAutoCompoundingInitialized(), which
//      REVERTS while compoundedRewardIndex == 0. Upgrading PoolLogic's implementation
//      WITHOUT this call in the same transaction would leave every staker unable to
//      unstake, harvest, or have new deposits recognized as rewards until a second,
//      separate transaction runs it — a real, if temporary, denial-of-service on
//      already-staked funds.
//
//      Migration correctness (verified analytically, see below for what this does
//      and does not cover): initializeAutoCompounding() snapshots
//      autoCompoundStartRewardPerShare = rewardPerShare (freezing the legacy
//      MasterChef-style accounting at the exact pre-migration value). Each user's
//      legacy pending reward is then folded in lazily, once, the first time they're
//      next touched (_migrateRewardIndex, called from _updateUserReward): it computes
//      Math.mulDiv(balanceOf(user), autoCompoundStartRewardPerShare, 1e18) - rewardDebt
//      — algebraically identical to the audit branch's own pending-reward formula
//      (accumulated = balance * rewardPerShare / 1e18; pending += accumulated -
//      rewardDebt), just anchored to the frozen snapshot instead of a live-updating
//      value. This preserves each user's already-accrued-but-uncredited legacy reward
//      without loss or double-counting, UNDER THE ASSUMPTION that a user's balance
//      does not change between the migration snapshot and their own first
//      post-migration interaction other than through functions that already call
//      _updateUserReward (stake/unstake/harvest) — the same assumption the
//      pre-existing (audit-branch) reward-debt system already relied on for any
//      bare ERC20 transfer of the share token, so this is not a new risk introduced
//      by the migration itself.
//
//      NOT independently verified in this session: this exact migration path (old
//      state -> upgrade -> initializeAutoCompounding -> existing user harvests) has
//      no dedicated test in this repo (test/PoolLogicAutoCompounding.test.ts only
//      covers the fresh-deployment path, where compoundedRewardIndex is already 1e18
//      from initialize() and initializeAutoCompounding() is expected to revert). An
//      attempt to rehearse this against a fork of the actual live pool state hit an
//      environment-level Hardhat/EDR limitation forking Base (see
//      pool_factory_mixup_live_deployment memory / commit history for that attempt).
//      STRONGLY RECOMMENDED: dry-run this upgrade + migration against a forked/copied
//      snapshot of the real live state (with real staker balances) before executing
//      on mainnet, using whatever forking setup is available to the team, and confirm
//      at least one real staker's pendingReward() before vs. after matches by hand.
//
//   2) TokenLogic.initializeDepositFusdCap(newCap) (onlyRole(DEFAULT_ADMIN_ROLE),
//      reinitializer(2)). maxDepositFusdSupply starts at 0 on the live proxy, and
//      deposit() unconditionally requires
//      protocolFusdOutstanding + fusdAmount <= maxDepositFusdSupply — with
//      maxDepositFusdSupply == 0, EVERY deposit would revert with "deposit cap
//      exceeded" until this is called. NEW_DEPOSIT_FUSD_CAP below is set to 500,000
//      fUSD (product decision, confirmed 2026-08-06). initializeDepositFusdCap() sets
//      protocolFusdOutstanding = totalSupply() as the baseline, so this cap must
//      cover the current live fUSD totalSupply (~97,188.41 as of 2026-08-06) with
//      room left for actual new deposits — 500,000 leaves ~402,811.59 of headroom.
//
// LIBRARY LINKING: PoolLogic links FundCalculationLibrary, PoolTxExecutor, and
// CallResultChecker at compile time. The first two changed since audit and are
// redeployed here; CallResultChecker is unchanged (confirmed via diff) and reused.
//
// CUSTODY (confirmed on-chain 2026-08-07 via direct eth_call against each contract —
// re-verify before running, do not assume; an earlier draft of this comment incorrectly
// assumed TokenLogic's admin role followed GOVERNANCE_SAFE, corrected here):
//   - AssetHandler's ProxyAdmin and PoolManagerLogic's ProxyAdmin (and PoolManagerLogic's
//     own factoryOwner/owner()) are held by GOVERNANCE_SAFE (0xafb9B883...), which has
//     NO CONTRACT CODE — a single EOA, not a multisig, despite Timelock.sol's comment
//     describing it as one.
//   - PoolLogic's ProxyAdmin, its own onlyOwner (needed for initializeAutoCompounding()),
//     AND TokenLogic's DEFAULT_ADMIN_ROLE (needed for the UUPS upgrade itself and for
//     initializeDepositFusdCap()) are ALL already held by a genuine 3-of-4 Gnosis Safe at
//     0x74aF72D91D5FB263fBa09Ed43aD1C1ea079058B3 (confirmed via getOwners()/getThreshold(),
//     and via TokenLogic.hasRole(DEFAULT_ADMIN_ROLE, <address>) directly — true for this
//     Safe, false for GOVERNANCE_SAFE) — a DAO Safe, separate from GOVERNANCE_SAFE. So
//     TokenLogic's upgrade transaction belongs in the DAO Safe batch below, not the
//     GOVERNANCE_SAFE list, even though GOVERNANCE_SAFE holds every other TokenLogic-
//     adjacent role in this stack.
//
// SECURITY MODEL: same two-phase separation as the other remediation scripts. Phase 1
// (permissionless) deploys and storage-validates every new implementation/library.
// Phase 2 (owner-gated) is never sent directly by default — written to disk as review
// artifacts. SEND=1 opts into direct broadcast (fork/testnet use only).
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

// Product decision, confirmed 2026-08-06: 500,000 fUSD. Comfortably above the live
// totalSupply (~97,188.41 as of 2026-08-06), leaving ~402,811.59 of new deposit headroom.
const NEW_DEPOSIT_FUSD_CAP = ethers.parseUnits('500000', 18); // 18-decimal fUSD units

async function main() {
  if (NEW_DEPOSIT_FUSD_CAP === 0n) {
    throw new Error(
      'Set NEW_DEPOSIT_FUSD_CAP before running — this is a product decision (the new ' +
        'TokenLogic deposit cap), not something this script can choose for you. It must ' +
        'exceed the live fUSD totalSupply or deposits will remain effectively frozen ' +
        'even after this migration runs.',
    );
  }

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
  // OZ upgrades plugin's forceImport/validateUpgrade doesn't support externally-linked
  // libraries the same way deployProxy does; storage-layout safety for PoolLogic rests
  // on the manual diff documented above instead, which is authoritative here.
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
  // Phase 2: owner-gated calls — split by actual custody, not assumed. PoolLogic and
  // TokenLogic bundle their mandatory migration call into the SAME transaction as the
  // upgrade itself (via upgradeAndCall/upgradeToAndCall's data parameter), so there is
  // no window where the proxy is upgraded but the pool is left non-functional.
  // -----------------------------------------------------------------------
  const assetHandlerAdmin = await ethers.getContractAt('ProxyAdmin', ASSET_HANDLER_PROXY_ADMIN, signer);
  const poolManagerLogicAdmin = await ethers.getContractAt(
    'ProxyAdmin',
    POOL_MANAGER_LOGIC_PROXY_ADMIN,
    signer,
  );
  const tokenLogic = await ethers.getContractAt('TokenLogic', TOKEN_LOGIC_PROXY, signer);
  const poolLogic = await ethers.getContractAt('PoolLogic', POOL_LOGIC_PROXY, signer);
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

  const initializeDepositFusdCapCalldata = tokenLogic.interface.encodeFunctionData(
    'initializeDepositFusdCap',
    [NEW_DEPOSIT_FUSD_CAP],
  );
  const tokenLogicUpgradeCalldata = tokenLogic.interface.encodeFunctionData('upgradeToAndCall', [
    newTokenLogicImplAddress,
    initializeDepositFusdCapCalldata,
  ]);

  const initializeAutoCompoundingCalldata = poolLogic.interface.encodeFunctionData(
    'initializeAutoCompounding',
    [],
  );
  const poolLogicUpgradeCalldata = poolLogicAdmin.interface.encodeFunctionData('upgradeAndCall', [
    POOL_LOGIC_PROXY,
    newPoolLogicImplAddress,
    initializeAutoCompoundingCalldata,
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
    await (
      await tokenLogic.upgradeToAndCall(newTokenLogicImplAddress, initializeDepositFusdCapCalldata)
    ).wait();
    await (
      await poolLogicAdmin.upgradeAndCall(POOL_LOGIC_PROXY, newPoolLogicImplAddress, initializeAutoCompoundingCalldata)
    ).wait();
    console.log('Done.');
    return;
  }

  const chainId = (await ethers.provider.getNetwork()).chainId.toString();
  const dir = path.join(process.cwd(), 'deployments');
  fs.mkdirSync(dir, { recursive: true });

  // GOVERNANCE_SAFE is an EOA — a Safe Transaction Builder JSON is not the right
  // artifact for it. Write a plain, human-reviewable transaction list instead. Only
  // AssetHandler and PoolManagerLogic belong here — TokenLogic's DEFAULT_ADMIN_ROLE is
  // held by the DAO Safe, not GOVERNANCE_SAFE (confirmed on-chain, see CUSTODY above).
  const eoaBatch = {
    signer: GOVERNANCE_SAFE,
    note:
      'GOVERNANCE_SAFE is a single EOA, not a multisig — these two transactions must ' +
      'be reviewed and signed directly by whoever holds that key, e.g. via a hardware ' +
      'wallet.',
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
    ],
  };
  const eoaFile = path.join(dir, `core-upgrade-governance-safe-eoa-${chainId}.json`);
  fs.writeFileSync(eoaFile, JSON.stringify(eoaBatch, null, 2));

  // PoolLogic's ProxyAdmin/onlyOwner AND TokenLogic's DEFAULT_ADMIN_ROLE are both held
  // by the same genuine 3-of-4 Gnosis Safe — one Safe Transaction Builder batch covers
  // both upgrades, since both need that Safe's approval anyway.
  const safeBatch = {
    version: '1.0',
    chainId,
    createdAt: Date.now(),
    meta: {
      name: 'PoolLogic + TokenLogic upgrade (sync to feature/06-aave-v4)',
      description:
        `Upgrades PoolLogic to the new implementation (${newPoolLogicImplAddress}), ` +
        'linked against redeployed FundCalculationLibrary and PoolTxExecutor, bundling ' +
        'initializeAutoCompounding() atomically — stake/unstake/harvest stay broken for ' +
        'every staker until this transaction lands. Also upgrades TokenLogic to the new ' +
        `implementation (${newTokenLogicImplAddress}), bundling ` +
        `initializeDepositFusdCap(${NEW_DEPOSIT_FUSD_CAP.toString()}) atomically — ` +
        'deposits stay broken (0 cap) until this transaction lands. Propose via the DAO ' +
        'Safe multisig, do not execute with a single key. STRONGLY RECOMMENDED: dry-run ' +
        'both transactions against a fork of live mainnet state first — see this ' +
        'script\'s header comment for what is and is not independently verified about ' +
        'the reward migration math.',
      txBuilderVersion: '1.16.5',
    },
    transactions: [
      { to: POOL_LOGIC_PROXY_ADMIN, value: '0', data: poolLogicUpgradeCalldata },
      { to: TOKEN_LOGIC_PROXY, value: '0', data: tokenLogicUpgradeCalldata },
    ],
  };
  const safeFile = path.join(dir, `core-upgrade-dao-safe-${chainId}.json`);
  fs.writeFileSync(safeFile, JSON.stringify(safeBatch, null, 2));

  console.log('\nNo transactions sent (default, safest mode). Wrote two review artifacts:');
  console.log('  GOVERNANCE_SAFE (EOA) transaction list          :', eoaFile);
  console.log('  DAO Safe (3-of-4 multisig) batch (PoolLogic + TokenLogic):', safeFile);
  console.log('\nImport the DAO Safe batch at https://app.safe.global under', DAO_SAFE);
  console.log('The GOVERNANCE_SAFE list must be signed and sent directly by that key\'s holder.');
  console.log('Both TokenLogic and PoolLogic transactions bundle their mandatory migration');
  console.log('call atomically — see the script header for why, and for the PoolLogic reward');
  console.log('migration\'s verification status before executing against real staked funds.');
  console.log('Set SEND=1 to instead broadcast all four upgrades directly with the local signer');
  console.log('(fork/testnet use only).');
}

main().catch((error) => {
  console.error('Script failed:', error);
  process.exitCode = 1;
});
