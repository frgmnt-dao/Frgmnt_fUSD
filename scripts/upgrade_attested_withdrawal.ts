import fs from 'fs';
import path from 'path';
import { ethers } from 'hardhat';

// --------------------------------------------------
// Upgrades the live PoolLogic proxy (Base mainnet, chainId 8453) to add the Attested
// Selective Withdrawal feature — see docs/attested-selective-withdrawal-design.md for the
// full design and docs/upgradeable-contracts-notes.md's "Attested Selective Withdrawal
// Upgrade" section for the migration checklist this script implements.
//
// *** REAL, ALREADY-STAKED USER FUNDS ARE LIVE IN THIS POOL. This script never sends a ***
// *** transaction unless SEND=1 is explicitly set (fork/testnet use only) — the default ***
// *** mode only deploys new implementations/libraries and writes review artifacts.     ***
//
// POOL_LOGIC_PROXY, POOL_LOGIC_PROXY_ADMIN, and DAO_SAFE below are now independently
// re-verified on-chain (direct eth_call reads against Base mainnet, not copied from another
// script's comments): PoolLogic(POOL_LOGIC_PROXY).owner(), ProxyAdmin(POOL_LOGIC_PROXY_ADMIN)
// .owner(), Governance.owner(), AssetHandler.owner(), and PoolManagerLogic.factoryOwner()
// all currently resolve to the same address, confirmed by its deployed bytecode to be a
// Gnosis Safe proxy (not an EOA) and documented elsewhere in this repo as a 3-of-4 Safe.
// This superseded an earlier draft of this script, written in the same session, whose
// verification attempt hit RPC rate-limiting and could not confirm these values — that
// failure mode is exactly why this script re-checks live custody at runtime below (see
// the startup assertion in main()) rather than trusting these defaults blindly forever.
// Custody can still change after this comment is written; override via the same-named env
// vars if it has, and the runtime check will catch a stale default either way.
//
// LIVE STATE THIS SCRIPT ASSUMES (verify before signing — it is read at run time below):
//   The live proxy is NOT yet on the CertiK-validated feature/06-aave-v4 implementation; it is on
//   the older `audit`-branch implementation at initializer version 1, with no
//   compoundedRewardIndex. scripts/upgrade_core_contracts.ts (audit -> feature/06-aave-v4) has not
//   been executed. This script therefore also handles the version-2 auto-compounding migration
//   (see MANDATORY MIGRATION SEQUENCE below) rather than assuming it has run.
//
// STORAGE-LAYOUT VERIFICATION (empirically diffed with compiler storageLayout output, and by a
// dynamic upgrade of an `audit`-implementation proxy — slots 0-44 byte-identical before/after):
//   - Slots 0-16 are identical in the live (`audit`) implementation, feature/06-aave-v4 and this
//     branch.
//   - feature/06-aave-v4 appended slots 17-22 (compoundedRewardIndex, autoCompoundStartRewardPerShare,
//     rewardIndexInitialized, withdrawalEscrow, finalizedUnclaimedFusd, pendingCashWithdrawCount).
//   - This branch appends 10 more strictly after pendingCashWithdrawCount, slots 23-32:
//     withdrawalAttester, pendingWithdrawalAttester, pendingAttesterActivationTime,
//     attesterRotationDelay, consumedPlanNonce, isAttestedWithdrawEnabled, attestedWithdrawVolume
//     (uint64 + uint128 packed in one slot), attestedWithdrawDecayWindow,
//     maxAttestedWithdrawVolumePerWindow, maxSurchargeBps. Live -> this branch is therefore 16
//     appended variables in total. PoolLogic has no __gap — append-only ordering is what upgrade
//     safety relies on, same as every prior PoolLogic migration (see
//     docs/upgradeable-contracts-notes.md).
//   - _withdrawProcessing/_checkCallResult and the pro-rata orchestration
//     (_withdrawCashImmediateToSafe/_withdrawProRata/_withdrawProRataInternal/_withdrawOne)
//     moved into the new WithdrawalPlanLib.sol — pure code motion, declares no storage of
//     its own, does not affect this migration's storage-layout accounting.
//   - OZ upgrades plugin's forceImport/validateUpgrade does not support PoolLogic's
//     externally-linked libraries the same way deployProxy does; this manual diff is
//     authoritative, exactly as for every prior PoolLogic upgrade in this repo.
//
// MANDATORY MIGRATION SEQUENCE — one atomic Safe batch, in THIS order:
//   1. ProxyAdmin.upgradeAndCall(proxy, newImpl, "0x")   — EMPTY init data. The initializers below
//      are onlyOwner; inside upgradeAndCall's delegatecall msg.sender is the ProxyAdmin, not the
//      Safe, so bundling them as upgradeAndCall data reverts OwnableUnauthorizedAccount. They must
//      be separate transactions sent BY THE SAFE (the proxy's owner), atomic via the Safe's
//      MultiSend batch.
//   2. PoolLogic.initializeAutoCompounding()             — reinitializer(2). ONLY IF the live pool
//      has not run it (compoundedRewardIndex == 0 / reverts). It MUST come before step 3: if
//      initializeAttestedWithdrawal (reinitializer(3)) runs first, this one permanently reverts
//      InvalidInitialization, compoundedRewardIndex stays 0, and stake/unstake/harvest are dead
//      until another implementation upgrade. The script detects this at run time and includes it.
//   3. PoolLogic.initializeAttestedWithdrawal(attester_, attesterRotationDelay_,
//      attestedWithdrawDecayWindow_, maxAttestedWithdrawVolumePerWindow_, maxSurchargeBps_)
//      (onlyOwner, reinitializer(3)). Reverts RotationDelayTooShort/DecayWindowTooShort if either
//      delay/window argument is below its floor (MIN_ATTESTER_ROTATION_DELAY = 24h,
//      MIN_ATTESTED_WITHDRAW_DECAY_WINDOW = 1h). It deliberately leaves isAttestedWithdrawEnabled
//      FALSE: the feature stays inert until the manager calls setAttestedWithdrawEnabled(true)
//      after verifying the attester service.
//
// WITHDRAWAL ATTESTER ADDRESS: this is a real operational decision (the off-chain
// attester backend service's signing address, or an ERC-1271 contract wrapping it) — not
// something this script or codebase can choose. ATTESTER_ADDRESS below MUST be set to the
// real, currently-operational signer before this migration is executed; there is no safe
// default, and this script refuses to proceed with the placeholder zero address.
//
// LIBRARY LINKING: PoolLogic now links FundCalculationLibrary, PoolTxExecutor,
// CallResultChecker (unchanged since this repo's last verified upgrade), and the new
// WithdrawalPlanLib (which itself links FundCalculationLibrary). This script freshly
// deploys ALL FOUR libraries rather than reusing addresses from a prior script, precisely
// because this session could not independently confirm which library addresses (if any)
// from scripts/upgrade_core_contracts.ts are actually live on-chain yet — redeploying from
// current source is self-contained and correct regardless of whether that prior upgrade has
// executed. If it is confirmed that upgrade_core_contracts.ts's redeployed
// FundCalculationLibrary/PoolTxExecutor are already live and unchanged since, reusing those
// addresses instead would save gas — a decision for whoever executes this, not this script.
//
// SECURITY MODEL: same two-phase separation as scripts/upgrade_core_contracts.ts. Phase 1
// (permissionless) deploys and self-checks every new implementation/library. Phase 2
// (owner-gated) is never sent directly by default — written to disk as a review artifact.
// SEND=1 opts into direct broadcast (fork/testnet use only).
// --------------------------------------------------

