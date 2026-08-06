import { ethers } from 'hardhat';

// --------------------------------------------------
// Remediates the live, auditor-flagged bug (CertiK) on Base mainnet (chainId 8453):
// deploy_contract_guard.ts passed PoolLogic's proxy address as POOL_FACTORY instead of
// PoolManagerLogic's. Confirmed on-chain 2026-08-06: calling
// SlippageAccumulator(0xcf8aCb91851D6651649598aaE175b61ab20c70cB).assetValue(USDC, 1e6)
// reverts with PoolLogic's own CallbackSenderNotAllowed() custom error (selector
// 0xc0c67e17) — proving its private immutable poolFactory resolves to PoolLogic
// (0x704c56974e0CA4BF8ff8fe8acc51FBF1E053878E), not PoolManagerLogic
// (0x9530E699E519D7BCF621BA7CA17e119B6865b5C7), which is the address that actually
// implements getContractGuard()/getAssetPrice().
//
// Unlike NftTrackerStorage, SlippageAccumulator is NOT upgradeable — poolFactory is set
// once in its constructor with no setter. This forces a full redeploy, which in turn
// forces redeploying its only consumer, UniswapV3RouterGuard
// (0xcAE75F063Ef5b432F4ad3140960c888a0795d5dc — confirmed on-chain to be currently
// registered in Governance for the Uniswap V3 Router, 0x2626664c2603336E57B271c5C0b26F421741e481),
// since that guard takes the SlippageAccumulator address as an immutable constructor
// argument too.
//
// Steps:
//   1) Deploy a new SlippageAccumulator with the correct PoolManagerLogic address,
//      reusing the exact decayTime/maxCumulativeSlippage the live (broken) instance was
//      configured with (read directly from it below — SlippageAccumulator has no
//      upgrade path, but decayTime/maxCumulativeSlippage ARE public and owner-settable
//      going forward via setDecayTime/setMaxCumulativeSlippage, so reading them live
//      rather than hardcoding preserves whatever governance may have already tuned).
//   2) Deploy a new UniswapV3RouterGuard pointing at the new SlippageAccumulator.
//   3) Call Governance.setContractGuard(UNISWAP_ROUTER, newGuard) to atomically swap the
//      registration — this single call is what activates the fix; the old (broken)
//      SlippageAccumulator/UniswapV3RouterGuard instances are simply orphaned afterward
//      (both stateless/immutable, no cleanup call needed or possible).
//
// No data-migration risk: onlyContractGuard() gates updateSlippageImpact(), the only
// state-changing function, and has been permanently reverting since deploy (same
// self-referential-guard-check failure mode as NftTrackerStorage) — managerData is
// guaranteed to hold no accumulated slippage for any pool manager.
//
// Precondition: Governance.owner() confirmed on-chain 2026-08-06 to still be
// GOVERNANCE_SAFE (0xafb9B883637f72767ADf7193Bb3B8e59C02Ea05d) directly — not yet
// Timelock-covered (see docs/security.md / scripts/transferRoles_Governance.ts), so this
// setContractGuard call can be sent directly. Re-confirm before running in case that has
// changed since.
// --------------------------------------------------

const POOL_MANAGER_LOGIC = '0x9530E699E519D7BCF621BA7CA17e119B6865b5C7';
const GOVERNANCE = '0xC393A896D15641cA970F682BE62e89347941985d';
const UNISWAP_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';
const OLD_SLIPPAGE_ACCUMULATOR = '0xcf8aCb91851D6651649598aaE175b61ab20c70cB';
const OLD_UNISWAP_V3_ROUTER_GUARD = '0xcAE75F063Ef5b432F4ad3140960c888a0795d5dc';
const WRONG_POOL_FACTORY_EXPECTED = '0x704c56974e0CA4BF8ff8fe8acc51FBF1E053878E'; // PoolLogic — sanity check only

async function main() {
  const [signer] = await ethers.getSigners();
  console.log('Signer:', signer.address);

  const oldSlippage = await ethers.getContractAt(
    'SlippageAccumulator',
    OLD_SLIPPAGE_ACCUMULATOR,
    signer,
  );

  // Sanity check we're targeting the known-broken instance before doing anything —
  // confirms the on-chain revert signature described above, not just trusting the address.
  const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  let confirmedBroken = false;
  try {
    await oldSlippage.assetValue.staticCall(usdc, 1_000_000n);
  } catch (e: any) {
    const data = e?.data ?? e?.error?.data ?? '';
    confirmedBroken = typeof data === 'string' && data.startsWith('0xc0c67e17');
  }
  if (!confirmedBroken) {
    throw new Error(
      'Old SlippageAccumulator did not fail with the expected CallbackSenderNotAllowed() ' +
        'signature — stop and re-verify before proceeding; this script assumes the ' +
        'specific, already-confirmed bug state.',
    );
  }
  console.log('Confirmed: old SlippageAccumulator reproduces the known bug.');

  const decayTime = await oldSlippage.decayTime();
  const maxCumulativeSlippage = await oldSlippage.maxCumulativeSlippage();
  console.log('\nReusing live config — decayTime:', decayTime.toString());
  console.log('Reusing live config — maxCumulativeSlippage:', maxCumulativeSlippage.toString());

  console.log('\nDeploying new SlippageAccumulator with the correct PoolManagerLogic address...');
  const SlippageAccumulator = await ethers.getContractFactory('SlippageAccumulator', signer);
  const newSlippage = await SlippageAccumulator.deploy(
    POOL_MANAGER_LOGIC,
    decayTime,
    maxCumulativeSlippage,
  );
  await newSlippage.waitForDeployment();
  console.log('New SlippageAccumulator deployed at:', newSlippage.target);

  console.log('\nDeploying new UniswapV3RouterGuard pointing at the new SlippageAccumulator...');
  const UniswapV3RouterGuard = await ethers.getContractFactory('UniswapV3RouterGuard', signer);
  const newGuard = await UniswapV3RouterGuard.deploy(newSlippage.target);
  await newGuard.waitForDeployment();
  console.log('New UniswapV3RouterGuard deployed at:', newGuard.target);

  console.log('\nRegistering the new guard in Governance...');
  const governance = await ethers.getContractAt('Governance', GOVERNANCE, signer);
  await (await governance.setContractGuard(UNISWAP_ROUTER, newGuard.target)).wait();

  const registered = await governance.contractGuards(UNISWAP_ROUTER);
  console.log('Governance.contractGuards(UNISWAP_ROUTER) now:', registered);
  if (registered.toLowerCase() !== (await newGuard.getAddress()).toLowerCase()) {
    throw new Error('Registration did not update as expected — investigate before relying on this fix.');
  }

  console.log('\nDone. Uniswap V3 swaps through this pool now route through the corrected guard.');
  console.log('Old, broken instances are orphaned and can be left as-is (both stateless, no');
  console.log('cleanup call exists or is needed):');
  console.log('  old SlippageAccumulator :', OLD_SLIPPAGE_ACCUMULATOR);
  console.log('  old UniswapV3RouterGuard:', OLD_UNISWAP_V3_ROUTER_GUARD);
}

main().catch((error) => {
  console.error('Script failed:', error);
  process.exitCode = 1;
});
