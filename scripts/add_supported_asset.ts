import { ethers } from 'hardhat';

const POOL_MANAGER_LOGIC_PROXY = '0x9530E699E519D7BCF621BA7CA17e119B6865b5C7';

// Asset addresses
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const MorphoBlue = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const AaveV3 = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';
const UniswapV3 = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';

async function main() {
  const [caller] = await ethers.getSigners();

  console.log('Caller:', caller.address);
  console.log('PoolManagerLogic:', POOL_MANAGER_LOGIC_PROXY);
  console.log('---------------------------------------');

  const poolManagerLogic = await ethers.getContractAt('PoolManagerLogic', POOL_MANAGER_LOGIC_PROXY);

  const assetsToAdd = [USDC, MorphoBlue, AaveV3, UniswapV3];

  for (const asset of assetsToAdd) {
    console.log(`\nChecking asset: ${asset}`);

    // 1️ Validate asset
    const isValid = await poolManagerLogic.validateAsset(asset);
    console.log('Is valid:', isValid);

    if (!isValid) {
      console.log('Asset is not valid (missing oracle in AssetHandler), skipping');
      continue;
    }

    // 2️ Check if already supported
    const isSupported = await poolManagerLogic.isSupportedAsset(asset);
    console.log('Already supported:', isSupported);

    if (isSupported) {
      console.log(` ${asset} already supported, skipping`);
      continue;
    }

    // 3️ Prepare payload
    const addAssets = [
      {
        asset,
        isDeposit: asset === USDC, // deposit disabled
      },
    ];

    const tx = await poolManagerLogic.changeAssets(addAssets, []);
    console.log('Transaction hash:', tx.hash);

    await tx.wait();
    console.log(` ${asset} added successfully with deposit = false`);
  }

  console.log('\n All assets processed');
}

main().catch((error) => {
  console.error(' Script failed:', error);
  process.exitCode = 1;
});