// --- Verified on-chain (see header) — override via env var if custody has since changed ---
const POOL_LOGIC_PROXY =
  process.env.POOL_LOGIC_PROXY ?? '0x704c56974e0CA4BF8ff8fe8acc51FBF1E053878E';
const POOL_LOGIC_PROXY_ADMIN =
  process.env.POOL_LOGIC_PROXY_ADMIN ?? '0xAff9948386da7C7687f0CDBB079b34F69d8199B5';
const DAO_SAFE = process.env.DAO_SAFE ?? '0x74aF72D91D5FB263fBa09Ed43aD1C1ea079058B3';

// --- REQUIRED: the real, currently-operational withdrawal attester signer ---
const ATTESTER_ADDRESS = process.env.ATTESTER_ADDRESS ?? ethers.ZeroAddress;

// --- Operational parameters — product/governance decisions, not code choices. Defaults
//     below equal each floor exactly (the most conservative legal value) and MUST be
//     reviewed, not assumed correct for production. ---
const ATTESTER_ROTATION_DELAY_SECONDS = process.env.ATTESTER_ROTATION_DELAY_SECONDS
  ? BigInt(process.env.ATTESTER_ROTATION_DELAY_SECONDS)
  : 24n * 60n * 60n; // MIN_ATTESTER_ROTATION_DELAY
