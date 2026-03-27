import { ethers } from 'hardhat';

async function main() {
  // --------------------------------------------------
  // Governance proxy
  // --------------------------------------------------
  const GOVERNANCE_PROXY = '0x9e7051B91D9423A63e15B46EC776540d2f8fc364';

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
      guard: '0xa828eD0f49B8034eFEd2C7900080bD62a349bea9',
    },
    {
      name: 'UniswapV3',
      extContract: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
      guard: '0xb7663Da98E056dc378e39b91a3BbC76e4b372207',
    },
    {
      name: 'UniswapRouter',
      extContract: '0x2626664c2603336E57B271c5C0b26F421741e481',
      guard: '0x3d37894A3484C8327093035446C7F20949900277',
    },
    {
      name: 'AaveV3',
      extContract: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
      guard: '0x13dEd9e23077D572A2B54eFd7492aC5366CE3FCc',
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
