import fs from 'fs';
import path from 'path';
import { ethers, upgrades } from 'hardhat';

// --------------------------------------------------
// Remediates the live, auditor-flagged bug (CertiK) on Base mainnet (chainId 8453):
// deploy_contract_guard.ts passed PoolLogic's proxy address as POOL_FACTORY instead of
// PoolManagerLogic's. Confirmed on-chain 2026-08-06:
//   NftTrackerStorage(0x84F46CD368f0CB7290c47738B53b7B7FEC5aFF49).poolFactory()
//     == 0x704c56974e0CA4BF8ff8fe8acc51FBF1E053878E (PoolLogic proxy — wrong)
// PoolManagerLogic (0x9530E699E519D7BCF621BA7CA17e119B6865b5C7) is the address that
// actually implements getContractGuard(), which checkContractGuard() depends on.
//
// SECURITY MODEL — two phases, deliberately separated:
//
//   Phase 1 (this script, permissionless): deploys the new NftTrackerStorage
//   implementation using @openzeppelin/hardhat-upgrades' forceImport + validateUpgrade,
//   which cross-checks the new implementation's storage layout against the *actual live*
//   implementation on-chain and throws if they're incompatible — a stronger, automated
//   guarantee than manual diffing alone. This step needs only a funded gas-paying key,
//   not GOVERNANCE_SAFE; deploying a contract is not privileged.
//
//   Phase 2 (owner-gated: upgradeAndCall on the ProxyAdmin, then setPoolFactory on the
//   proxy) is NOT sent directly. GOVERNANCE_SAFE is a Gnosis Safe multisig (per
//   Timelock.sol's deployment comment), so by default this script only *builds* a Gnosis
//   Safe Transaction Builder-compatible JSON batch (written to
//   deployments/nfttracker-remediation-<chainId>.json) containing both calls, to be
//   reviewed and proposed through the Safe UI — requiring the multisig's normal
//   signature threshold, not a single private key. Set SEND=1 to instead sign and
//   broadcast directly with the local signer (only appropriate against a fork/testnet,
//   or if that signer genuinely holds sufficient privilege).
//
// The proxy ADDRESS does not change, so UniswapV3NonfungiblePositionGuard
// (0xA313f1AADFB45033498a20e2e2cfefD31D10c973, already registered in Governance for the
// Uniswap V3 Position Manager) needs no redeployment or re-registration — it starts
// working the moment this fix lands, since it stores the proxy address as an immutable
// constructor argument.
//
// No data-migration risk: checkContractGuard() gates every state-changing function on
// this contract and has been permanently reverting since deploy, so the tracking
// mappings are guaranteed empty. Nothing to preserve or migrate.
// --------------------------------------------------

const NFT_TRACKER_PROXY = '0x84F46CD368f0CB7290c47738B53b7B7FEC5aFF49';
const NFT_TRACKER_PROXY_ADMIN = '0x869B9dAF9811020c588F2583415C2f660061d77B';
const POOL_MANAGER_LOGIC = '0x9530E699E519D7BCF621BA7CA17e119B6865b5C7';
const GOVERNANCE_SAFE = '0xafb9B883637f72767ADf7193Bb3B8e59C02Ea05d';
const WRONG_POOL_FACTORY_EXPECTED = '0x704c56974e0CA4BF8ff8fe8acc51FBF1E053878E'; // PoolLogic — sanity check only

