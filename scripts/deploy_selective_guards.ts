import fs from 'fs';
import path from 'path';
import { ethers } from 'hardhat';
import { deployMorphoSelectiveGuard, deploySpokeSelectiveGuard } from './utils/selectiveGuards';

// --------------------------------------------------
// Deploys the position-selection guards (attested selective withdrawal) as replacements for
// the CertiK-validated Morpho Blue and Aave V4 Spoke asset guards, then WRITES the governance
// transactions that would switch each asset type over. It never sends a governance
// transaction: Governance.setAssetGuard is global per asset type, affects every pool, and
// invalidates every plan signed against the previous guard address — that is a reviewed,
// owner-signed step, not something a deploy script performs.
//
// The validated guard contracts are not modified. Each new guard inherits its validated
// counterpart and only ADDS a subset-withdraw entry point.
//
// Everything that must match the guard being replaced is read from it, not re-typed:
//   - constructor arguments  <- the old guard's public immutables
//   - Morpho owner config    <- the old guard's events for key discovery, live state for values
//   - ownership              <- handed to the old guard's owner after verification
//
// Environment:
//   OLD_MORPHO_GUARD          address of the currently registered Morpho Blue asset guard
//   MORPHO_COLLECT_LIB        address of the deployed MorphoCollectLib (unchanged, reused)
//   MORPHO_ASSET_TYPE         Governance asset type registered to the Morpho guard
//   OLD_MORPHO_FROM_BLOCK     first block to scan for the old guard's config events (default 0;
//                             set to the guard's deployment block on a public RPC)
//   OLD_SPOKE_GUARD           address of the currently registered Aave V4 Spoke asset guard
//   SPOKE_ASSET_TYPE          Governance asset type registered to the Spoke guard
//   GOVERNANCE                Governance proxy (to encode setAssetGuard against)
//   Set either OLD_* to deploy only that guard.
//   SEND=1                    actually deploy. Without it the script only prints what it would do.
//
// After deploying: the Morpho guard is compiled with the same viaIR settings override as its
// base. Attester tooling must sign the NEW guard address once the governance swap lands.
// --------------------------------------------------

async function main() {
  const oldMorpho = process.env.OLD_MORPHO_GUARD;
  const oldSpoke = process.env.OLD_SPOKE_GUARD;
  if (!oldMorpho && !oldSpoke) {
    throw new Error('Set OLD_MORPHO_GUARD and/or OLD_SPOKE_GUARD.');
  }
  const governanceAddress = process.env.GOVERNANCE;
  if (!governanceAddress) throw new Error('Set GOVERNANCE (the Governance proxy address).');

  if (oldMorpho) {
    for (const k of ['MORPHO_COLLECT_LIB', 'MORPHO_ASSET_TYPE']) {
      if (!process.env[k]) throw new Error(`Set ${k} to deploy the Morpho guard.`);
    }
  }
  if (oldSpoke && !process.env.SPOKE_ASSET_TYPE) {
    throw new Error('Set SPOKE_ASSET_TYPE to deploy the Spoke guard.');
  }

  const [signer] = await ethers.getSigners();
  console.log('Deployer:', signer.address);
  if (process.env.SEND !== '1') {
    console.log(
      '\nDRY RUN (SEND=1 not set). Would deploy:',
      [
        oldMorpho && 'MorphoBlueLendingPoolSelectiveAssetGuard',
        oldSpoke && 'AaveV4SpokeSelectiveAssetGuard',
      ]
        .filter(Boolean)
        .join(', '),
    );
    if (oldMorpho) {
      const { readMorphoGuardConfig } = await import('./utils/selectiveGuards');
      const cfg = await readMorphoGuardConfig(
        oldMorpho,
        Number(process.env.OLD_MORPHO_FROM_BLOCK ?? 0),
      );
      console.log('Morpho config that would be replayed from the old guard:');
      console.log(JSON.stringify(cfg, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    }
    return;
  }

  const governance = await ethers.getContractAt('Governance', governanceAddress);
  const transactions: { description: string; to: string; value: string; data: string }[] = [];

  if (oldMorpho) {
    const { address } = await deployMorphoSelectiveGuard({
      signer,
      oldGuardAddress: oldMorpho,
      collectLibAddress: process.env.MORPHO_COLLECT_LIB!,
      fromBlock: Number(process.env.OLD_MORPHO_FROM_BLOCK ?? 0),
    });
    transactions.push({
      description: `Governance.setAssetGuard(${process.env.MORPHO_ASSET_TYPE}, ${address}) — Morpho Blue selective guard`,
      to: governanceAddress,
      value: '0',
      data: governance.interface.encodeFunctionData('setAssetGuard', [
        BigInt(process.env.MORPHO_ASSET_TYPE!),
        address,
      ]),
    });
  }
  if (oldSpoke) {
    const { address } = await deploySpokeSelectiveGuard({ signer, oldGuardAddress: oldSpoke });
    transactions.push({
      description: `Governance.setAssetGuard(${process.env.SPOKE_ASSET_TYPE}, ${address}) — Aave V4 Spoke selective guard`,
      to: governanceAddress,
      value: '0',
      data: governance.interface.encodeFunctionData('setAssetGuard', [
        BigInt(process.env.SPOKE_ASSET_TYPE!),
        address,
      ]),
    });
  }

  const chainId = (await ethers.provider.getNetwork()).chainId.toString();
  const dir = path.join(process.cwd(), 'deployments');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `selective-guards-governance-${chainId}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        note:
          'Not sent by this script. setAssetGuard is global per asset type: it affects every pool ' +
          'using that asset type and invalidates any attested plan signed against the previous ' +
          'guard address. Review, then sign from the governance owner.',
        transactions,
      },
      null,
      2,
    ),
  );
  console.log('\nWrote governance transaction list (NOT sent):', file);
}

main().catch((error) => {
  console.error('Script failed:', error);
  process.exitCode = 1;
});
