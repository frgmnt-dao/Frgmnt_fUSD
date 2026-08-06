import fs from 'fs';
import path from 'path';
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
// SECURITY MODEL — two phases, deliberately separated (same pattern as
// remediate_NftTrackerStorage.ts):
//
//   Phase 1 (this script, permissionless): deploys a replacement SlippageAccumulator
//   (unlike NftTrackerStorage, it has no upgrade path — poolFactory is immutable, set
//   once in the constructor — so a full redeploy is unavoidable) plus a replacement
//   UniswapV3RouterGuard pointing at it, reusing the live decayTime/maxCumulativeSlippage
//   read on-chain rather than hardcoded. Neither deploy needs any special privilege.
//
//   Phase 2 (owner-gated: Governance.setContractGuard()) is NOT sent directly.
//   GOVERNANCE_SAFE is a Gnosis Safe multisig (per Timelock.sol's deployment comment), so
//   by default this script only *builds* a Gnosis Safe Transaction Builder-compatible
//   JSON batch (written to deployments/slippage-remediation-<chainId>.json) with that one
//   call, to be reviewed and proposed through the Safe UI. Set SEND=1 to instead sign and
//   broadcast directly with the local signer (fork/testnet use only).
//
// No data-migration risk: onlyContractGuard() gates updateSlippageImpact(), the only
// state-changing function, and has been permanently reverting since deploy — managerData
// is guaranteed to hold no accumulated slippage for any pool manager. The old, broken
// SlippageAccumulator/UniswapV3RouterGuard instances are simply orphaned once this runs;
// both are stateless/immutable, so no cleanup call exists or is needed.
// --------------------------------------------------

const POOL_MANAGER_LOGIC = '0x9530E699E519D7BCF621BA7CA17e119B6865b5C7';
const GOVERNANCE = '0xC393A896D15641cA970F682BE62e89347941985d';
const GOVERNANCE_SAFE = '0xafb9B883637f72767ADf7193Bb3B8e59C02Ea05d';
const UNISWAP_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';
const OLD_SLIPPAGE_ACCUMULATOR = '0xcf8aCb91851D6651649598aaE175b61ab20c70cB';
const OLD_UNISWAP_V3_ROUTER_GUARD = '0xcAE75F063Ef5b432F4ad3140960c888a0795d5dc';

async function main() {
  const [signer] = await ethers.getSigners();
  console.log('Signer (gas payer, deploy only — not necessarily GOVERNANCE_SAFE):', signer.address);

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

  // -----------------------------------------------------------------------
  // Phase 1: permissionless deploys.
  // -----------------------------------------------------------------------
  console.log('\nDeploying new SlippageAccumulator with the correct PoolManagerLogic address...');
  const SlippageAccumulator = await ethers.getContractFactory('SlippageAccumulator', signer);
  const newSlippage = await SlippageAccumulator.deploy(
    POOL_MANAGER_LOGIC,
    decayTime,
    maxCumulativeSlippage,
  );
  await newSlippage.waitForDeployment();
  const newSlippageAddress = await newSlippage.getAddress();
  console.log('New SlippageAccumulator deployed at:', newSlippageAddress);

  console.log('\nConfirming the new SlippageAccumulator resolves prices correctly...');
  const value = await newSlippage.assetValue(usdc, 1_000_000n);
  console.log('  assetValue(USDC, 1 USDC) =', ethers.formatUnits(value, 18), 'USD (no revert)');

  console.log('\nDeploying new UniswapV3RouterGuard pointing at the new SlippageAccumulator...');
  const UniswapV3RouterGuard = await ethers.getContractFactory('UniswapV3RouterGuard', signer);
  const newGuard = await UniswapV3RouterGuard.deploy(newSlippageAddress);
  await newGuard.waitForDeployment();
  const newGuardAddress = await newGuard.getAddress();
  console.log('New UniswapV3RouterGuard deployed at:', newGuardAddress);

  // -----------------------------------------------------------------------
  // Phase 2: owner-gated call — build a Safe Transaction Builder batch by default.
  // -----------------------------------------------------------------------
  const governance = await ethers.getContractAt('Governance', GOVERNANCE, signer);
  const setContractGuardCalldata = governance.interface.encodeFunctionData('setContractGuard', [
    UNISWAP_ROUTER,
    newGuardAddress,
  ]);

  if (process.env.SEND === '1') {
    console.log('\nSEND=1 set — signing and broadcasting directly with the local signer.');
    await (await governance.setContractGuard(UNISWAP_ROUTER, newGuardAddress)).wait();
    const registered = await governance.contractGuards(UNISWAP_ROUTER);
    console.log('Governance.contractGuards(UNISWAP_ROUTER) now:', registered);
    if (registered.toLowerCase() !== newGuardAddress.toLowerCase()) {
      throw new Error('Registration did not update as expected — investigate before relying on this fix.');
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
      name: 'SlippageAccumulator / UniswapV3RouterGuard remediation',
      description:
        `Registers the new UniswapV3RouterGuard (${newGuardAddress}, built on the ` +
        `redeployed SlippageAccumulator ${newSlippageAddress} with the corrected ` +
        'PoolManagerLogic address) in place of the broken one. Propose via the ' +
        'GOVERNANCE_SAFE multisig, do not execute with a single key.',
      txBuilderVersion: '1.16.5',
    },
    transactions: [{ to: GOVERNANCE, value: '0', data: setContractGuardCalldata }],
  };

  const dir = path.join(process.cwd(), 'deployments');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `slippage-remediation-${chainId}.json`);
  fs.writeFileSync(file, JSON.stringify(batch, null, 2));

  console.log('\nNo governance transaction sent (default, safest mode). Wrote a Gnosis Safe');
  console.log('Transaction Builder batch to:', file);
  console.log('Import it at https://app.safe.global under GOVERNANCE_SAFE ' + GOVERNANCE_SAFE);
  console.log('and propose it for the multisig to review and sign. Set SEND=1 to instead');
  console.log('broadcast directly with the local signer (fork/testnet use only).');
  console.log('\nOld, broken instances are orphaned and can be left as-is (both stateless, no');
  console.log('cleanup call exists or is needed):');
  console.log('  old SlippageAccumulator :', OLD_SLIPPAGE_ACCUMULATOR);
  console.log('  old UniswapV3RouterGuard:', OLD_UNISWAP_V3_ROUTER_GUARD);
}

main().catch((error) => {
  console.error('Script failed:', error);
  process.exitCode = 1;
});
