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
// STORAGE-LAYOUT VERIFICATION (manual diff, current live PoolLogic vs this branch):
//   - 10 new state variables (withdrawalAttester, pendingWithdrawalAttester,
//     pendingAttesterActivationTime, attesterRotationDelay, consumedPlanNonce,
//     isAttestedWithdrawEnabled, attestedWithdrawVolume, attestedWithdrawDecayWindow,
//     maxAttestedWithdrawVolumePerWindow, maxSurchargeBps), all appended strictly after
//     pendingCashWithdrawCount (the previous last state variable). PoolLogic has no __gap —
//     append-only ordering is what upgrade safety relies on here, same as every prior
//     PoolLogic migration (see docs/upgradeable-contracts-notes.md).
//   - _withdrawProcessing/_checkCallResult and the pro-rata orchestration
//     (_withdrawCashImmediateToSafe/_withdrawProRata/_withdrawProRataInternal/_withdrawOne)
//     moved into the new WithdrawalPlanLib.sol — pure code motion, declares no storage of
//     its own, does not affect this migration's storage-layout accounting.
//   - OZ upgrades plugin's forceImport/validateUpgrade does not support PoolLogic's
//     externally-linked libraries the same way deployProxy does; this manual diff is
//     authoritative, exactly as for every prior PoolLogic upgrade in this repo.
//
// MANDATORY POST-UPGRADE MIGRATION CALL — MUST be bundled atomically with the proxy
// upgrade itself (via upgradeAndCall's data parameter), not run as a separate later
// transaction:
//
//   PoolLogic.initializeAttestedWithdrawal(attester_, attesterRotationDelay_,
//   attestedWithdrawDecayWindow_, maxAttestedWithdrawVolumePerWindow_, maxSurchargeBps_)
//   (onlyOwner, reinitializer(3)). Reverts RotationDelayTooShort/DecayWindowTooShort if
//   either delay/window argument is below its respective floor (MIN_ATTESTER_ROTATION_DELAY
//   = 24h, MIN_ATTESTED_WITHDRAW_DECAY_WINDOW = 1h) — the feature cannot launch in an
//   already-defeated state via this call. Leaving the proxy upgraded without this call is
//   not itself unsafe for EXISTING functionality (the new withdrawal path stays disabled —
//   isAttestedWithdrawEnabled defaults to false — and every other function is unaffected),
//   but bundling avoids a second, separately-reviewed transaction.
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
  // Phase 2: owner-gated call, bundled atomically via upgradeAndCall's data parameter.
  // -----------------------------------------------------------------------
  const poolLogic = await ethers.getContractAt('PoolLogic', POOL_LOGIC_PROXY, signer);
  const poolLogicAdmin = await ethers.getContractAt('ProxyAdmin', POOL_LOGIC_PROXY_ADMIN, signer);

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
  const poolLogicUpgradeCalldata = poolLogicAdmin.interface.encodeFunctionData('upgradeAndCall', [
    POOL_LOGIC_PROXY,
    newPoolLogicImplAddress,
    initializeAttestedWithdrawalCalldata,
  ]);

  if (process.env.SEND === '1') {
    console.log(
      '\nSEND=1 set — signing and broadcasting the upgrade directly with the local signer.',
    );
    await (
      await poolLogicAdmin.upgradeAndCall(
        POOL_LOGIC_PROXY,
        newPoolLogicImplAddress,
        initializeAttestedWithdrawalCalldata,
      )
    ).wait();
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
        'and the new WithdrawalPlanLib, bundling initializeAttestedWithdrawal(' +
        `${ATTESTER_ADDRESS}, ${ATTESTER_ROTATION_DELAY_SECONDS}, ` +
        `${ATTESTED_WITHDRAW_DECAY_WINDOW_SECONDS}, ` +
        `${MAX_ATTESTED_WITHDRAW_VOLUME_PER_WINDOW}, ${MAX_SURCHARGE_BPS}) atomically. Propose via the DAO Safe ` +
        'multisig, do not execute with a single key. STRONGLY RECOMMENDED: dry-run against a ' +
        'fork of live mainnet state first, and independently reconfirm every address in this ' +
        "script's header before signing — this run's own live custody re-check already " +
        'passed (see console output above), but that only covers the moment this script ran, ' +
        'not the moment this batch is actually signed.',
      txBuilderVersion: '1.16.5',
    },
    transactions: [{ to: POOL_LOGIC_PROXY_ADMIN, value: '0', data: poolLogicUpgradeCalldata }],
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
