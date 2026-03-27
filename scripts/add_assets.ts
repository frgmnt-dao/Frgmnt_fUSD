import { ethers } from 'hardhat';

async function main() {
  const ASSET_HANDLER_PROXY = '0x387174F4B3676c7F6e06da9c6c855375B5b10AAB';

  const ONE_DAY = 24 * 60 * 60;

  const [signer] = await ethers.getSigners();
  let nonce = await signer.getNonce();

  console.log('Signer:', signer.address);
  console.log('Starting nonce:', nonce);

  const assetHandler = await ethers.getContractAt('AssetHandler', ASSET_HANDLER_PROXY, signer);

  const feeData = await ethers.provider.getFeeData();
  const overrides = {
    maxFeePerGas: feeData.maxFeePerGas!,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
  };

  // --------------------------------------------------
  //  All assets share the same feed
  // --------------------------------------------------
  const SHARED_FEED = ethers.getAddress('0x5bb4eA3b0187bb503c81Bd91Ebc2A1021497e538');

  const assets = [
    {
      symbol: 'MorphoBlue',
      address: ethers.getAddress('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb'),
      feed: SHARED_FEED,
      type: 1,
    },
    {
      symbol: 'AaveV3',
      address: ethers.getAddress('0xA238Dd80C259a72e81d7e4664a9801593F98d1c5'),
      feed: SHARED_FEED,
      type: 2,
    },
    {
      symbol: 'UniswapV3',
      address: ethers.getAddress('0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1'),
      feed: SHARED_FEED,
      type: 3,
    },
    {
      symbol: 'USDC',
      address: ethers.getAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
      feed: '0x7e860098F58bBFC8648a4311b374B1D669a2bc6B',
      type: 4,
    },
  ];

  // --------------------------------------------------
  // LOOP: addAsset + setChainlinkTimeout
  // --------------------------------------------------
  for (const asset of assets) {
    console.log(`\n Adding ${asset.symbol} (type ${asset.type})...`);

    const tx1 = await assetHandler.addAsset(asset.address, asset.type, asset.feed, {
      ...overrides,
      nonce: nonce++,
    });
    await tx1.wait();
    console.log(` ${asset.symbol} added`);

    const tx2 = await assetHandler.setChainlinkTimeout(asset.address, ONE_DAY, {
      ...overrides,
      nonce: nonce++,
    });
    await tx2.wait();
    console.log(` Timeout set for ${asset.symbol}`);
  }

  console.log('\n All assets added successfully');
}

main().catch((error) => {
  console.error(' Script failed:', error);
  process.exitCode = 1;
});