const ATTESTED_WITHDRAW_DECAY_WINDOW_SECONDS = process.env.ATTESTED_WITHDRAW_DECAY_WINDOW_SECONDS
  ? BigInt(process.env.ATTESTED_WITHDRAW_DECAY_WINDOW_SECONDS)
  : 60n * 60n; // MIN_ATTESTED_WITHDRAW_DECAY_WINDOW
// Start conservative per the design doc's own guidance ("a small multiple of typical daily
// attested-withdrawal volume") — this default (10,000 fUSD) is a placeholder, not a
// recommendation; there is no live usage data yet to size this against.
const MAX_ATTESTED_WITHDRAW_VOLUME_PER_WINDOW = process.env.MAX_ATTESTED_WITHDRAW_VOLUME_PER_WINDOW
  ? ethers.parseUnits(process.env.MAX_ATTESTED_WITHDRAW_VOLUME_PER_WINDOW, 18)
  : ethers.parseUnits('10000', 18);
// Surcharge ceiling — no floor to enforce (0 disables the surcharge safely), and no default
// recommendation beyond "starts disabled" until the team decides on a value; WithdrawalPlanLib's
// own hardcoded MAX_SURCHARGE_BPS_CEILING bounds whatever this is set to regardless.
const MAX_SURCHARGE_BPS = process.env.MAX_SURCHARGE_BPS
  ? BigInt(process.env.MAX_SURCHARGE_BPS)
  : 0n;

