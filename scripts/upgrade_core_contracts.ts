import fs from 'fs';
import path from 'path';
import { ethers, upgrades } from 'hardhat';
import { assertNoPendingWithdrawals } from './utils/upgradePreflight';

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
//   - AssetHandler:      3 new vars, appended before the storage gap (50 -> 47). Safe.
//   - PoolManagerLogic:  zero new state variables. __gap unchanged. Safe.
//   - PoolLogic:         17 new state variables in total (slots 17-33: 6 from feature/06, 11 from
//                         the attested-withdrawal feature), all strictly appended after every pre-existing
//                         variable. No __gap exists on this contract at all (never
//                         had one) — append-only ordering is what's relied on for
//                         safety, confirmed by direct comparison. Bytecode: 150 bytes
//                         of EIP-170 headroom on the current branch tip — fits, but tight.
//   - TokenLogic:        2 new vars, appended before the storage gap (40 -> 38). Safe.
// NOTE on the automatic check below: `forceImport(proxy, NewFactory)` followed by
// `validateUpgrade(proxy, NewFactory)` imports the proxy AS the new layout and then validates the new
// layout against itself, so it passes vacuously and would NOT catch an incompatible change. The
// authoritative evidence is the compiler-layout diff above and test/UpgradeFromAudit.test.ts (a real
// `audit`-implementation proxy upgraded to this branch). To make the plugin check meaningful,
// forceImport with a factory built from the `audit` branch instead.
//
// TWO MANDATORY POST-UPGRADE MIGRATION CALLS — MUST land atomically with their respective
// proxy upgrade, not as a separate later transaction. TokenLogic's is bundled as
// upgradeToAndCall data (msg.sender there is still the DAO Safe). PoolLogic's CANNOT be bundled
// as upgradeAndCall data — inside that delegatecall msg.sender is the ProxyAdmin, so the
// onlyOwner initializer would revert — so it is a separate owner-sent call placed in the same
// Safe MultiSend batch (atomic all the same). On this branch PoolLogic also links
// WithdrawalPlanLib and carries the attested-withdrawal feature, which stays dormant (disabled,
// no attester) until initializeAttestedWithdrawal() runs — see
// scripts/upgrade_attested_withdrawal.ts. If ATTESTER_ADDRESS is set, this script's DAO Safe batch
// also includes initializeAttestedWithdrawal() (same parameters and defaults as that script), so the
// full upgrade is ONE atomic batch; do NOT additionally run the attested script afterwards (it
// always deploys and upgrades again). Leave ATTESTER_ADDRESS unset to install the implementation
// only and enable the feature later.
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
// THIRD MANDATORY PoolLogic STEP (FNA-03): WithdrawalEscrow. PoolLogic.withdrawalEscrow starts
// at address(0) on the live proxy, and finalizeCashWithdraw() reverts EscrowNotSet() while it is
// unset — queued cash-withdraw finalization is blocked (fail-closed, no funds lost) until an
// escrow bound to the pool is deployed and wired with the onlyOwner initializeWithdrawalEscrow().
// This script therefore deploys WithdrawalEscrow(POOL_LOGIC_PROXY) in phase 1 and adds
// initializeWithdrawalEscrow(escrow) to the same DAO Safe batch, after the upgrade and
// initializeAutoCompounding(). Requests that were already finalized before the escrow existed
// keep using the legacy reservedAssetBalance bookkeeping (see PoolLogic.claimCashWithdraw).
//
// A FOURTH, UNRELATED GOVERNANCE_SAFE CALL (FNA-50), added to the same eoaBatch below but not
// bundled with any upgrade: AssetHandler.setSequencerUptimeFeed() — confirmed still unset on
// the live proxy (2026-08-30), which makes the sequencer-down grace-period check in
// _checkSequencerUp() a permanent no-op. Unlike the two migration calls above, this doesn't
// need atomicity with the AssetHandler upgrade — setSequencerUptimeFeed() already exists on
// the CURRENT live implementation — so it's issued as its own plain transaction directly
// against the proxy rather than through upgradeAndCall's data parameter.
//
// LIBRARY LINKING: PoolLogic links FundCalculationLibrary, PoolTxExecutor, CallResultChecker
// and WithdrawalPlanLib at compile time. The first two changed since audit and are redeployed
// here, WithdrawalPlanLib is new and deployed here (linked to the new FundCalculationLibrary);
// CallResultChecker is unchanged (confirmed via diff) and reused.
//
// CUSTODY UPDATE: the notes below were confirmed on-chain on 2026-08-07, when GOVERNANCE_SAFE had no
// contract code (a single EOA). The team has since confirmed that the deployed contracts are
// controlled by the multisig; main() reads every owner on-chain at run time and reports whether
// it is a contract, so treat the paragraph below as history, not as the current state.
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
// artifacts. (Phase 1 itself broadcasts deployments — libraries, implementations, the escrow —
// from the local signer even without SEND=1; only the owner-gated calls are withheld.)
// SEND=1 opts into direct broadcast of those too (fork/testnet use only).
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

