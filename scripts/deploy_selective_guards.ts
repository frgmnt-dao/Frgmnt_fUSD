import fs from 'fs';
import path from 'path';
import { ethers } from 'hardhat';
import {
  assertGovernanceGuard,
  assertMorphoCollectLib,
  assertMorphoManagerCompatible,
  deployAaveV3SelectiveGuard,
  deployMorphoSelectiveGuard,
  deploySpokeSelectiveGuard,
  deployUniswapSelectiveGuard,
  readAaveV3GuardConfig,
  readMorphoGuardConfig,
  readUniswapGuardConfig,
} from './utils/selectiveGuards';

// --------------------------------------------------
// Deploys the position-selection guards (attested selective withdrawal) as replacements for
// the CertiK-validated Morpho Blue, Aave V3, Aave V4 Spoke and Uniswap V3 asset guards, then WRITES the governance
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
//   MORPHO_COLLECT_LIB        address of a deployed MorphoCollectLib built from THIS repo's source
//                             (checked against the current build; it changed since the `audit` build)
//   MORPHO_ASSET_TYPE         Governance asset type registered to the Morpho guard
//   OLD_MORPHO_FROM_BLOCK     first block to scan for the old guard's config events (default 0;
//                             set to the guard's deployment block on a public RPC)
//   OLD_SPOKE_GUARD           address of the currently registered Aave V4 Spoke asset guard
//   OLD_AAVE_V3_GUARD         address of the currently registered Aave V3 asset guard
//   AAVE_V3_ASSET_TYPE        Governance asset type registered to the Aave V3 guard
//   OLD_AAVE_V3_FROM_BLOCK    first block to scan for the old Aave V3 guard's config events
//   OLD_UNISWAP_GUARD         address of the currently registered Uniswap V3 asset guard
//   UNISWAP_ASSET_TYPE        Governance asset type registered to the Uniswap V3 guard
//   OLD_UNISWAP_FROM_BLOCK    first block to scan for the old Uniswap guard's config events
//   SPOKE_ASSET_TYPE          Governance asset type registered to the Spoke guard
//   GOVERNANCE                Governance proxy (to encode setAssetGuard against)
//   Set any of the OLD_* variables to deploy only those guards.
//   SEND=1                    actually deploy. Without it the script only prints what it would do.
//
// After deploying: the Morpho guard is compiled with the same viaIR settings override as its
// base. Attester tooling must sign the NEW guard address once the governance swap lands.
// --------------------------------------------------

