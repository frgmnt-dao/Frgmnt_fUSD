import { ethers } from 'hardhat';

// ============================================================
// HELPERS
// ============================================================

async function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deployWithRetry(factory: any, args: any[], label: string, retries = 5) {
  const signer = (await ethers.getSigners())[0];

  for (let i = 0; i < retries; i++) {
    try {
      console.log(`Deploying ${label}...`);
      const contract = await factory.connect(signer).deploy(...args);
      await contract.waitForDeployment();

      const address = await contract.getAddress();
      console.log(`${label} deployed at:`, address);
      return address;
    } catch (e: any) {
      console.warn(`${label} failed (attempt ${i + 1}):`, e.message || e);
      await wait(1500);
    }
  }

  throw new Error(`${label} failed after ${retries} retries`);
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const provider = ethers.provider;
  const signer = (await ethers.getSigners())[0];

  console.log('Deployer :', await signer.getAddress());
  const chain = await provider.getNetwork();
  console.log('ChainId  :', chain.chainId);

  const USDFactory = await ethers.getContractFactory('USDPriceAggregator', signer);

  const usdAggregatorAddress = await deployWithRetry(USDFactory, [], 'USDPriceAggregator');

  console.log('\n  USDPriceAggregator deployed at:', usdAggregatorAddress);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
