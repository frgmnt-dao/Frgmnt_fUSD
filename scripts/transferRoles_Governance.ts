import { ethers } from 'hardhat';

// --------------------------------------------------
// FNA-01: locks Governance and AssetHandler down to the already-deployed Timelock.
//
// Run this LAST, after the deployment/bootstrap sequence is fully done — i.e. after
// deploy_core_contracts.ts, deploy_asset_guards.ts, deploy_contract_guard.ts,
// set_Asset_Guard.ts, set_Contract_Guard.ts, add_assets.ts / add_supported_asset.ts have
// all been run with GOVERNANCE_SAFE (or the deployer key) as the direct, synchronous
// signer. Those scripts require Governance/AssetHandler to still be owned by a plain EOA
// or multisig; running this beforehand would strand the protocol, since every subsequent
// setAssetGuard/setContractGuard/addAsset call would then need to go through
// TimelockController's two-step schedule()+execute() flow with the full minDelay instead
// of a normal transaction.
//
// Once run, all further changes to contract guards, asset guards, and supported asset
// price feeds require a proposal through the Timelock (Timelock.sol's documented intent),
// giving on-chain visibility and a delay window before any such change takes effect.
// --------------------------------------------------

const GOVERNANCE_PROXY = '';
const ASSET_HANDLER_PROXY = '';
const TIMELOCK = '';

async function main() {
  if (!GOVERNANCE_PROXY || !ASSET_HANDLER_PROXY || !TIMELOCK) {
    throw new Error('Fill in GOVERNANCE_PROXY, ASSET_HANDLER_PROXY, and TIMELOCK before running');
  }

  const [signer] = await ethers.getSigners();
  console.log('Signer:', signer.address);
  console.log('Timelock target:', TIMELOCK);

  const governance = await ethers.getContractAt('Governance', GOVERNANCE_PROXY, signer);
  const assetHandler = await ethers.getContractAt('AssetHandler', ASSET_HANDLER_PROXY, signer);

  const governanceOwnerBefore = await governance.owner();
  const assetHandlerOwnerBefore = await assetHandler.owner();
  console.log('\nGovernance owner (before):', governanceOwnerBefore);
  console.log('AssetHandler owner (before):', assetHandlerOwnerBefore);

  console.log('\nTransferring Governance ownership to Timelock...');
  await (await governance.transferOwnership(TIMELOCK)).wait();
  console.log('Governance owner (after):', await governance.owner());

  console.log('\nTransferring AssetHandler ownership to Timelock...');
  await (await assetHandler.transferOwnership(TIMELOCK)).wait();
  console.log('AssetHandler owner (after):', await assetHandler.owner());

  console.log('\nDone. Future changes to contract guards, asset guards, and supported');
  console.log('asset price feeds now require a Timelock proposal + delay to take effect.');
}

main().catch((error) => {
  console.error('Script failed:', error);
  process.exitCode = 1;
});
