import { ethers } from 'hardhat';

async function main() {
  // --------------------------------------------------
  // Governance proxy
  // --------------------------------------------------
  const GOVERNANCE_PROXY = '0xC393A896D15641cA970F682BE62e89347941985d';

  // --------------------------------------------------
  // Signer (owner)
  // --------------------------------------------------
  const [signer] = await ethers.getSigners();
  let nonce = await signer.getNonce();

  console.log('Signer (owner):', signer.address);
  console.log('Starting nonce:', nonce);

  // --------------------------------------------------
  // Connect to Governance contract
  // --------------------------------------------------
  const governance = await ethers.getContractAt('Governance', GOVERNANCE_PROXY, signer);

  // --------------------------------------------------
  // Gas overrides
  // --------------------------------------------------
  const feeData = await ethers.provider.getFeeData();
  const overrides = {
    maxFeePerGas: feeData.maxFeePerGas!,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
  };

  // --------------------------------------------------
  // External contracts (assets) and their contract guards
  // --------------------------------------------------
  const contractGuards = [
    {
      name: 'MorphoBlue',
      extContract: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
      guard: '0x7A4701fAB443687F9EADCa68Ef0B207729a5acEa',
    },
    {
      name: 'UniswapV3',
      extContract: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
      guard: '0xA313f1AADFB45033498a20e2e2cfefD31D10c973',
    },
    {
      name: 'UniswapRouter',
      extContract: '0x2626664c2603336E57B271c5C0b26F421741e481',
      guard: '0xcAE75F063Ef5b432F4ad3140960c888a0795d5DC',
    },
    {
      name: 'AaveV3',
      extContract: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
      guard: '0x7Ef5442f796bF1Ae3e00E91a5527cAa5F7aba5A4',
    },
  ];

  // --------------------------------------------------
  // Loop and set ContractGuards
  // --------------------------------------------------
  for (const cg of contractGuards) {
    console.log(`\n Setting ContractGuard for ${cg.name}...`);

    const tx = await governance.setContractGuard(cg.extContract, cg.guard, {
      ...overrides,
      nonce: nonce++,
    });
    await tx.wait();

    console.log(` ContractGuard set for ${cg.name}`);
    console.log(`   External Contract: ${cg.extContract}`);
    console.log(`   Guard Address    : ${cg.guard}`);
  }

  console.log('\n All ContractGuards set successfully');
}

main().catch((error) => {
  console.error(' Script failed:', error);
  process.exitCode = 1;
});
