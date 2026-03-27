import { ethers } from 'hardhat';

async function main() {
  // --------------------------------------------------
  // Governance proxy
  // --------------------------------------------------
  const GOVERNANCE_PROXY = '0xC393A896D15641cA970F682BE62e89347941985d';

  // --------------------------------------------------
  // Signer (factoryOwner)
  // --------------------------------------------------
  const [signer] = await ethers.getSigners();
  let nonce = await signer.getNonce();

  console.log('Signer (factoryOwner):', signer.address);
  console.log('Starting nonce:', nonce);

  // --------------------------------------------------
  // Connect to Governance contract
  // --------------------------------------------------
  const governance = await ethers.getContractAt('Governance', GOVERNANCE_PROXY, signer);

  // --------------------------------------------------
  // Gas overrides (Base-safe)
  // --------------------------------------------------
  const feeData = await ethers.provider.getFeeData();
  const overrides = {
    maxFeePerGas: feeData.maxFeePerGas!,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
  };

  // --------------------------------------------------
  // Asset types and their guards
  // --------------------------------------------------
  const assetGuards = [
    { assetType: 1, guard: '0x91D4a12CaE569b33194C62aCfe8E037fC62f95e1' }, // MorphoBlue
    { assetType: 2, guard: '0xE5bc2963f3fdE832d798caC2024343C83aDD2A38' }, // aUSDC (AaveV3)
    { assetType: 3, guard: '0xB186BA1634d4F99798ed663319aF6ac328086DF1' }, // UniswapV3
    { assetType: 4, guard: '0x26E11DC5C05ee07Cb14A2Fd475C71aAEd2F0A98C' }, // USDC
  ];

  // --------------------------------------------------
  // Loop over asset types and set guards
  // --------------------------------------------------
  for (const ag of assetGuards) {
    console.log(`\n Setting assetGuard for assetType ${ag.assetType}...`);

    const tx = await governance.setAssetGuard(ag.assetType, ag.guard, {
      ...overrides,
      nonce: nonce++,
    });
    await tx.wait();

    console.log(` AssetGuard set for assetType ${ag.assetType}`);
    console.log(`   Guard: ${ag.guard}`);
  }

  console.log('\n All assetGuards set successfully');
}

main().catch((error) => {
  console.error(' Script failed:', error);
  process.exitCode = 1;
});
