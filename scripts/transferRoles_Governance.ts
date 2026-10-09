import { ethers } from 'hardhat';
import { assertProxyAdminOwner, getProxyAdminOwner } from './utils/ownership';

// --------------------------------------------------
// FNA-01: locks every core-contract admin/owner role down to the already-deployed
// Timelock — Governance, AssetHandler, PoolManagerLogic.factoryOwner, PoolLogic.owner,
// and TokenLogic.DEFAULT_ADMIN_ROLE.
//
// SoftStack M-01: also locks the three Transparent proxies' ProxyAdmin contracts down to
// the Timelock. ProxyAdmin ownership is a role distinct from the four Ownable/AccessControl
// roles above — it is the one that actually authorizes replacing a proxy's implementation —
// and this inventory previously omitted it, leaving it on whatever deployProxy's initialOwner
// resolved to for each proxy (GOVERNANCE_SAFE as of the deploy_core_contracts.ts fix for
// M-01, the deployer by default before it; the live PoolLogic ProxyAdmin was separately moved
// to the DAO Safe by the pre-existing, one-off scripts/transferRoles_poolLogic.ts, which this
// script's ProxyAdmin transfers now generalize to all three and route through the Timelock
// instead). TokenLogic is UUPS and has no ProxyAdmin, so only three are handled here.
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

  // SoftStack M-01: the three Transparent proxies' ProxyAdmin contracts, resolved from the
  // proxies' own EIP-1967 admin storage slot rather than taken on faith as an input — a
  // ProxyAdmin address pulled from a stale deployment record is exactly the kind of mistake
  // this script exists to prevent repeating. getProxyAdminOwner() is the same helper used by
  // deploy_core_contracts.ts's own ProxyAdmin assertion, so both places resolve/read it
  // identically instead of maintaining two copies of the erc1967-slot-then-owner() lookup.
  const assetHandlerAdminBefore = await getProxyAdminOwner(ASSET_HANDLER_PROXY, signer);
  const poolManagerAdminBefore = await getProxyAdminOwner(POOL_MANAGER_LOGIC_PROXY, signer);
  const poolLogicAdminBefore = await getProxyAdminOwner(POOL_LOGIC_PROXY, signer);
  const assetHandlerAdmin = await ethers.getContractAt(
    'ProxyAdmin',
    assetHandlerAdminBefore.proxyAdmin,
    signer,
  );
  const poolManagerAdmin = await ethers.getContractAt(
    'ProxyAdmin',
    poolManagerAdminBefore.proxyAdmin,
    signer,
  );
  const poolLogicAdmin = await ethers.getContractAt(
    'ProxyAdmin',
    poolLogicAdminBefore.proxyAdmin,
    signer,
  );

  console.log('\nGovernance owner (before):', await governance.owner());
  console.log('AssetHandler owner (before):', await assetHandler.owner());
  console.log('PoolManagerLogic factoryOwner (before):', await poolManagerLogic.owner());
  console.log('PoolLogic owner (before):', await poolLogic.owner());
  console.log(
    'TokenLogic DEFAULT_ADMIN_ROLE held by CURRENT_ADMIN (before):',
    await tokenLogic.hasRole(DEFAULT_ADMIN_ROLE, CURRENT_ADMIN),
  );
  console.log(
    `AssetHandler ProxyAdmin (${assetHandlerAdminBefore.proxyAdmin}) owner (before):`,
    assetHandlerAdminBefore.owner,
  );
  console.log(
    `PoolManagerLogic ProxyAdmin (${poolManagerAdminBefore.proxyAdmin}) owner (before):`,
    poolManagerAdminBefore.owner,
  );
  console.log(
    `PoolLogic ProxyAdmin (${poolLogicAdminBefore.proxyAdmin}) owner (before):`,
    poolLogicAdminBefore.owner,
  );

  // SoftStack M-01 preflight: on any deployment made before the deploy_core_contracts.ts fix
  // for this finding, these three ProxyAdmins were never handed to GOVERNANCE_SAFE — they
  // default to whichever EOA originally ran deployProxy, which is NOT this script's signer.
  // Checked here, before any transaction below, so a mismatch aborts with nothing sent, rather
  // than reverting partway through after Governance/AssetHandler.owner/factoryOwner/PoolLogic.owner
  // have already been moved to the Timelock — a partially-migrated state that would otherwise
  // require manual on-chain inspection to safely resume. If this fires, the ProxyAdmin's actual
  // current owner (an EOA, or the pre-M-01 DAO Safe for PoolLogic specifically) must transfer it
  // to GOVERNANCE_SAFE — or directly to TIMELOCK — itself before re-running this script. Reuses
  // assertProxyAdminOwner (same helper the final-verification block below uses) with the
  // signer's own address as the expected owner, rather than hand-rolling the same comparison.
  await assertProxyAdminOwner('AssetHandler', ASSET_HANDLER_PROXY, signer.address, signer);
  await assertProxyAdminOwner('PoolManagerLogic', POOL_MANAGER_LOGIC_PROXY, signer.address, signer);
  await assertProxyAdminOwner('PoolLogic', POOL_LOGIC_PROXY, signer.address, signer);

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

  console.log('\nTransferring AssetHandler ProxyAdmin ownership to Timelock...');
  await (await assetHandlerAdmin.transferOwnership(TIMELOCK)).wait();
  console.log('AssetHandler ProxyAdmin owner (after):', await assetHandlerAdmin.owner());

  console.log('\nTransferring PoolManagerLogic ProxyAdmin ownership to Timelock...');
  await (await poolManagerAdmin.transferOwnership(TIMELOCK)).wait();
  console.log('PoolManagerLogic ProxyAdmin owner (after):', await poolManagerAdmin.owner());

  console.log('\nTransferring PoolLogic ProxyAdmin ownership to Timelock...');
  await (await poolLogicAdmin.transferOwnership(TIMELOCK)).wait();
  console.log('PoolLogic ProxyAdmin owner (after):', await poolLogicAdmin.owner());

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

  // Final verification, not just trust in the calls above having succeeded: re-read every
  // role from the chain and refuse to call this script's work done if any disagrees. A
  // transaction that reverted silently mid-script (or succeeded against the wrong contract
  // instance) should not be able to produce a false "Done".
  const finalChecks: Array<[string, () => Promise<string>, string]> = [
    ['Governance.owner', () => governance.owner(), TIMELOCK],
    ['AssetHandler.owner', () => assetHandler.owner(), TIMELOCK],
    ['PoolManagerLogic.factoryOwner', () => poolManagerLogic.owner(), TIMELOCK],
    ['PoolLogic.owner', () => poolLogic.owner(), TIMELOCK],
  ];
  for (const [label, read, expected] of finalChecks) {
    const actual = await read();
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`${label} is ${actual}, expected the Timelock (${expected}) — stopping.`);
    }
  }
  // Same hard-stop semantics as the loop above, via the shared helper so a ProxyAdmin-owner
  // mismatch is checked identically here and in deploy_core_contracts.ts.
  await assertProxyAdminOwner('AssetHandler', ASSET_HANDLER_PROXY, TIMELOCK, signer);
  await assertProxyAdminOwner('PoolManagerLogic', POOL_MANAGER_LOGIC_PROXY, TIMELOCK, signer);
  await assertProxyAdminOwner('PoolLogic', POOL_LOGIC_PROXY, TIMELOCK, signer);
  if (!(await tokenLogic.hasRole(DEFAULT_ADMIN_ROLE, TIMELOCK))) {
    throw new Error('TokenLogic DEFAULT_ADMIN_ROLE is not held by the Timelock — stopping.');
  }
  if (await tokenLogic.hasRole(DEFAULT_ADMIN_ROLE, CURRENT_ADMIN)) {
    throw new Error('TokenLogic DEFAULT_ADMIN_ROLE is still held by CURRENT_ADMIN — stopping.');
  }

  console.log('\nDone. Every core-contract admin/owner role, and all three Transparent');
  console.log('proxies\' ProxyAdmin contracts, are now the Timelock (verified above). Future');
  console.log('changes to contract guards, asset guards, supported asset price feeds, the');
  console.log('governance/assetHandler references, TokenLogic admin operations,');
  console.log('PoolLogic.initializeAutoCompounding(), and any implementation upgrade of');
  console.log('AssetHandler, PoolManagerLogic or PoolLogic all require a Timelock proposal + delay.');
}

main().catch((error) => {
  console.error('Script failed:', error);
  process.exitCode = 1;
});