async function main() {
  if (!ethers.isAddress(POOL_LOGIC_PROXY) || POOL_LOGIC_PROXY === ethers.ZeroAddress) {
    throw new Error('POOL_LOGIC_PROXY is not a valid address — check the env var override.');
  }
  if (!ethers.isAddress(POOL_LOGIC_PROXY_ADMIN) || POOL_LOGIC_PROXY_ADMIN === ethers.ZeroAddress) {
    throw new Error('POOL_LOGIC_PROXY_ADMIN is not a valid address — check the env var override.');
  }
  if (!ethers.isAddress(DAO_SAFE) || DAO_SAFE === ethers.ZeroAddress) {
    throw new Error('DAO_SAFE is not a valid address — check the env var override.');
  }
  if (!ethers.isAddress(ATTESTER_ADDRESS) || ATTESTER_ADDRESS === ethers.ZeroAddress) {
    throw new Error(
      'Set ATTESTER_ADDRESS (env var) to the real withdrawal-attester signer — an off-chain ' +
        'operational decision this script cannot make for you. This is the highest-risk, ' +
        'most-automated signing key in the protocol (see docs/attested-selective-' +
        "withdrawal-design.md's Trust Model section) — do not deploy a placeholder.",
    );
  }
  if (ATTESTER_ROTATION_DELAY_SECONDS < 24n * 60n * 60n) {
    throw new Error(
      'ATTESTER_ROTATION_DELAY_SECONDS is below MIN_ATTESTER_ROTATION_DELAY (24h) — ' +
        'initializeAttestedWithdrawal() will revert RotationDelayTooShort on-chain anyway, ' +
        'failing here first avoids wasting a deploy.',
    );
  }
  if (ATTESTED_WITHDRAW_DECAY_WINDOW_SECONDS < 60n * 60n) {
    throw new Error(
      'ATTESTED_WITHDRAW_DECAY_WINDOW_SECONDS is below MIN_ATTESTED_WITHDRAW_DECAY_WINDOW ' +
        '(1h) — initializeAttestedWithdrawal() will revert DecayWindowTooShort on-chain ' +
        'anyway, failing here first avoids wasting a deploy.',
    );
  }

  const [signer] = await ethers.getSigners();
  console.log('Signer (gas payer, deploy only — not the DAO Safe):', signer.address);

  // -----------------------------------------------------------------------
  // Live custody re-check — mirrors scripts/remediate_eoa_centralization.ts's own pattern
  // of re-confirming every target's current state immediately before acting on it, rather
  // than trusting a hardcoded default indefinitely. Custody was independently verified
  // on-chain while writing this script (see the header comment); this re-confirms it has
  // not drifted since, and refuses to build a real upgrade batch against stale assumptions.
  // -----------------------------------------------------------------------
  console.log('\n=== Re-verifying live custody before building anything ===');
  const ownableAbi = ['function owner() view returns (address)'];
  const poolLogicOwner = await new ethers.Contract(POOL_LOGIC_PROXY, ownableAbi, signer).owner();
  const proxyAdminOwner = await new ethers.Contract(
    POOL_LOGIC_PROXY_ADMIN,
    ownableAbi,
    signer,
  ).owner();
  if (poolLogicOwner.toLowerCase() !== DAO_SAFE.toLowerCase()) {
    throw new Error(
      `PoolLogic(${POOL_LOGIC_PROXY}).owner() is currently ${poolLogicOwner}, not the ` +
        `expected DAO_SAFE (${DAO_SAFE}). Custody has changed since this script was last ` +
        'verified — update DAO_SAFE (and every downstream assumption in this script) before ' +
        'proceeding, do not override this check.',
    );
  }
  if (proxyAdminOwner.toLowerCase() !== DAO_SAFE.toLowerCase()) {
    throw new Error(
      `ProxyAdmin(${POOL_LOGIC_PROXY_ADMIN}).owner() is currently ${proxyAdminOwner}, not ` +
        `the expected DAO_SAFE (${DAO_SAFE}). Custody has changed since this script was last ` +
        'verified — update DAO_SAFE before proceeding, do not override this check.',
    );
  }
  console.log('Confirmed: both PoolLogic.owner() and the ProxyAdmin.owner() match DAO_SAFE.');

  console.log('\nOperational parameters for this run:');
  console.log('  ATTESTER_ADDRESS                      :', ATTESTER_ADDRESS);
  console.log(
    '  ATTESTER_ROTATION_DELAY_SECONDS        :',
    ATTESTER_ROTATION_DELAY_SECONDS.toString(),
  );
  console.log(
    '  ATTESTED_WITHDRAW_DECAY_WINDOW_SECONDS :',
    ATTESTED_WITHDRAW_DECAY_WINDOW_SECONDS.toString(),
  );
  console.log(
    '  MAX_ATTESTED_WITHDRAW_VOLUME_PER_WINDOW:',
    ethers.formatUnits(MAX_ATTESTED_WITHDRAW_VOLUME_PER_WINDOW, 18),
    'fUSD',
  );
  console.log('  MAX_SURCHARGE_BPS                      :', MAX_SURCHARGE_BPS.toString());

  // -----------------------------------------------------------------------
  // Phase 1: libraries — freshly deployed, self-contained (see header comment on why
  // this doesn't reuse addresses from scripts/upgrade_core_contracts.ts).
  // -----------------------------------------------------------------------
  console.log('\n=== Deploying libraries ===');

  const CallResultChecker = await ethers.getContractFactory('CallResultChecker', signer);
  const callResultChecker = await CallResultChecker.deploy();
  await callResultChecker.waitForDeployment();
  console.log('CallResultChecker:', callResultChecker.target);

  const FundCalculationLibrary = await ethers.getContractFactory('FundCalculationLibrary', signer);
  const fundLib = await FundCalculationLibrary.deploy();
  await fundLib.waitForDeployment();
  console.log('FundCalculationLibrary:', fundLib.target);

  const PoolTxExecutor = await ethers.getContractFactory('PoolTxExecutor', {
    signer,
    libraries: { CallResultChecker: callResultChecker.target },
  });
  const poolTxExecutor = await PoolTxExecutor.deploy();
  await poolTxExecutor.waitForDeployment();
  console.log('PoolTxExecutor:', poolTxExecutor.target);

  const WithdrawalPlanLib = await ethers.getContractFactory('WithdrawalPlanLib', {
    signer,
    libraries: { FundCalculationLibrary: fundLib.target },
  });
  const withdrawalPlanLib = await WithdrawalPlanLib.deploy();
  await withdrawalPlanLib.waitForDeployment();
  console.log('WithdrawalPlanLib:', withdrawalPlanLib.target);

  // -----------------------------------------------------------------------
  // Phase 1b: PoolLogic (Transparent, linked libraries) — new implementation.
  // Not wrapped in upgrades.forceImport/validateUpgrade: the OZ upgrades plugin doesn't
  // support externally-linked libraries for upgrade validation (same limitation noted in
  // scripts/upgrade_core_contracts.ts) — storage-layout safety rests on this script's
  // header comment and docs/upgradeable-contracts-notes.md's manual diff instead.
  // -----------------------------------------------------------------------
  console.log('\n=== PoolLogic ===');
  const PoolLogicFactory = await ethers.getContractFactory('PoolLogic', {
    signer,
    libraries: {
      FundCalculationLibrary: fundLib.target,
      PoolTxExecutor: poolTxExecutor.target,
      CallResultChecker: callResultChecker.target,
      WithdrawalPlanLib: withdrawalPlanLib.target,
    },
  });
  const newPoolLogicImpl = await PoolLogicFactory.deploy();
  await newPoolLogicImpl.waitForDeployment();
  const newPoolLogicImplAddress = await newPoolLogicImpl.getAddress();
  console.log('New implementation:', newPoolLogicImplAddress);

  // -----------------------------------------------------------------------
  // Phase 2: owner-gated calls, as one atomic Safe batch (see MANDATORY MIGRATION SEQUENCE in the
  // header). The initializers are onlyOwner and must be sent BY THE SAFE, not passed as
  // upgradeAndCall data — inside that delegatecall msg.sender is the ProxyAdmin, which is not the
  // owner, so the call would revert OwnableUnauthorizedAccount.
  // -----------------------------------------------------------------------
  const poolLogic = await ethers.getContractAt('PoolLogic', POOL_LOGIC_PROXY, signer);
  const poolLogicAdmin = await ethers.getContractAt('ProxyAdmin', POOL_LOGIC_PROXY_ADMIN, signer);

  // Detect the version-2 auto-compounding migration state on the LIVE proxy. On the older `audit`
  // implementation compoundedRewardIndex() does not exist, so the call reverts — that, or a zero
  // value, both mean "not initialized". If it is not initialized it MUST be initialized before the
  // version-3 initializer, or it can never be (reinitializer(2) would then revert
  // InvalidInitialization) and staking is permanently dead until another upgrade.
  let autoCompoundingInitialized = false;
  try {
    autoCompoundingInitialized = (await poolLogic.compoundedRewardIndex()) !== 0n;
  } catch {
    autoCompoundingInitialized = false;
  }
  console.log(
    '\nAuto-compounding (reinitializer(2)) already initialized on the live pool:',
    autoCompoundingInitialized,
  );
  if (!autoCompoundingInitialized) {
    console.log(
      'The batch will therefore include initializeAutoCompounding() BEFORE ' +
        'initializeAttestedWithdrawal() — the order is mandatory.',
    );
  }

  const upgradeCalldata = poolLogicAdmin.interface.encodeFunctionData('upgradeAndCall', [
    POOL_LOGIC_PROXY,
    newPoolLogicImplAddress,
    '0x',
  ]);
  const initializeAutoCompoundingCalldata = poolLogic.interface.encodeFunctionData(
    'initializeAutoCompounding',
  );
  const initializeAttestedWithdrawalCalldata = poolLogic.interface.encodeFunctionData(
    'initializeAttestedWithdrawal',
    [
      ATTESTER_ADDRESS,
      ATTESTER_ROTATION_DELAY_SECONDS,
      ATTESTED_WITHDRAW_DECAY_WINDOW_SECONDS,
      MAX_ATTESTED_WITHDRAW_VOLUME_PER_WINDOW,
      MAX_SURCHARGE_BPS,
    ],
  );

  const batchTransactions = [
    { to: POOL_LOGIC_PROXY_ADMIN, value: '0', data: upgradeCalldata },
    ...(autoCompoundingInitialized
      ? []
      : [{ to: POOL_LOGIC_PROXY, value: '0', data: initializeAutoCompoundingCalldata }]),
    { to: POOL_LOGIC_PROXY, value: '0', data: initializeAttestedWithdrawalCalldata },
  ];

  if (process.env.SEND === '1') {
    console.log(
      '\nSEND=1 set — sending the batch in order with the local signer (fork/testnet only; the ' +
        'signer must be the proxy owner).',
    );
    for (const tx of batchTransactions) {
      await (await signer.sendTransaction({ to: tx.to, data: tx.data })).wait();
    }
    console.log('Done.');
    return;
  }

  const chainId = (await ethers.provider.getNetwork()).chainId.toString();
  const dir = path.join(process.cwd(), 'deployments');
  fs.mkdirSync(dir, { recursive: true });

  const safeBatch = {
    version: '1.0',
    chainId,
    createdAt: Date.now(),
    meta: {
      name: 'PoolLogic upgrade — Attested Selective Withdrawal',
      description:
        `Upgrades PoolLogic to the new implementation (${newPoolLogicImplAddress}), linked ` +
        'against freshly-deployed FundCalculationLibrary, PoolTxExecutor, CallResultChecker, ' +
        'and the new WithdrawalPlanLib, as ONE atomic batch: (1) upgradeAndCall with empty data' +
        (autoCompoundingInitialized ? '' : ', (2) initializeAutoCompounding()') +
        `, then (${autoCompoundingInitialized ? '2' : '3'}) initializeAttestedWithdrawal(` +
        `${ATTESTER_ADDRESS}, ${ATTESTER_ROTATION_DELAY_SECONDS}, ` +
        `${ATTESTED_WITHDRAW_DECAY_WINDOW_SECONDS}, ` +
        `${MAX_ATTESTED_WITHDRAW_VOLUME_PER_WINDOW}, ${MAX_SURCHARGE_BPS}). The feature is ` +
        'left DISABLED (isAttestedWithdrawEnabled == false); the manager enables it explicitly ' +
        'after verifying the attester service. Propose via the DAO Safe ' +
        'multisig, do not execute with a single key. STRONGLY RECOMMENDED: dry-run against a ' +
        'fork of live mainnet state first, and independently reconfirm every address in this ' +
        "script's header before signing — this run's own live custody re-check already " +
        'passed (see console output above), but that only covers the moment this script ran, ' +
        'not the moment this batch is actually signed.',
      txBuilderVersion: '1.16.5',
    },
    transactions: batchTransactions,
  };
  const safeFile = path.join(dir, `attested-withdrawal-upgrade-dao-safe-${chainId}.json`);
  fs.writeFileSync(safeFile, JSON.stringify(safeBatch, null, 2));

  console.log('\nNo transactions sent (default, safest mode). Wrote one review artifact:');
  console.log('  DAO Safe batch:', safeFile);
  console.log('\nImport at https://app.safe.global under', DAO_SAFE);
  console.log(
    'Before proposing: independently reconfirm POOL_LOGIC_PROXY, POOL_LOGIC_PROXY_ADMIN,',
  );
  console.log('and DAO_SAFE on-chain, and confirm ATTESTER_ADDRESS is the real, currently-');
  console.log('operational attester signer. Set SEND=1 to instead broadcast directly with the');
  console.log('local signer (fork/testnet use only).');
}

main().catch((error) => {
  console.error('Script failed:', error);
  process.exitCode = 1;
});
