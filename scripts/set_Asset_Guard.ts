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
    { assetType: 1, guard: '0x27BeceFb6CF59b26CD73dac227Ae3597065E2850' }, // MorphoBlue

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
