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
// EVERY MAINNET ADDRESS BELOW IS A REQUIRED PLACEHOLDER, NOT A VERIFIED VALUE. Unlike
// scripts/upgrade_core_contracts.ts (whose addresses were independently confirmed on-chain
// at the time it was written), this script's proxy/admin addresses could not be
// re-confirmed in this session — a read against the address recorded in that script's own
// comments (POOL_LOGIC_PROXY_ADMIN.getProxyImplementation(POOL_LOGIC_PROXY) and a direct
// EIP-1967 implementation-slot read on the proxy) both came back empty/reverted rather than
// returning a live implementation address. Fill in every placeholder below only after
// independently re-confirming it on-chain (e.g. via a block explorer or a fresh
// eth_getStorageAt / ProxyAdmin.getProxyImplementation call) — do not copy the values from
// scripts/upgrade_core_contracts.ts's comments without re-verifying them yourself first.
//
// STORAGE-LAYOUT VERIFICATION (manual diff, current live PoolLogic vs this branch):
//   - 9 new state variables (withdrawalAttester, pendingWithdrawalAttester,
//     pendingAttesterActivationTime, attesterRotationDelay, consumedPlanNonce,
//     isAttestedWithdrawEnabled, attestedWithdrawVolume, attestedWithdrawDecayWindow,
//     maxAttestedWithdrawVolumePerWindow), all appended strictly after
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
//   attestedWithdrawDecayWindow_, maxAttestedWithdrawVolumePerWindow_)
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

// --- REQUIRED: fill in and independently re-verify on-chain before use ---
const POOL_LOGIC_PROXY = process.env.POOL_LOGIC_PROXY ?? '';
const POOL_LOGIC_PROXY_ADMIN = process.env.POOL_LOGIC_PROXY_ADMIN ?? '';
const DAO_SAFE = process.env.DAO_SAFE ?? '';

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

async function main() {
  if (!ethers.isAddress(POOL_LOGIC_PROXY) || POOL_LOGIC_PROXY === ethers.ZeroAddress) {
    throw new Error(
      'Set POOL_LOGIC_PROXY (env var) to the live PoolLogic proxy address — independently ' +
        're-verified on-chain, not copied from another script without checking. This ' +
        "script's own on-chain check in this session could not confirm the address " +
        'recorded in scripts/upgrade_core_contracts.ts is still current.',
    );
  }
  if (!ethers.isAddress(POOL_LOGIC_PROXY_ADMIN) || POOL_LOGIC_PROXY_ADMIN === ethers.ZeroAddress) {
    throw new Error('Set POOL_LOGIC_PROXY_ADMIN (env var) to the live ProxyAdmin address.');
  }
  if (!ethers.isAddress(DAO_SAFE) || DAO_SAFE === ethers.ZeroAddress) {
    throw new Error(
      'Set DAO_SAFE (env var) to the Safe that holds PoolLogic onlyOwner/ProxyAdmin custody ' +
        '— per scripts/upgrade_core_contracts.ts, this was the 3-of-4 Gnosis Safe at ' +
        '0x74aF72D91D5FB263fBa09Ed43aD1C1ea079058B3 at the time that script was written; ' +
        're-verify custody has not changed before reusing that value.',
    );
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
        `${MAX_ATTESTED_WITHDRAW_VOLUME_PER_WINDOW}) atomically. Propose via the DAO Safe ` +
        'multisig, do not execute with a single key. STRONGLY RECOMMENDED: dry-run against a ' +
        'fork of live mainnet state first, and independently reconfirm every address in this ' +
        "script's header before signing — see that header comment for what could not be " +
        'verified in the session that wrote this script.',
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
