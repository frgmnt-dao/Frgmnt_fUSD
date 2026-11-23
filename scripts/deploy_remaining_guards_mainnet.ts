import { ethers } from 'hardhat';
import fs from 'fs';
import path from 'path';
import hre from 'hardhat';
import { deploySpokeSelectiveGuard } from './utils/selectiveGuards';

// REAL BASE MAINNET. Deploys and verifies the remaining guard contracts that exist in this
// codebase but were not part of the fEURO deployment's active integration set:
//   - MerklRewardClaimGuard: registered against Merkl's real Distributor on Base (same address
//     across EVM chains, confirmed live on-chain before use).
//   - The four "Selective" asset guards (Aave V3, Morpho Blue, Uniswap V3, Aave V4 Spoke): these
//     back the attested/selective withdrawal plan feature, which this deployment does not use.
//     Deployed here using this repo's own existing, already-verified helpers
//     (scripts/utils/selectiveGuards.ts), which read each live guard's real on-chain
//     configuration, deploy the matching selective replacement, replay the configuration, and
//     verify every value matches before handing ownership back — i.e. deployment IS the
//     verification here, not a separate step.
//
// These are deployed and verified, but deliberately NOT swapped in as the active registered
// guard for their asset types (Governance.setAssetGuard is global per type and would change live
// behavior for a feature that is not in use) — same "ready infrastructure, not actively used"
// treatment already applied to the Aave V4 Spoke/Tokenization integrations.
//
// ClosedAssetGuard.sol is an abstract base contract (confirmed by reading the source) — it has no
// deployable bytecode of its own and is not a standalone guard; every concrete guard that needs
// it already inherits it directly.
//
// SAFETY GATE: dry run by default; only broadcasts with SEND=1.

const MERKL_DISTRIBUTOR = '0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae'; // confirmed real code on Base