async function main() {
  const [signer] = await ethers.getSigners();
  console.log('Signer (gas payer, deploy only — not necessarily GOVERNANCE_SAFE):', signer.address);

  const nftTracker = await ethers.getContractAt('NftTrackerStorage', NFT_TRACKER_PROXY, signer);

  const poolFactoryBefore = await nftTracker.poolFactory();
  console.log('\nNftTrackerStorage.poolFactory() before:', poolFactoryBefore);
  if (poolFactoryBefore.toLowerCase() !== WRONG_POOL_FACTORY_EXPECTED.toLowerCase()) {
    throw new Error(
      `Unexpected current poolFactory (${poolFactoryBefore}) — expected the known-wrong ` +
        `PoolLogic address (${WRONG_POOL_FACTORY_EXPECTED}). Stop and re-verify before ` +
        `proceeding; this script assumes the specific, already-confirmed bug state.`,
    );
  }

  // -----------------------------------------------------------------------
  // Phase 1: deploy + storage-layout-validate the new implementation.
  // -----------------------------------------------------------------------
  console.log('\nImporting the live proxy into the upgrades plugin (forceImport)...');
  const NftTrackerStorageFactory = await ethers.getContractFactory('NftTrackerStorage', signer);
  await upgrades.forceImport(NFT_TRACKER_PROXY, NftTrackerStorageFactory, { kind: 'transparent' });

  console.log('Validating storage-layout compatibility against the live implementation...');
  await upgrades.validateUpgrade(NFT_TRACKER_PROXY, NftTrackerStorageFactory);
  console.log('Storage layout confirmed compatible.');

  console.log('\nDeploying new NftTrackerStorage implementation (adds setPoolFactory)...');
  const newImpl = await NftTrackerStorageFactory.deploy();
  await newImpl.waitForDeployment();
  const newImplAddress = await newImpl.getAddress();
  console.log('New implementation deployed at:', newImplAddress);

  // -----------------------------------------------------------------------
  // Phase 2: owner-gated calls — build a Safe Transaction Builder batch by default.
  // -----------------------------------------------------------------------
  const proxyAdmin = await ethers.getContractAt('ProxyAdmin', NFT_TRACKER_PROXY_ADMIN, signer);
  const upgradeCalldata = proxyAdmin.interface.encodeFunctionData('upgradeAndCall', [
    NFT_TRACKER_PROXY,
    newImplAddress,
    '0x',
  ]);
  const setPoolFactoryCalldata = nftTracker.interface.encodeFunctionData('setPoolFactory', [
    POOL_MANAGER_LOGIC,
  ]);

  if (process.env.SEND === '1') {
    console.log('\nSEND=1 set — signing and broadcasting directly with the local signer.');
    console.log('Upgrading proxy via ProxyAdmin...');
    await (await proxyAdmin.upgradeAndCall(NFT_TRACKER_PROXY, newImplAddress, '0x')).wait();
    console.log('Calling setPoolFactory(PoolManagerLogic)...');
    await (await nftTracker.setPoolFactory(POOL_MANAGER_LOGIC)).wait();

    const poolFactoryAfter = await nftTracker.poolFactory();
    console.log('NftTrackerStorage.poolFactory() after:', poolFactoryAfter);
    if (poolFactoryAfter.toLowerCase() !== POOL_MANAGER_LOGIC.toLowerCase()) {
      throw new Error('poolFactory did not update as expected — investigate before relying on this fix.');
    }
    console.log('\nDone.');
    return;
  }

  const chainId = (await ethers.provider.getNetwork()).chainId.toString();
  const batch = {
    version: '1.0',
    chainId,
    createdAt: Date.now(),
    meta: {
      name: 'NftTrackerStorage poolFactory remediation',
      description:
        'Upgrades NftTrackerStorage to the setPoolFactory()-enabled implementation and ' +
        'corrects poolFactory from PoolLogic to PoolManagerLogic. Propose via the ' +
        'GOVERNANCE_SAFE multisig, do not execute with a single key.',
      txBuilderVersion: '1.16.5',
    },
    transactions: [
      { to: NFT_TRACKER_PROXY_ADMIN, value: '0', data: upgradeCalldata },
      { to: NFT_TRACKER_PROXY, value: '0', data: setPoolFactoryCalldata },
    ],
  };

  const dir = path.join(process.cwd(), 'deployments');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `nfttracker-remediation-${chainId}.json`);
  fs.writeFileSync(file, JSON.stringify(batch, null, 2));

  console.log('\nNo transactions sent (default, safest mode). Wrote a Gnosis Safe Transaction');
  console.log('Builder batch to:', file);
  console.log('Import it at https://app.safe.global under GOVERNANCE_SAFE ' + GOVERNANCE_SAFE);
  console.log('and propose it for the multisig to review and sign. Set SEND=1 to instead');
  console.log('broadcast directly with the local signer (fork/testnet use only).');
}

main().catch((error) => {
  console.error('Script failed:', error);
  process.exitCode = 1;
});