async function main() {
  const oldMorpho = process.env.OLD_MORPHO_GUARD;
  const oldSpoke = process.env.OLD_SPOKE_GUARD;
  const oldUniswap = process.env.OLD_UNISWAP_GUARD;
  const oldAaveV3 = process.env.OLD_AAVE_V3_GUARD;
  if (!oldMorpho && !oldSpoke && !oldUniswap && !oldAaveV3) {
    throw new Error(
      'Set OLD_MORPHO_GUARD, OLD_SPOKE_GUARD, OLD_UNISWAP_GUARD and/or OLD_AAVE_V3_GUARD.',
    );
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
  if (oldAaveV3 && !process.env.AAVE_V3_ASSET_TYPE) {
    throw new Error('Set AAVE_V3_ASSET_TYPE to deploy the Aave V3 guard.');
  }
  if (oldUniswap && !process.env.UNISWAP_ASSET_TYPE) {
    throw new Error('Set UNISWAP_ASSET_TYPE to deploy the Uniswap V3 guard.');
  }

  // Event-based key discovery starts at the *_FROM_BLOCK. A too-late block silently misses config
  // keys (the verify loop only checks discovered keys), so require it explicitly on real networks.
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const fromBlockFor = (name: string, enabled: boolean): number => {
    if (!enabled) return 0;
    const v = process.env[name];
    if (v === undefined) {
      if (chainId === 31337) return 0;
      throw new Error(`Set ${name} to the block the old guard was deployed at (or earlier).`);
    }
    return Number(v);
  };
  const morphoFrom = fromBlockFor('OLD_MORPHO_FROM_BLOCK', Boolean(oldMorpho));
  const aaveFrom = fromBlockFor('OLD_AAVE_V3_FROM_BLOCK', Boolean(oldAaveV3));
  const uniFrom = fromBlockFor('OLD_UNISWAP_FROM_BLOCK', Boolean(oldUniswap));

  // Read-only preflight. Governance.setAssetGuard is global per asset TYPE and every subclass
  // installs the FULL validated guard (all post-audit changes), not only position selection.
  if (oldMorpho) {
    await assertGovernanceGuard(
      governanceAddress,
      BigInt(process.env.MORPHO_ASSET_TYPE!),
      oldMorpho,
    );
    if (process.env.ALLOW_LIB_MISMATCH !== '1') {
      await assertMorphoCollectLib(process.env.MORPHO_COLLECT_LIB!);
    }
    await assertMorphoManagerCompatible(oldMorpho);
  }
  if (oldSpoke) {
    await assertGovernanceGuard(governanceAddress, BigInt(process.env.SPOKE_ASSET_TYPE!), oldSpoke);
  }
  if (oldAaveV3) {
    await assertGovernanceGuard(
      governanceAddress,
      BigInt(process.env.AAVE_V3_ASSET_TYPE!),
      oldAaveV3,
    );
  }
  if (oldUniswap) {
    await assertGovernanceGuard(
      governanceAddress,
      BigInt(process.env.UNISWAP_ASSET_TYPE!),
      oldUniswap,
    );
  }

  const [signer] = await ethers.getSigners();
  console.log('Deployer:', signer.address);
  if (process.env.SEND !== '1') {
    console.log(
      '\nDRY RUN (SEND=1 not set). Would deploy:',
      [
        oldMorpho && 'MorphoBlueLendingPoolSelectiveAssetGuard',
        oldSpoke && 'AaveV4SpokeSelectiveAssetGuard',
        oldUniswap && 'UniswapV3SelectiveAssetGuard',
        oldAaveV3 && 'AaveV3LendingPoolSelectiveAssetGuard',
      ]
        .filter(Boolean)
        .join(', '),
    );
    const show = (label: string, cfg: unknown) => {
      console.log(`${label} config that would be replayed from the old guard:`);
      console.log(JSON.stringify(cfg, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    };
    if (oldMorpho) show('Morpho', await readMorphoGuardConfig(oldMorpho, morphoFrom));
    if (oldAaveV3) show('Aave V3', await readAaveV3GuardConfig(oldAaveV3, aaveFrom));
    if (oldUniswap) show('Uniswap V3', await readUniswapGuardConfig(oldUniswap, uniFrom));
    return;
  }

  const governance = await ethers.getContractAt('Governance', governanceAddress);
  const transactions: { description: string; to: string; value: string; data: string }[] = [];

  if (oldMorpho) {
    const { address } = await deployMorphoSelectiveGuard({
      signer,
      oldGuardAddress: oldMorpho,
      collectLibAddress: process.env.MORPHO_COLLECT_LIB!,
      fromBlock: morphoFrom,
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
  if (oldAaveV3) {
    const { address } = await deployAaveV3SelectiveGuard({
      signer,
      oldGuardAddress: oldAaveV3,
      fromBlock: aaveFrom,
    });
    transactions.push({
      description: `Governance.setAssetGuard(${process.env.AAVE_V3_ASSET_TYPE}, ${address}) — Aave V3 selective guard`,
      to: governanceAddress,
      value: '0',
      data: governance.interface.encodeFunctionData('setAssetGuard', [
        BigInt(process.env.AAVE_V3_ASSET_TYPE!),
        address,
      ]),
    });
  }
  if (oldUniswap) {
    const { address } = await deployUniswapSelectiveGuard({
      signer,
      oldGuardAddress: oldUniswap,
      fromBlock: uniFrom,
    });
    transactions.push({
      description: `Governance.setAssetGuard(${process.env.UNISWAP_ASSET_TYPE}, ${address}) — Uniswap V3 selective guard`,
      to: governanceAddress,
      value: '0',
      data: governance.interface.encodeFunctionData('setAssetGuard', [
        BigInt(process.env.UNISWAP_ASSET_TYPE!),
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