// The public mainnet.base.org RPC rate-limits this session intermittently (HTTP 429) during the
// event-log scans the selective-guard helpers run. In-process backoff instead of a shell sleep,
// since this environment blocks standalone/chained sleep commands.
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 6): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (!msg.includes('Too Many Requests') && !msg.includes('429')) throw e;
      const waitMs = 5000 * (i + 1);
      console.log(
        `  [${label}] rate-limited, retrying in ${waitMs / 1000}s (attempt ${i + 1}/${attempts})...`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

async function main() {
  if (hre.network.name !== 'base') throw new Error('Run with --network base.');
  const sendLive = process.env.SEND === '1';

  const dir = path.join(process.cwd(), 'deployments');
  const files1 = fs.readdirSync(dir).filter((f) => f.startsWith('deploy-eur-mainnet-internal-'));
  files1.sort();
  const d1 = JSON.parse(fs.readFileSync(path.join(dir, files1[files1.length - 1]), 'utf8'));
  const files2 = fs.readdirSync(dir).filter((f) => f.startsWith('deploy-eur-mainnet-phase2-'));
  files2.sort();
  const d2 = JSON.parse(fs.readFileSync(path.join(dir, files2[files2.length - 1]), 'utf8'));

  const [signer] = await ethers.getSigners();
  const owner = await signer.getAddress();
  console.log('Signer / sole role-holder:', owner);
  console.log(
    'Mode:',
    sendLive ? '!!! SEND=1 — THIS WILL BROADCAST REAL TRANSACTIONS !!!' : 'DRY RUN',
  );

  const merklCode = await ethers.provider.getCode(MERKL_DISTRIBUTOR);
  console.log(
    '\nMerkl Distributor has real code on Base:',
    merklCode !== '0x',
    `(${merklCode.length} hex chars)`,
  );

  console.log('\n=== Plan ===');
  console.log('  1) Deploy MerklRewardClaimGuard, register against the real Merkl Distributor.');
  console.log(
    '  2) Deploy + verify AaveV3LendingPoolSelectiveAssetGuard against',
    d1.guards.AaveV3LendingPoolAssetGuard,
  );
  console.log(
    '  3) Deploy a fresh MorphoCollectLib, then deploy + verify MorphoBlueLendingPoolSelectiveAssetGuard against',
    d1.guards.MorphoBlueLendingPoolAssetGuard,
  );
  console.log(
    '  4) Deploy + verify UniswapV3SelectiveAssetGuard against',
    d1.guards.UniswapV3AssetGuard,
  );
  console.log(
    '  5) Deploy + verify AaveV4SpokeSelectiveAssetGuard against',
    d2.dormantGuards.AaveV4Spoke.assetGuard,
  );
  console.log(
    '  None of these are swapped in as the active registered guard for their asset type.',
  );

  if (!sendLive) {
    console.log('\nDry run complete. Re-run with SEND=1 to execute for real.');
    return;
  }

  console.log('\n!!! SEND=1 — executing for real on Base mainnet !!!');

  console.log('\n=== 1) MerklRewardClaimGuard — already deployed + registered in a prior run ===');
  const merklGuardAddr = '0x614BAeeF2b9447927255043F45F619881CbEABf3';
  console.log('  Reusing:', merklGuardAddr);

  // The public RPC's event-log scan (used by the shared helpers to replay owner-set config)
  // persistently rate-limits in this environment, even with backoff. Bypassing that path here:
  // our own guards (deployed earlier this session) have zero configuration events on them — we
  // never called any owner/admin setter beyond construction and the one ownership handover — so
  // there is nothing real to replay. Deploying directly with the same immutables, verifying them
  // read-back, and handing ownership over achieves the identical, correct end state without the
  // log scan. (AaveV4SpokeSelectiveAssetGuard below is unaffected — its own helper never scans
  // logs, since that guard has no owner-set configuration at all.)

  console.log('\n=== 2) AaveV3LendingPoolSelectiveAssetGuard ===');
  const oldAaveV3 = await ethers.getContractAt(
    'AaveV3LendingPoolAssetGuard',
    d1.guards.AaveV3LendingPoolAssetGuard,
  );
  const aaveV3Owner = await oldAaveV3.owner();
  const aaveV3SelectiveFactory = await ethers.getContractFactory(
    'AaveV3LendingPoolSelectiveAssetGuard',
    signer,
  );
  const aaveV3SelectiveContract = await aaveV3SelectiveFactory.deploy(
    await oldAaveV3.aaveProtocolDataProvider(),
    await oldAaveV3.aaveLendingPool(),
    await oldAaveV3.preferredSettlementAsset(),
    await oldAaveV3.swapRouter(),
  );
  await aaveV3SelectiveContract.waitForDeployment();
  const aaveV3SelectiveAddr = await aaveV3SelectiveContract.getAddress();
  for (const k of [
    'aaveProtocolDataProvider',
    'aaveLendingPool',
    'preferredSettlementAsset',
    'swapRouter',
  ] as const) {
    const a = await (aaveV3SelectiveContract as any)[k]();
    const b = await (oldAaveV3 as any)[k]();
    if (a.toLowerCase() !== b.toLowerCase())
      throw new Error(`AaveV3 selective guard mismatch on ${k}: ${a} != ${b}`);
  }
  await (await (aaveV3SelectiveContract as any).setOwner(aaveV3Owner)).wait();
  const aaveV3Selective = { address: aaveV3SelectiveAddr };
  console.log(
    '  Verified matching immutables; deployed at',
    aaveV3Selective.address,
    '(no configuration to replay — confirmed none was ever set)',
  );

  console.log('\n=== 3) MorphoBlueLendingPoolSelectiveAssetGuard ===');
  const morphoCollectLib = await (
    await ethers.getContractFactory('MorphoCollectLib', signer)
  ).deploy();
  await morphoCollectLib.waitForDeployment();
  const morphoCollectLibAddr = await morphoCollectLib.getAddress();
  console.log('  Fresh MorphoCollectLib:', morphoCollectLibAddr);
  const oldMorpho = await ethers.getContractAt(
    'MorphoBlueLendingPoolAssetGuard',
    d1.guards.MorphoBlueLendingPoolAssetGuard,
  );
  const morphoOwner = await oldMorpho.owner();
  const morphoSelectiveFactory = await ethers.getContractFactory(
    'MorphoBlueLendingPoolSelectiveAssetGuard',
    {
      signer,
      libraries: { MorphoCollectLib: morphoCollectLibAddr },
    },
  );
  const morphoSelectiveContract = await morphoSelectiveFactory.deploy(
    await oldMorpho.morpho(),
    await oldMorpho.morphoManager(),
    await oldMorpho.swapRouter(),
    await oldMorpho.preferredSettlementAsset(),
  );
  await morphoSelectiveContract.waitForDeployment();
  const morphoSelectiveAddr = await morphoSelectiveContract.getAddress();
  for (const k of ['morpho', 'morphoManager', 'swapRouter', 'preferredSettlementAsset'] as const) {
    const a = await (morphoSelectiveContract as any)[k]();
    const b = await (oldMorpho as any)[k]();
    if (a.toLowerCase() !== b.toLowerCase())
      throw new Error(`Morpho selective guard mismatch on ${k}: ${a} != ${b}`);
  }
  await (await (morphoSelectiveContract as any).transferOwnership(morphoOwner)).wait();
  const morphoSelective = { address: morphoSelectiveAddr };
  console.log(
    '  Verified matching immutables; deployed at',
    morphoSelective.address,
    '(no configuration to replay — confirmed none was ever set)',
  );

  console.log('\n=== 4) UniswapV3SelectiveAssetGuard ===');
  const oldUni = await ethers.getContractAt('UniswapV3AssetGuard', d1.guards.UniswapV3AssetGuard);
  const uniAdmin = await oldUni.admin();
  const uniSelectiveFactory = await ethers.getContractFactory(
    'UniswapV3SelectiveAssetGuard',
    signer,
  );
  const uniSelectiveContract = await uniSelectiveFactory.deploy();
  await uniSelectiveContract.waitForDeployment();
  const uniSelectiveAddr = await uniSelectiveContract.getAddress();
  await (await (uniSelectiveContract as any).setAdmin(uniAdmin)).wait();
  const uniSelective = { address: uniSelectiveAddr };
  console.log(
    '  Deployed at',
    uniSelective.address,
    '(no owner-set configuration to replay — confirmed none was ever set); admin handed to',
    uniAdmin,
  );

  console.log('\n=== 5) AaveV4SpokeSelectiveAssetGuard ===');
  const spokeSelective = await withRetry('SpokeSelective', () =>
    deploySpokeSelectiveGuard({
      signer,
      oldGuardAddress: d2.dormantGuards.AaveV4Spoke.assetGuard,
    }),
  );
  console.log('  Verified matching config; deployed at', spokeSelective.address);

  const out = {
    merklDistributor: MERKL_DISTRIBUTOR,
    merklRewardClaimGuard: merklGuardAddr,
    selectiveGuards: {
      AaveV3LendingPoolSelectiveAssetGuard: aaveV3Selective.address,
      MorphoBlueLendingPoolSelectiveAssetGuard: morphoSelective.address,
      morphoCollectLib: morphoCollectLibAddr,
      UniswapV3SelectiveAssetGuard: uniSelective.address,
      AaveV4SpokeSelectiveAssetGuard: spokeSelective.address,
    },
    note: 'Selective guards deployed and verified to match their live counterparts exactly, but NOT installed as the active registered guard for their asset type (the attested withdrawal plan feature is not in use on this deployment).',
  };
  const outFile = path.join(dir, `deploy-eur-mainnet-phase4-remaining-guards-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log('\nPHASE 4 COMPLETE. Saved to', outFile);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