// FNA-50: confirmed via direct eth_call against the live AssetHandler proxy (2026-08-30) that
// sequencerUptimeFeed() is still the zero address — the sequencer-down grace-period check has
// been a silent no-op since deployment. This is Chainlink's canonical L2 Sequencer Uptime Feed
// for Base (see docs/deployments.md). setSequencerUptimeFeed() is an ordinary onlyOwner call on
// AssetHandler itself (already present on the CURRENT live implementation, predating this
// upgrade — "FRG-52"), not part of the upgrade's storage/logic changes, so it does not need to
// be bundled into upgradeAndCall's post-upgrade data: a plain GOVERNANCE_SAFE transaction
// directly against the proxy (added to eoaBatch below) is simpler and avoids the transparent
// proxy's admin-vs-owner msg.sender distinction entirely (GOVERNANCE_SAFE is AssetHandler's own
// Ownable owner, confirmed on-chain, not the ProxyAdmin contract that would otherwise appear as
// msg.sender if this were bundled through ASSET_HANDLER_PROXY_ADMIN.upgradeAndCall instead).
const SEQUENCER_UPTIME_FEED = '0xBCF85224fc0756B9Fa45aA7892530B47e10b6433';

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
  console.log(
    'Signer (gas payer, deploy only — not GOVERNANCE_SAFE or the DAO Safe):',
    signer.address,
  );

  // -----------------------------------------------------------------------
  // Preflight (read-only): refuse to build a batch against live state the upgrade cannot handle.
  // -----------------------------------------------------------------------
  console.log('\n=== Preflight ===');
  // (a) A queued withdrawal still Pending at upgrade time can never be finalized afterwards
  //     (pendingCashWithdrawCount starts at 0 for it) — see scripts/utils/upgradePreflight.ts.
  await assertNoPendingWithdrawals(POOL_LOGIC_PROXY);
  // (b) Custody. Older notes in this repo recorded GOVERNANCE_SAFE as a single EOA; the team has
  //     since confirmed the deployed contracts are controlled by the multisig (the DAO Safe).
  //     Neither the constants nor the comments are trusted: read the owners on-chain, require
  //     each to be one of the two recorded addresses, and REPORT whether it is a contract. When
  //     the AssetHandler and PoolManagerLogic roles sit under the DAO Safe, their transactions
  //     are folded into the same Safe batch below instead of a separate single-key list.
  const ownableAbi = ['function owner() view returns (address)'];
  const isContract = async (a: string) => (await ethers.provider.getCode(a)) !== '0x';
  const recorded = [GOVERNANCE_SAFE, DAO_SAFE].map((a) => a.toLowerCase());
  const custody: [string, string, string[]][] = [
    ['AssetHandler ProxyAdmin owner', ASSET_HANDLER_PROXY_ADMIN, recorded],
    ['AssetHandler owner', ASSET_HANDLER_PROXY, recorded],
    ['PoolManagerLogic ProxyAdmin owner', POOL_MANAGER_LOGIC_PROXY_ADMIN, recorded],
    ['PoolLogic ProxyAdmin owner', POOL_LOGIC_PROXY_ADMIN, [DAO_SAFE.toLowerCase()]],
    ['PoolLogic owner', POOL_LOGIC_PROXY, [DAO_SAFE.toLowerCase()]],
  ];
  const owners: Record<string, string> = {};
  for (const [label, target, accepted] of custody) {
    const actual: string = await new ethers.Contract(target, ownableAbi, signer).owner();
    owners[label] = actual.toLowerCase();
    const ok = accepted.includes(actual.toLowerCase());
    const kind = (await isContract(actual)) ? 'contract (multisig)' : 'EOA (single key)';
    console.log(`  ${label}: ${actual} — ${kind} ${ok ? '' : '(UNEXPECTED)'}`);
    if (!ok && process.env.ALLOW_CUSTODY_MISMATCH !== '1') {
      throw new Error(
        `${label} is ${actual}, not one of the recorded custody addresses ` +
          `(${accepted.join(', ')}). Custody has changed since these constants were recorded; ` +
          'update them before proceeding. ALLOW_CUSTODY_MISMATCH=1 overrides this check.',
      );
    }
  }
  const governanceUnderDaoSafe = [
    'AssetHandler ProxyAdmin owner',
    'AssetHandler owner',
    'PoolManagerLogic ProxyAdmin owner',
  ].every((k) => owners[k] === DAO_SAFE.toLowerCase());
  console.log(
    governanceUnderDaoSafe
      ? '  -> AssetHandler and PoolManagerLogic roles are held by the DAO Safe: ONE Safe batch.'
      : '  -> AssetHandler / PoolManagerLogic roles are NOT all held by the DAO Safe: they stay in a separate list for their holder.',
  );

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
  console.log(
    '(CallResultChecker unchanged, reusing existing:',
    EXISTING_CALL_RESULT_CHECKER + ')',
  );

  // PoolLogic on this branch also links WithdrawalPlanLib (the extracted withdrawal
  // orchestration), which itself links FundCalculationLibrary. Without it PoolLogic cannot
  // be deployed at all.
  const WithdrawalPlanLibFactory = await ethers.getContractFactory('WithdrawalPlanLib', {
    signer,
    libraries: { FundCalculationLibrary: fundLib.target },
  });
  const withdrawalPlanLib = await WithdrawalPlanLibFactory.deploy();
  await withdrawalPlanLib.waitForDeployment();
  console.log('New WithdrawalPlanLib:', withdrawalPlanLib.target);

  // FNA-03: the escrow is immutable-bound to the pool PROXY address, so it can be deployed now
  // (the address is stable across the implementation upgrade) and wired in the Safe batch.
  const WithdrawalEscrowFactory = await ethers.getContractFactory('WithdrawalEscrow', signer);
  const withdrawalEscrow = await WithdrawalEscrowFactory.deploy(POOL_LOGIC_PROXY);
  await withdrawalEscrow.waitForDeployment();
  const withdrawalEscrowAddress = await withdrawalEscrow.getAddress();
  console.log('New WithdrawalEscrow (bound to the pool proxy):', withdrawalEscrowAddress);

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
  await upgrades.forceImport(POOL_MANAGER_LOGIC_PROXY, PoolManagerLogicFactory, {
    kind: 'transparent',
  });
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
      WithdrawalPlanLib: withdrawalPlanLib.target,
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
  const assetHandlerAdmin = await ethers.getContractAt(
    'ProxyAdmin',
    ASSET_HANDLER_PROXY_ADMIN,
    signer,
  );
  const assetHandler = await ethers.getContractAt('AssetHandler', ASSET_HANDLER_PROXY, signer);
  const poolManagerLogicAdmin = await ethers.getContractAt(
    'ProxyAdmin',
    POOL_MANAGER_LOGIC_PROXY_ADMIN,
    signer,
  );
  const tokenLogic = await ethers.getContractAt('TokenLogic', TOKEN_LOGIC_PROXY, signer);
  const poolLogic = await ethers.getContractAt('PoolLogic', POOL_LOGIC_PROXY, signer);
  const poolLogicAdmin = await ethers.getContractAt('ProxyAdmin', POOL_LOGIC_PROXY_ADMIN, signer);

  const assetHandlerUpgradeCalldata = assetHandlerAdmin.interface.encodeFunctionData(
    'upgradeAndCall',
    [ASSET_HANDLER_PROXY, newAssetHandlerImplAddress, '0x'],
  );
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
  // The upgrade itself carries EMPTY init data. initializeAutoCompounding() is onlyOwner, and
  // inside ProxyAdmin.upgradeAndCall's delegatecall msg.sender is the ProxyAdmin, not the owner,
  // so passing it as upgradeAndCall data would revert OwnableUnauthorizedAccount and fail the
  // whole batch. It is instead a separate call sent by the owner (the DAO Safe) and made atomic
  // with the upgrade by being in the same Safe MultiSend batch.
  const poolLogicUpgradeCalldata = poolLogicAdmin.interface.encodeFunctionData('upgradeAndCall', [
    POOL_LOGIC_PROXY,
    newPoolLogicImplAddress,
    '0x',
  ]);

  const initializeWithdrawalEscrowCalldata = poolLogic.interface.encodeFunctionData(
    'initializeWithdrawalEscrow',
    [withdrawalEscrowAddress],
  );

  // FNA-40: AssetHandler.eurUsdModeLocked is a NEW slot and is false on the live proxy. Until
  // clearEurUsdAggregator() runs once, the AssetHandler owner can still call setEurUsdAggregator()
  // and re-base the whole pool's NAV/fee/withdrawal accounting to EUR. It must run AFTER the
  // AssetHandler upgrade (the function does not exist on the current implementation), so it is
  // ordered after the upgrade transaction below.
  const clearEurUsdAggregatorCalldata =
    assetHandler.interface.encodeFunctionData('clearEurUsdAggregator');

  // Optional: the attested-withdrawal initializer, in the same atomic batch, when ATTESTER_ADDRESS
  // is set (same parameters/defaults as scripts/upgrade_attested_withdrawal.ts). Must come AFTER
  // initializeAutoCompounding() — see that script's MANDATORY MIGRATION SEQUENCE.
  const attesterAddress = process.env.ATTESTER_ADDRESS;
  const initializeAttestedWithdrawalCalldata =
    attesterAddress && ethers.isAddress(attesterAddress) && attesterAddress !== ethers.ZeroAddress
      ? poolLogic.interface.encodeFunctionData('initializeAttestedWithdrawal', [
          attesterAddress,
          BigInt(process.env.ATTESTER_ROTATION_DELAY_SECONDS ?? 24 * 60 * 60),
          BigInt(process.env.ATTESTED_WITHDRAW_DECAY_WINDOW_SECONDS ?? 60 * 60),
          ethers.parseUnits(process.env.MAX_ATTESTED_WITHDRAW_VOLUME_PER_WINDOW ?? '0', 18),
          BigInt(process.env.MAX_SURCHARGE_BPS ?? 0),
        ])
      : undefined;

  // FNA-50: plain call on the AssetHandler proxy itself, NOT routed through
  // ASSET_HANDLER_PROXY_ADMIN — see the SEQUENCER_UPTIME_FEED comment above for why.
  const setSequencerUptimeFeedCalldata = assetHandler.interface.encodeFunctionData(
    'setSequencerUptimeFeed',
    [SEQUENCER_UPTIME_FEED],
  );

  if (process.env.SEND === '1') {
    console.log(
      '\nSEND=1 set — signing and broadcasting all four upgrades directly with the local signer.',
    );
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
      await poolLogicAdmin.upgradeAndCall(POOL_LOGIC_PROXY, newPoolLogicImplAddress, '0x')
    ).wait();
    // Owner-sent, immediately after the upgrade (see poolLogicUpgradeCalldata above).
    await (await poolLogic.initializeAutoCompounding()).wait();
    await (await poolLogic.initializeWithdrawalEscrow(withdrawalEscrowAddress)).wait();
    if (initializeAttestedWithdrawalCalldata) {
      await (
        await signer.sendTransaction({
          to: POOL_LOGIC_PROXY,
          data: initializeAttestedWithdrawalCalldata,
        })
      ).wait();
    }
    await (await assetHandler.clearEurUsdAggregator()).wait();
    await (await assetHandler.setSequencerUptimeFeed(SEQUENCER_UPTIME_FEED)).wait();
    console.log('Done.');
    return;
  }

  const chainId = (await ethers.provider.getNetwork()).chainId.toString();
  const dir = path.join(process.cwd(), 'deployments');
  fs.mkdirSync(dir, { recursive: true });

  // AssetHandler and PoolManagerLogic transactions. If their roles are held by the DAO Safe they
  // are folded into the DAO Safe batch below; otherwise they are written as a separate list for
  // whoever holds those roles (TokenLogic's DEFAULT_ADMIN_ROLE and PoolLogic are the DAO Safe's).
  const governanceTxs = [
    {
      description: 'AssetHandler: upgrade ProxyAdmin to new implementation',
      to: ASSET_HANDLER_PROXY_ADMIN,
      value: '0',
      data: assetHandlerUpgradeCalldata,
    },
    {
      // FNA-40: must come AFTER the AssetHandler upgrade above (the function is new).
      description:
        'AssetHandler: clearEurUsdAggregator() — permanently lock the valuation basis to USD ' +
        '(FNA-40; the eurUsdModeLocked slot is false on the live proxy until this runs)',
      to: ASSET_HANDLER_PROXY,
      value: '0',
      data: clearEurUsdAggregatorCalldata,
    },
    {
      description: 'PoolManagerLogic: upgrade ProxyAdmin to new implementation',
      to: POOL_MANAGER_LOGIC_PROXY_ADMIN,
      value: '0',
      data: poolManagerLogicUpgradeCalldata,
    },
    {
      // FNA-50: a plain call directly on the AssetHandler PROXY (not its ProxyAdmin), by the
      // AssetHandler's own Ownable owner. Order relative to the upgrade doesn't matter:
      // setSequencerUptimeFeed() already exists on the currently-live implementation.
      description:
        'AssetHandler: set L2 sequencer uptime feed (FNA-50 — currently unset, disabling ' +
        'the sequencer-down grace period entirely)',
      to: ASSET_HANDLER_PROXY,
      value: '0',
      data: setSequencerUptimeFeedCalldata,
    },
  ];
  const eoaBatch = {
    signer: 'the holder of the AssetHandler / PoolManagerLogic roles (see the preflight output)',
    note:
      'Only written when those roles are NOT all held by the DAO Safe. Review and sign ' +
      'these transactions with whoever holds them (a hardware wallet if it is a single key).',
    transactions: governanceTxs,
  };
  const eoaFile = path.join(dir, `core-upgrade-governance-roles-${chainId}.json`);
  if (!governanceUnderDaoSafe) fs.writeFileSync(eoaFile, JSON.stringify(eoaBatch, null, 2));

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
        'linked against redeployed FundCalculationLibrary, PoolTxExecutor and ' +
        `WithdrawalPlanLib (${withdrawalPlanLib.target}), then calling ` +
        'initializeAutoCompounding() as a separate owner-sent transaction in the same atomic ' +
        'batch — stake/unstake/harvest stay broken for every staker until this batch lands. Also upgrades TokenLogic to the new ' +
        `implementation (${newTokenLogicImplAddress}), bundling ` +
        `initializeDepositFusdCap(${NEW_DEPOSIT_FUSD_CAP.toString()}) atomically — ` +
        'deposits stay broken (0 cap) until this transaction lands. Propose via the DAO ' +
        'Safe multisig, do not execute with a single key. STRONGLY RECOMMENDED: dry-run ' +
        'both transactions against a fork of live mainnet state first — see this ' +
        "script's header comment for what is and is not independently verified about " +
        'the reward migration math.',
      txBuilderVersion: '1.16.5',
    },
    transactions: [
      // When the DAO Safe also holds the AssetHandler / PoolManagerLogic roles their upgrade,
      // the FNA-40 lock and the sequencer feed are part of this same atomic batch.
      ...(governanceUnderDaoSafe
        ? governanceTxs.map(({ to, value, data }) => ({ to, value, data }))
        : []),
      { to: POOL_LOGIC_PROXY_ADMIN, value: '0', data: poolLogicUpgradeCalldata },
      // Sent by the Safe (PoolLogic's owner), in the same MultiSend batch as the upgrade above.
      { to: POOL_LOGIC_PROXY, value: '0', data: initializeAutoCompoundingCalldata },
      // FNA-03: wires the escrow; finalizeCashWithdraw() reverts EscrowNotSet() until this lands.
      { to: POOL_LOGIC_PROXY, value: '0', data: initializeWithdrawalEscrowCalldata },
      ...(initializeAttestedWithdrawalCalldata
        ? [{ to: POOL_LOGIC_PROXY, value: '0', data: initializeAttestedWithdrawalCalldata }]
        : []),
      { to: TOKEN_LOGIC_PROXY, value: '0', data: tokenLogicUpgradeCalldata },
    ],
  };
  const safeFile = path.join(dir, `core-upgrade-dao-safe-${chainId}.json`);
  fs.writeFileSync(safeFile, JSON.stringify(safeBatch, null, 2));

  console.log(
    '\nNo owner-gated transactions sent (default, safest mode). Wrote review artifact(s):',
  );
  if (!governanceUnderDaoSafe) {
    console.log('  AssetHandler / PoolManagerLogic role holder list :', eoaFile);
  }
  console.log('  DAO Safe batch:', safeFile);
  console.log('\nImport the DAO Safe batch at https://app.safe.global under', DAO_SAFE);
  if (!governanceUnderDaoSafe) {
    console.log('The separate role-holder list must be signed by whoever holds those roles.');
  }
  console.log('Both TokenLogic and PoolLogic transactions bundle their mandatory migration');
  console.log('call atomically — see the script header for why, and for the PoolLogic reward');
  console.log("migration's verification status before executing against real staked funds.");
  console.log('Set SEND=1 to instead broadcast all four upgrades directly with the local signer');
  console.log('(fork/testnet use only).');
}

main().catch((error) => {
  console.error('Script failed:', error);
  process.exitCode = 1;
});
