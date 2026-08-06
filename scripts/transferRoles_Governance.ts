import { ethers } from 'hardhat';

// --------------------------------------------------
// FNA-01: locks every core-contract admin/owner role down to the already-deployed
// Timelock — Governance, AssetHandler, PoolManagerLogic.factoryOwner, PoolLogic.owner,
// and TokenLogic.DEFAULT_ADMIN_ROLE.
//
// Run this LAST, after the deployment/bootstrap sequence is fully done — i.e. after
// deploy_core_contracts.ts, deploy_asset_guards.ts, deploy_contract_guard.ts,
// set_Asset_Guard.ts, set_Contract_Guard.ts, add_assets.ts / add_supported_asset.ts, and
// setup_Token_Logic.ts have all been run with GOVERNANCE_SAFE (or the deployer key) as
// the direct, synchronous signer. Those scripts require Governance/AssetHandler/TokenLogic
// to still be owned/administered by a plain EOA or multisig; running this beforehand
// would strand the protocol, since every subsequent setAssetGuard/setContractGuard/
// addAsset/setAssetCap call would then need to go through TimelockController's two-step
// schedule()+execute() flow with the full minDelay instead of a normal transaction.
//
// factoryOwner is included deliberately, not just Governance/AssetHandler: it is a
// *separate* role (PoolManagerLogic.setGovernance/setAssetHandler) that can swap either
// reference out wholesale for a fresh, attacker-controlled instance with no timelock at
// all. Locking only Governance/AssetHandler while leaving factoryOwner on a fast EOA/
// multisig would make the Timelock protection above bypassable, not just weaker.
//
// PoolLogic.owner only gates the one-time initializeAutoCompounding() migration — no
// bootstrap script calls it, so there's no ordering hazard including it here.
//
// TokenLogic.DEFAULT_ADMIN_ROLE is AccessControl-based, not Ownable, so it's a two-step
// grant-then-revoke rather than a single transferOwnership call. Grant the Timelock the
// role FIRST, then revoke it from CURRENT_ADMIN — never the other way around, since
// revoking first (if the grant then failed for any reason) would leave DEFAULT_ADMIN_ROLE
// unassigned and TokenLogic permanently unadministerable (no upgrade path, no role
// recovery — AccessControl has no owner-of-last-resort).
//
// Once run, all further changes to contract guards, asset guards, supported asset price
// feeds, the governance/assetHandler references themselves, TokenLogic admin operations
// (upgrades, cooldown, deposit caps, asset config, role grants), and PoolLogic's
// initializeAutoCompounding() require a proposal through the Timelock (Timelock.sol's
// documented intent), giving on-chain visibility and a delay window before any such
// change takes effect.
// --------------------------------------------------

const GOVERNANCE_PROXY = '';
const ASSET_HANDLER_PROXY = '';
const POOL_MANAGER_LOGIC_PROXY = '';
const POOL_LOGIC_PROXY = '';
const TOKEN_LOGIC_PROXY = '';
const CURRENT_ADMIN = ''; // GOVERNANCE_SAFE — the address TokenLogic.DEFAULT_ADMIN_ROLE is revoked from
const TIMELOCK = '';

async function main() {
  if (
    !GOVERNANCE_PROXY ||
    !ASSET_HANDLER_PROXY ||
    !POOL_MANAGER_LOGIC_PROXY ||
    !POOL_LOGIC_PROXY ||
    !TOKEN_LOGIC_PROXY ||
    !CURRENT_ADMIN ||
    !TIMELOCK
  ) {
    throw new Error(
      'Fill in GOVERNANCE_PROXY, ASSET_HANDLER_PROXY, POOL_MANAGER_LOGIC_PROXY, ' +
        'POOL_LOGIC_PROXY, TOKEN_LOGIC_PROXY, CURRENT_ADMIN, and TIMELOCK before running',
    );
  }

  const [signer] = await ethers.getSigners();
  console.log('Signer:', signer.address);
  console.log('Timelock target:', TIMELOCK);

  const governance = await ethers.getContractAt('Governance', GOVERNANCE_PROXY, signer);
  const assetHandler = await ethers.getContractAt('AssetHandler', ASSET_HANDLER_PROXY, signer);
  const poolManagerLogic = await ethers.getContractAt(
    'PoolManagerLogic',
    POOL_MANAGER_LOGIC_PROXY,
    signer,
  );
  const poolLogic = await ethers.getContractAt('PoolLogic', POOL_LOGIC_PROXY, signer);
  const tokenLogic = await ethers.getContractAt('TokenLogic', TOKEN_LOGIC_PROXY, signer);
  const DEFAULT_ADMIN_ROLE = await tokenLogic.DEFAULT_ADMIN_ROLE();

  console.log('\nGovernance owner (before):', await governance.owner());
  console.log('AssetHandler owner (before):', await assetHandler.owner());
  console.log('PoolManagerLogic factoryOwner (before):', await poolManagerLogic.owner());
  console.log('PoolLogic owner (before):', await poolLogic.owner());
  console.log(
    'TokenLogic DEFAULT_ADMIN_ROLE held by CURRENT_ADMIN (before):',
    await tokenLogic.hasRole(DEFAULT_ADMIN_ROLE, CURRENT_ADMIN),
  );

  console.log('\nTransferring Governance ownership to Timelock...');
  await (await governance.transferOwnership(TIMELOCK)).wait();
  console.log('Governance owner (after):', await governance.owner());

  console.log('\nTransferring AssetHandler ownership to Timelock...');
  await (await assetHandler.transferOwnership(TIMELOCK)).wait();
  console.log('AssetHandler owner (after):', await assetHandler.owner());

  console.log('\nTransferring PoolManagerLogic.factoryOwner to Timelock...');
  await (await poolManagerLogic.setFactoryOwner(TIMELOCK)).wait();
  console.log('PoolManagerLogic factoryOwner (after):', await poolManagerLogic.owner());

  console.log('\nTransferring PoolLogic ownership to Timelock...');
  await (await poolLogic.transferOwnership(TIMELOCK)).wait();
  console.log('PoolLogic owner (after):', await poolLogic.owner());

  console.log('\nGranting TokenLogic DEFAULT_ADMIN_ROLE to Timelock...');
  await (await tokenLogic.grantRole(DEFAULT_ADMIN_ROLE, TIMELOCK)).wait();
  console.log(
    'TokenLogic DEFAULT_ADMIN_ROLE held by Timelock:',
    await tokenLogic.hasRole(DEFAULT_ADMIN_ROLE, TIMELOCK),
  );

  console.log('\nRevoking TokenLogic DEFAULT_ADMIN_ROLE from CURRENT_ADMIN...');
  await (await tokenLogic.revokeRole(DEFAULT_ADMIN_ROLE, CURRENT_ADMIN)).wait();
  console.log(
    'TokenLogic DEFAULT_ADMIN_ROLE held by CURRENT_ADMIN (after):',
    await tokenLogic.hasRole(DEFAULT_ADMIN_ROLE, CURRENT_ADMIN),
  );

  console.log('\nDone. Every core-contract admin/owner role is now the Timelock. Future');
  console.log('changes to contract guards, asset guards, supported asset price feeds, the');
  console.log('governance/assetHandler references, TokenLogic admin operations, and');
  console.log('PoolLogic.initializeAutoCompounding() all require a Timelock proposal + delay.');
}

main().catch((error) => {
  console.error('Script failed:', error);
  process.exitCode = 1;
});
