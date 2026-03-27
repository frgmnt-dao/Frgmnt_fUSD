import { ethers } from 'hardhat';

// ============================================================
// CONFIG
// ============================================================

// AAVE
const AAVE_PROTOCOL_DATA_PROVIDER = '0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A';
const AAVE_LENDING_POOL = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';
const PREFERRED_SETTLEMENT_ASSET = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const SWAP_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';

// MORPHO
const MORPHO = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const MORPHO_MANAGER = '0xDBc42c0a8dFA6EE8b994e792dADE7Dc6Ba89ad9a';

// ============================================================
// HELPERS
// ============================================================

let nonce: number;

async function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deployWithRetry(factory: any, args: any[], txOpts: any, label: string, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`Deploying ${label}...`);

      const contract = await factory.deploy(...args, txOpts);
      await contract.waitForDeployment();

      const address = await contract.getAddress();
      console.log(`${label} deployed at:`, address);

      nonce++;
      return address;
    } catch (e: any) {
      console.warn(`${label} failed (attempt ${i + 1}):`, e.message || e);
      nonce++;
      await wait(1500);
    }
  }

  throw new Error(`${label} failed after ${retries} retries`);
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const signer = (await ethers.getSigners())[0];
  const provider = ethers.provider;

  const chain = await provider.getNetwork();

  console.log('Deployer :', await signer.getAddress());
  console.log('ChainId  :', chain.chainId.toString());

  // ============================================================
  // NONCE + GAS
  // ============================================================

  nonce = await provider.getTransactionCount(signer.address, 'pending');
  console.log('Starting nonce:', nonce);

  const feeData = await provider.getFeeData();

  const gasLimit = 20_000_000; // 👈 IMPORTANT (Aave was failing at 5M)

  const txOpts = () => ({
    nonce,
    gasLimit,
    maxFeePerGas: feeData.maxFeePerGas,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
  });

  // ============================================================
  // DEPLOYMENTS
  // ============================================================

  // 1) UniswapV3AssetGuard
  const UniFactory = await ethers.getContractFactory('UniswapV3AssetGuard', signer);

  await deployWithRetry(UniFactory, [], txOpts(), 'UniswapV3AssetGuard');

  await wait(2000);

  // 2) AaveV3LendingPoolAssetGuard
  const AaveFactory = await ethers.getContractFactory('AaveV3LendingPoolAssetGuard', signer);

  await deployWithRetry(
    AaveFactory,
    [AAVE_PROTOCOL_DATA_PROVIDER, AAVE_LENDING_POOL, PREFERRED_SETTLEMENT_ASSET, SWAP_ROUTER],
    txOpts(),
    'AaveV3LendingPoolAssetGuard',
  );

  await wait(2000);

  // 3) MorphoCollectLib (library deployment)
  const CollectLibFactory = await ethers.getContractFactory('MorphoCollectLib', signer);

  const collectLibAddress = await deployWithRetry(
    CollectLibFactory,
    [],
    txOpts(),
    'MorphoCollectLib',
  );

  console.log('MorphoCollectLib deployed at:', collectLibAddress);

  await wait(2000);

  // 4) MorphoBlueLendingPoolAssetGuard (linked with MorphoCollectLib)
  const MorphoFactory = await ethers.getContractFactory('MorphoBlueLendingPoolAssetGuard', {
    signer,
    libraries: {
      MorphoCollectLib: collectLibAddress,
    },
  });

  await deployWithRetry(
    MorphoFactory,
    [MORPHO, MORPHO_MANAGER, SWAP_ROUTER, PREFERRED_SETTLEMENT_ASSET],
    txOpts(),
    'MorphoBlueAssetGuard',
  );

  console.log('\n  ALL ASSET GUARDS DEPLOYED');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
