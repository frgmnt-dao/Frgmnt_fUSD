import { ethers } from 'hardhat';

// --------------------------------------------------
// Remediates the live, auditor-flagged bug (CertiK) on Base mainnet (chainId 8453):
// deploy_contract_guard.ts passed PoolLogic's proxy address as POOL_FACTORY instead of
// PoolManagerLogic's. Confirmed on-chain 2026-08-06:
//   NftTrackerStorage(0x84F46CD368f0CB7290c47738B53b7B7FEC5aFF49).poolFactory()
//     == 0x704c56974e0CA4BF8ff8fe8acc51FBF1E053878E (PoolLogic proxy — wrong)
// PoolManagerLogic (0x9530E699E519D7BCF621BA7CA17e119B6865b5C7) is the address that
// actually implements getContractGuard(), which checkContractGuard() depends on.
//
// NftTrackerStorage is an upgradeable transparent proxy with no existing setter for
// poolFactory, so this is a two-step, in-place fix — NOT a redeploy:
//   1) Upgrade the proxy's implementation to the new NftTrackerStorage build that adds
//      setPoolFactory() (contracts/contracts/utils/tracker/NftTrackerStorage.sol,
//      commit 5f697e0 on feature/06-aave-v4). No storage layout change — only a new
//      function/event were added — so this upgrade is storage-safe.
//   2) Call setPoolFactory(POOL_MANAGER_LOGIC) once, as the contract's owner.
//
// The proxy ADDRESS does not change, so UniswapV3NonfungiblePositionGuard
// (0xA313f1AADFB45033498a20e2e2cfefD31D10c973, already registered in Governance for the
// Uniswap V3 Position Manager) needs no redeployment or re-registration at all — it will
// simply start working once this script runs, since it stores the proxy address as an
// immutable constructor argument.
//
// No data-migration risk: checkContractGuard() gates every state-changing function on
// this contract and has been permanently reverting since deploy (confirmed empirically —
// see the security.md / audit-response writeup), so the tracking mappings are guaranteed
// empty. Nothing to preserve or migrate.
//
// Preconditions to fill in / verify before running:
//   - Signer must be the ProxyAdmin's owner. Confirmed on-chain 2026-08-06: ProxyAdmin
//     0x869B9dAF9811020c588F2583415C2f660061d77B .owner() == GOVERNANCE_SAFE
//     (0xafb9B883637f72767ADf7193Bb3B8e59C02Ea05d) — same key used throughout this
//     deployment. Confirm this is still current before running (ownership may have
//     changed, e.g. via scripts/transferRoles_Governance.ts's Timelock lock-down, though
//     that script does not currently cover this ProxyAdmin either).
// --------------------------------------------------

const NFT_TRACKER_PROXY = '0x84F46CD368f0CB7290c47738B53b7B7FEC5aFF49';
const NFT_TRACKER_PROXY_ADMIN = '0x869B9dAF9811020c588F2583415C2f660061d77B';
const POOL_MANAGER_LOGIC = '0x9530E699E519D7BCF621BA7CA17e119B6865b5C7';
const WRONG_POOL_FACTORY_EXPECTED = '0x704c56974e0CA4BF8ff8fe8acc51FBF1E053878E'; // PoolLogic — sanity check only

async function main() {
  const [signer] = await ethers.getSigners();
  console.log('Signer:', signer.address);

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

  console.log('\nDeploying new NftTrackerStorage implementation (with setPoolFactory)...');
  const NftTrackerStorage = await ethers.getContractFactory('NftTrackerStorage', signer);
  const newImpl = await NftTrackerStorage.deploy();
  await newImpl.waitForDeployment();
  console.log('New implementation deployed at:', newImpl.target);

  console.log('\nUpgrading proxy via ProxyAdmin...');
  const proxyAdmin = await ethers.getContractAt('ProxyAdmin', NFT_TRACKER_PROXY_ADMIN, signer);
  await (await proxyAdmin.upgradeAndCall(NFT_TRACKER_PROXY, newImpl.target, '0x')).wait();
  console.log('Proxy upgraded.');

  console.log('\nCalling setPoolFactory(PoolManagerLogic)...');
  await (await nftTracker.setPoolFactory(POOL_MANAGER_LOGIC)).wait();

  const poolFactoryAfter = await nftTracker.poolFactory();
  console.log('NftTrackerStorage.poolFactory() after:', poolFactoryAfter);
  if (poolFactoryAfter.toLowerCase() !== POOL_MANAGER_LOGIC.toLowerCase()) {
    throw new Error('poolFactory did not update as expected — investigate before relying on this fix.');
  }

  console.log('\nDone. UniswapV3NonfungiblePositionGuard (0xA313f1AADFB45033498a20e2e2cfefD31D10c973)');
  console.log('should now be able to track/untrack NFT positions correctly — no changes needed');
  console.log('on that guard or its Governance registration.');
}

main().catch((error) => {
  console.error('Script failed:', error);
  process.exitCode = 1;
});
